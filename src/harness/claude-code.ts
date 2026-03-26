/**
 * Claude Code harness — wraps @anthropic-ai/claude-agent-sdk and emits the
 * plugin's structured backend/run event model.
 */

import * as claudeAgentSdk from "@anthropic-ai/claude-agent-sdk";
import { dirname, join } from "path";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  PendingInputState,
  PlanArtifact,
} from "../types";
import type {
  AgentHarness,
  HarnessLaunchOptions,
  HarnessSession,
} from "./types";
import {
  createBackendRefEvent,
  createPendingInputEvent,
  createPendingInputResolvedEvent,
  createPlanArtifactEvent,
  createRunCompletedEvent,
  createRunStartedEvent,
  createSettingsChangedEvent,
  createTextDeltaEvent,
  createToolCallEvent,
  HarnessMessageQueue,
} from "./harness-events";

type ClaudeQueryHandle = AsyncIterable<unknown> & {
  setPermissionMode?: (mode: string) => Promise<void>;
  streamInput?: (input: AsyncIterable<SDKUserMessage>) => Promise<void>;
  interrupt?: () => Promise<void>;
};

type ClaudeWarmQueryHandle = {
  query: (prompt: string | AsyncIterable<SDKUserMessage>) => ClaudeQueryHandle;
  close?: () => void | Promise<void>;
};

type ClaudeStartup = (args?: { options?: Record<string, unknown> }) => Promise<ClaudeWarmQueryHandle>;

interface ClaudeCodeHarnessDeps {
  query?: typeof claudeAgentSdk.query;
  startup?: ClaudeStartup;
}

interface ClaudeAssistantTextBlock {
  type: "text";
  text: string;
}

interface ClaudeAssistantToolUseBlock {
  type: "tool_use";
  name: string;
  input: unknown;
}

interface ClaudeMessageEnvelope {
  type?: string;
  subtype?: string;
  session_id?: string;
  permissionMode?: string;
  message?: { content?: Array<ClaudeAssistantTextBlock | ClaudeAssistantToolUseBlock> };
  duration_ms?: number;
  total_cost_usd?: number;
  num_turns?: number;
  result?: string;
  errors?: string[];
}

function resolveResultText(msg: ClaudeMessageEnvelope): string | undefined {
  if (typeof msg.result === "string" && msg.result.length > 0) {
    return msg.result;
  }
  if (Array.isArray(msg.errors)) {
    const errors = msg.errors.filter((value): value is string => typeof value === "string" && value.length > 0);
    if (errors.length > 0) {
      return errors.join("\n");
    }
  }
  return undefined;
}

function buildPendingInputState(
  sessionId: string,
  requestId: number,
  input: Record<string, unknown>,
): PendingInputState {
  const questions = Array.isArray((input as { questions?: unknown[] }).questions)
    ? (input as { questions: Array<Record<string, unknown>> }).questions
    : [];
  const first = questions[0] ?? {};
  const promptText = typeof first.question === "string" ? first.question : undefined;
  const options = Array.isArray(first.options)
    ? first.options
        .map((option) => {
          if (!option || typeof option !== "object") return "";
          const label = (option as { label?: unknown }).label;
          return typeof label === "string" ? label : "";
        })
        .filter(Boolean)
    : [];

  return {
    requestId: `${sessionId || "claude"}-ask-${requestId}`,
    kind: "question",
    promptText,
    options,
    allowsFreeText: options.length === 0 || first.multiSelect === true,
  };
}

/** Refresh window: refresh token if it expires within 30 minutes. */
const TOKEN_REFRESH_WINDOW_MS = 30 * 60 * 1000; // 1_800_000

/** Timeout for the token refresh HTTP request. */
const TOKEN_REFRESH_TIMEOUT_MS = 15_000;

/**
 * Refresh the OAuth token using an in-process HTTPS POST via native fetch().
 * Returns the new access token string, or throws on failure.
 *
 * Secrets never appear in process argv — they are sent in the request body
 * via fetch(), which keeps them in-process memory only.
 */
async function refreshOAuthToken(oauth: {
  accessToken: string;
  refreshToken: string;
  expiresAt?: number;
}): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOKEN_REFRESH_TIMEOUT_MS);

  try {
    const response = await fetch("https://platform.claude.com/v1/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: oauth.refreshToken,
        client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "<unreadable>");
      throw new Error(
        `OAuth refresh failed: HTTP ${response.status} — ${text.slice(0, 200)}`,
      );
    }

    const data = (await response.json()) as Record<string, unknown>;
    if (!data.access_token || typeof data.access_token !== "string") {
      throw new Error(
        `OAuth refresh returned unexpected payload: ${JSON.stringify(data).slice(0, 200)}`,
      );
    }

    return {
      accessToken: data.access_token,
      refreshToken:
        typeof data.refresh_token === "string" ? data.refresh_token : undefined,
      expiresIn:
        typeof data.expires_in === "number" ? data.expires_in : undefined,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the OAuth credentials, refresh if near expiry, and return the
 * access token to use. This is fully async — no main-thread blocking.
 *
 * On refresh success the credentials file is updated. On refresh failure
 * an error is thrown (fail-fast) rather than silently using a stale token.
 */
async function resolveOAuthToken(): Promise<string | undefined> {
  const credsPath = join(homedir(), ".claude", ".credentials.json");
  if (!existsSync(credsPath)) return undefined;

  let creds: Record<string, unknown>;
  try {
    creds = JSON.parse(readFileSync(credsPath, "utf-8"));
  } catch {
    return undefined; // unreadable credentials file
  }

  const oauth = creds?.claudeAiOauth as
    | { accessToken?: string; refreshToken?: string; expiresAt?: number }
    | undefined;

  if (!oauth?.accessToken) return undefined;

  const now = Date.now();
  const expiresAt = oauth.expiresAt || 0;
  const needsRefresh =
    expiresAt > 0 &&
    expiresAt < now + TOKEN_REFRESH_WINDOW_MS &&
    oauth.refreshToken;

  if (needsRefresh) {
    console.log(
      "[ClaudeCodeHarness] Token expires in",
      Math.round((expiresAt - now) / 60000),
      "min — refreshing asynchronously...",
    );
    // This throws on failure — caller must handle
    const result = await refreshOAuthToken(
      oauth as { accessToken: string; refreshToken: string; expiresAt?: number },
    );
    oauth.accessToken = result.accessToken;
    if (result.refreshToken) oauth.refreshToken = result.refreshToken;
    if (result.expiresIn != null) oauth.expiresAt = now + result.expiresIn * 1000;
    creds.claudeAiOauth = oauth;
    writeFileSync(credsPath, JSON.stringify(creds, null, 2));
    console.log(
      "[ClaudeCodeHarness] OAuth token refreshed, expires in",
      result.expiresIn ?? "?",
      "seconds",
    );
  }

  return oauth.accessToken;
}

export class ClaudeCodeHarness implements AgentHarness {
  constructor(private readonly deps: ClaudeCodeHarnessDeps = {}) {}

  readonly name = "claude-code";
  readonly backendKind = "claude-code" as const;
  readonly supportedPermissionModes = [
    "default",
    "plan",
    "bypassPermissions",
  ] as const;
  readonly capabilities = {
    nativePendingInput: false,
    nativePlanArtifacts: false,
    worktrees: "plugin-managed",
  } as const;

  /** Launch a Claude Code session and adapt SDK messages into structured events. */
  launch(options: HarnessLaunchOptions): HarnessSession {
    const queue = new HarnessMessageQueue();
    let sawRunOutput = false;
    let currentTurnText = "";
    let sawPlanGateSignal = false;
    let requestCounter = 0;
    let currentSessionId = options.resumeSessionId ?? "";

    const canUseToolCallback = options.canUseTool;
    const sdkOptions: Record<string, unknown> = {
      cwd: options.cwd,
      model: options.model,
      permissionMode: options.permissionMode,
      allowDangerouslySkipPermissions: true,
      pathToClaudeCodeExecutable: (() => {
        try {
          const req = createRequire(import.meta.url);
          const sdkMain = req.resolve("@anthropic-ai/claude-agent-sdk");
          return join(dirname(sdkMain), "cli.js");
        } catch {
          const thisDir = dirname(fileURLToPath(import.meta.url));
          return join(thisDir, "..", "node_modules", "@anthropic-ai", "claude-agent-sdk", "cli.js");
        }
      })(),
      allowedTools: options.allowedTools,
      systemPrompt: options.systemPrompt,
      includePartialMessages: true,
      abortController: options.abortController,
      mcpServers: options.mcpServers,
      ...(canUseToolCallback
        ? {
            canUseTool: async (toolName: string, input: Record<string, unknown>) => {
              if (toolName !== "AskUserQuestion") {
                return { behavior: "allow" as const };
              }
              const state = buildPendingInputState(currentSessionId, ++requestCounter, input);
              queue.enqueue(createPendingInputEvent(state));
              try {
                const result = await canUseToolCallback(toolName, input);
                queue.enqueue(createPendingInputResolvedEvent(state.requestId));
                return result;
              } catch (error) {
                queue.enqueue(createPendingInputResolvedEvent(state.requestId));
                throw error;
              }
            },
          }
        : {}),
    };

    if (options.resumeSessionId) {
      sdkOptions.resume = options.resumeSessionId;
      sdkOptions.forkSession = options.forkSession ?? false;
    }

    // Resolve OAuth token asynchronously before launching SDK
    const tokenPromise = resolveOAuthToken();

    const prompt = options.prompt as string | AsyncIterable<SDKUserMessage>;
    const queryFn = this.deps.query ?? claudeAgentSdk.query;
    const startupFn = this.deps.startup
      ?? (claudeAgentSdk as typeof claudeAgentSdk & { startup?: ClaudeStartup }).startup;
    const qPromise = (async (): Promise<ClaudeQueryHandle> => {
      // Await OAuth token refresh before launching SDK
      const token = await tokenPromise;
      const previousToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
      if (token) {
        process.env.CLAUDE_CODE_OAUTH_TOKEN = token;
      }

      try {
        if (typeof startupFn !== "function") {
          return queryFn({ prompt, options: sdkOptions }) as ClaudeQueryHandle;
        }

        const warmQuery = await startupFn({ options: sdkOptions });
        try {
          return warmQuery.query(prompt) as ClaudeQueryHandle;
        } catch (error) {
          await warmQuery.close?.();
          throw error;
        }
      } finally {
        // Restore previous env state
        if (previousToken !== undefined) {
          process.env.CLAUDE_CODE_OAUTH_TOKEN = previousToken;
        } else if (token) {
          delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
        }
      }
    })();

    void (async () => {
      try {
        const q = await qPromise;
        for await (const raw of q) {
          const msg = raw as ClaudeMessageEnvelope;
          if (msg.type === "system" && msg.subtype === "init") {
            currentSessionId = msg.session_id ?? currentSessionId;
            queue.enqueue(createBackendRefEvent({
              kind: "claude-code",
              conversationId: currentSessionId,
            }));
            continue;
          }

          if (msg.type === "system" && msg.subtype === "status" && msg.permissionMode) {
            queue.enqueue(createSettingsChangedEvent(msg.permissionMode));
            continue;
          }

          if (msg.type === "assistant") {
            if (!sawRunOutput) {
              sawRunOutput = true;
              queue.enqueue(createRunStartedEvent());
            }
            for (const block of msg.message?.content ?? []) {
              if (block.type === "text") {
                currentTurnText += currentTurnText ? `\n${block.text}` : block.text;
                queue.enqueue(createTextDeltaEvent(block.text));
                continue;
              }

              if (block.type === "tool_use") {
                if (block.name === "ExitPlanMode" || block.name === "set_permission_mode") {
                  sawPlanGateSignal = true;
                }
                if (block.name !== "AskUserQuestion") {
                  queue.enqueue(createToolCallEvent(block.name, block.input));
                }
              }
            }
            continue;
          }

          if (msg.type === "result") {
            const finalizedPlanText = currentTurnText.trim();
            if (
              finalizedPlanText &&
              (options.permissionMode === "plan" || sawPlanGateSignal)
            ) {
              const artifact: PlanArtifact = {
                explanation: undefined,
                steps: [],
                markdown: finalizedPlanText,
              };
              queue.enqueue(createPlanArtifactEvent(artifact, true));
            }

            queue.enqueue(createRunCompletedEvent({
              success: msg.subtype === "success",
              duration_ms: msg.duration_ms ?? 0,
              total_cost_usd: msg.total_cost_usd ?? 0,
              num_turns: msg.num_turns ?? 0,
              result: resolveResultText(msg),
              session_id: msg.session_id ?? currentSessionId,
            }));
            currentTurnText = "";
            sawPlanGateSignal = false;
            sawRunOutput = false;
          }
        }
      } finally {
        queue.close();
      }
    })().catch((error: unknown) => {
      queue.enqueue(createRunCompletedEvent({
        success: false,
        duration_ms: 0,
        total_cost_usd: 0,
        num_turns: 0,
        result: error instanceof Error ? error.message : String(error),
        session_id: currentSessionId,
      }));
      queue.close();
    });

    return {
      messages: queue.messages(),

      async setPermissionMode(mode: string): Promise<void> {
        const q = await qPromise;
        if (typeof q.setPermissionMode === "function") {
          await q.setPermissionMode(mode);
        }
      },

      async streamInput(input: AsyncIterable<unknown>): Promise<void> {
        const q = await qPromise;
        if (typeof q.streamInput === "function") {
          await q.streamInput(input as AsyncIterable<SDKUserMessage>);
        }
      },

      async interrupt(): Promise<void> {
        const q = await qPromise;
        if (typeof q.interrupt === "function") {
          await q.interrupt();
        }
      },
    };
  }

  /** Build the multi-turn user-message payload expected by Claude Code SDK. */
  buildUserMessage(text: string, sessionId: string): SDKUserMessage {
    return {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: sessionId,
    };
  }
}

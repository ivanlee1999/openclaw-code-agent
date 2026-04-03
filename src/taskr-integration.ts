/**
 * Taskr integration — creates and updates tasks on https://taskr.one
 * so pipeline progress is visible in real-time.
 *
 * All methods are fire-and-forget safe: if Taskr is unreachable the
 * pipeline continues unaffected.
 *
 * @module taskr-integration
 */

import { pluginConfig } from "./config";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function getTaskrApiUrl(): string {
  return (
    process.env.TASKR_API_URL ||
    (pluginConfig as any)?.taskr?.apiUrl ||
    "https://taskr.one/api/mcp"
  );
}

function getTaskrProjectId(): string {
  if (process.env.TASKR_PROJECT_ID !== undefined) return process.env.TASKR_PROJECT_ID;
  return (
    (pluginConfig as any)?.taskr?.projectId ||
    "PR_00000000MMOEGLMJIM4Q0STGNB"
  );
}

function getTaskrApiKey(): string {
  // Explicitly set to empty string → disabled
  if (process.env.TASKR_API_KEY !== undefined) return process.env.TASKR_API_KEY;
  return (
    (pluginConfig as any)?.taskr?.apiKey ||
    "209c76b393d6fea32b3a0c87496d5eeee8c15159c57fc84cb38582a4adf4a177"
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TaskrTaskIds {
  listId?: string;
  plan?: string;
  implement?: string;
  review?: string;
  /** Keyed by fix-round number, e.g. { 1: "TASK-xxx", 2: "TASK-yyy" } */
  fixes: Record<number, string>;
}

interface JsonRpcResponse {
  jsonrpc: string;
  id: number;
  result?: { content?: Array<{ type: string; text?: string }> };
  error?: { code: number; message: string };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 10_000;

function taskrLog(msg: string): void {
  console.log(`[Taskr] ${msg}`);
}

/**
 * Low-level JSON-RPC call to the Taskr MCP endpoint.
 * Returns the parsed response or undefined on network / timeout errors.
 */
async function rpcCall(
  toolName: string,
  args: Record<string, unknown>,
): Promise<JsonRpcResponse | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(getTaskrApiUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-project-id": getTaskrProjectId(),
        "x-user-api-key": getTaskrApiKey(),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: toolName, arguments: args },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "<unreadable>");
      taskrLog(`HTTP ${res.status} from Taskr: ${text.slice(0, 200)}`);
      return undefined;
    }

    return (await res.json()) as JsonRpcResponse;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    taskrLog(`Request failed: ${msg}`);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract the first text content from a JSON-RPC result, which typically
 * contains the created resource's ID or a confirmation message.
 */
function extractText(resp: JsonRpcResponse | undefined): string | undefined {
  if (!resp?.result?.content) return undefined;
  const first = resp.result.content.find((c) => c.type === "text" && c.text);
  return first?.text;
}

/**
 * Try to extract a task ID from the response text.
 * Taskr returns IDs like "TSK_..." — we look for that pattern.
 */
function extractId(text: string | undefined): string | undefined {
  if (!text) return undefined;
  // Try to parse as JSON first (Taskr may return JSON with an id field)
  try {
    const parsed = JSON.parse(text);
    if (parsed?.id) return String(parsed.id);
    if (parsed?.taskListId) return String(parsed.taskListId);
    // If it's an array of tasks, return nothing here (caller handles)
    if (Array.isArray(parsed?.tasks)) return undefined;
  } catch {
    // Not JSON — try regex
  }
  const match = text.match(/(TSK_[A-Za-z0-9]+)/);
  return match?.[1];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class TaskrClient {
  /** Check at call time so env changes are respected. */
  private get enabled(): boolean {
    return Boolean(getTaskrApiKey());
  }

  /**
   * Create a Taskr task list representing a pipeline run.
   * Returns task IDs for each stage so callers can update them later.
   */
  async createPipelineTaskList(
    pipelineName: string,
    prompt: string,
  ): Promise<TaskrTaskIds> {
    const ids: TaskrTaskIds = { fixes: {} };
    if (!this.enabled) return ids;

    try {
      const tasks = [
        { hierarchy: "1", title: "Plan (Codex)", type: "TASK", description: "Analyze problem and create implementation plan" },
        { hierarchy: "2", title: "Implement (Claude Code)", type: "TASK", description: "Implement the plan" },
        { hierarchy: "3", title: "Review (Codex)", type: "TASK", description: "Review implementation for bugs, security, quality" },
      ];

      const resp = await rpcCall("create_task", {
        taskListTitle: `Pipeline: ${pipelineName}`,
        tasks,
        ruleContext: "RU-CTX-001",
      });

      const text = extractText(resp);
      taskrLog(`create_task response: ${text?.slice(0, 300)}`);

      // Try to extract individual task IDs from the response
      if (text) {
        try {
          const parsed = JSON.parse(text);
          if (parsed?.taskListId) ids.listId = String(parsed.taskListId);
          if (Array.isArray(parsed?.tasks)) {
            const taskArr = parsed.tasks as Array<{ id?: string; title?: string }>;
            for (const t of taskArr) {
              if (!t.id) continue;
              const tid = String(t.id);
              if (t.title?.includes("Plan")) ids.plan = tid;
              else if (t.title?.includes("Implement")) ids.implement = tid;
              else if (t.title?.includes("Review")) ids.review = tid;
            }
          }
        } catch {
          // Single ID fallback
          ids.listId = extractId(text);
        }
      }

      taskrLog(`Task list created: ${JSON.stringify(ids)}`);
    } catch (err) {
      taskrLog(`Failed to create task list: ${err instanceof Error ? err.message : String(err)}`);
    }

    return ids;
  }

  /**
   * Update a stage's status (wip, done, skipped).
   */
  async updateStageStatus(
    taskId: string,
    status: "wip" | "done" | "skipped",
  ): Promise<void> {
    if (!this.enabled || !taskId) return;

    try {
      await rpcCall("update_task", {
        taskId,
        status,
        ruleContext: "RU-PROC-001",
      });
      taskrLog(`Task ${taskId} → ${status}`);
    } catch (err) {
      taskrLog(`Failed to update task ${taskId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Add a progress note or finding to a task.
   */
  async addStageNote(
    taskId: string,
    title: string,
    body: string,
  ): Promise<void> {
    if (!this.enabled || !taskId) return;

    try {
      await rpcCall("create_note", {
        type: "PROGRESS",
        title,
        body,
        taskId,
        ruleContext: "RU-NOTE-001",
      });
      taskrLog(`Note added to ${taskId}: ${title}`);
    } catch (err) {
      taskrLog(`Failed to add note to ${taskId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

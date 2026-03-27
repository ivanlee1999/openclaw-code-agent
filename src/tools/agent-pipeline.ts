import { Type } from "@sinclair/typebox";
import { pipelineManager } from "../singletons";
import type { OpenClawPluginToolContext } from "../types";

interface AgentPipelineParams {
  prompt: string;
  workdir: string;
  name?: string;
  worktree?: boolean;
  max_iterations?: number;
}

function isAgentPipelineParams(value: unknown): value is AgentPipelineParams {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  return typeof p.prompt === "string" && typeof p.workdir === "string";
}

/** Register the `agent_pipeline` tool: Codex plan → Claude implement → Codex review */
export function makeAgentPipelineTool(ctx: OpenClawPluginToolContext) {
  return {
    name: "agent_pipeline",
    description:
      "Run the 3-stage coding pipeline: Codex plans → Claude Code implements → Codex reviews. " +
      "Use for any coding task. Returns a pipeline run ID. " +
      "Monitor progress with agent_sessions. " +
      "When Codex review finds critical issues, Claude auto-fixes (up to maxIterations). " +
      "If max iterations hit, pipeline blocks and notifies for human direction.",
    parameters: Type.Object({
      prompt: Type.String({
        description:
          "Task description passed to the pipeline. Include relevant context, file paths, and requirements.",
      }),
      workdir: Type.String({
        description: "Absolute path to the repository to work in.",
      }),
      name: Type.Optional(
        Type.String({ description: "Short kebab-case name for the pipeline run (e.g. 'fix-preview-card-type')." }),
      ),
      worktree: Type.Optional(
        Type.Boolean({
          description:
            "Whether to create a git worktree for the pipeline. Defaults to auto-detect (creates worktree if git repo with remote).",
        }),
      ),
      max_iterations: Type.Optional(
        Type.Number({
          description: "Maximum fix iterations if Codex finds critical issues (default: 4).",
          minimum: 1,
          maximum: 10,
        }),
      ),
    }),
    async execute(_id: string, params: unknown) {
      if (!pipelineManager) {
        return {
          content: [
            {
              type: "text",
              text: "Error: PipelineManager not initialized. The code-agent service must be running.",
            },
          ],
        };
      }

      if (!isAgentPipelineParams(params)) {
        return {
          content: [
            {
              type: "text",
              text: "Error: Invalid parameters. Expected { prompt, workdir, name?, worktree?, max_iterations? }.",
            },
          ],
        };
      }

      try {
        const run = pipelineManager.launch({
          prompt: params.prompt,
          workdir: params.workdir,
          name: params.name,
          worktree: params.worktree,
          maxIterations: params.max_iterations,
          originChannel: ctx.channel || undefined,
          originThreadId: ctx.threadId || undefined,
          originAgentId: ctx.agentId || undefined,
          originSessionKey: ctx.sessionKey || undefined,
        });

        return {
          content: [
            {
              type: "text",
              text: [
                `🚀 Pipeline started: **${run.name}** (ID: ${run.id})`,
                ``,
                `Workdir: ${params.workdir}`,
                `Max iterations: ${run.maxIterations}`,
                ``,
                `Stage 1/3: Codex is planning...`,
                ``,
                `Use agent_sessions() to monitor progress.`,
                `Status updates will be posted here as stages complete.`,
              ].join("\n"),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error starting pipeline: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  };
}

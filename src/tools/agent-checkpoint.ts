/**
 * Tool for managing pipeline checkpoints.
 *
 * Provides list, restore, and create operations for git-based checkpoints
 * created during pipeline execution.
 *
 * @module tools/agent-checkpoint
 */

import { Type } from "@sinclair/typebox";
import { CheckpointManager } from "../checkpoints";
import { pipelineManager } from "../singletons";
import type { OpenClawPluginToolContext } from "../types";

interface AgentCheckpointParams {
  action: "list" | "restore" | "create";
  pipeline_id?: string;
  workdir?: string;
  tag?: string;
  label?: string;
}

function isAgentCheckpointParams(value: unknown): value is AgentCheckpointParams {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.action === "string" &&
    (p.action === "list" || p.action === "restore" || p.action === "create")
  );
}

/** Register the `agent_checkpoint` tool for managing pipeline checkpoints. */
export function makeAgentCheckpointTool(_ctx: OpenClawPluginToolContext) {
  const checkpointMgr = new CheckpointManager();

  return {
    name: "agent_checkpoint",
    description:
      "Manage pipeline checkpoints (git-based save points). " +
      "Use 'list' to see available checkpoints, 'restore' to roll back to one, " +
      "or 'create' to manually save the current state.",
    parameters: Type.Object({
      action: Type.Union(
        [Type.Literal("list"), Type.Literal("restore"), Type.Literal("create")],
        { description: "Action to perform: list, restore, or create a checkpoint." },
      ),
      pipeline_id: Type.Optional(
        Type.String({
          description: "Pipeline run ID. Required for 'list' and 'create'. Used to resolve workdir.",
        }),
      ),
      workdir: Type.Optional(
        Type.String({
          description:
            "Git repo path. If not provided, resolved from pipeline_id. Required if pipeline_id is not given.",
        }),
      ),
      tag: Type.Optional(
        Type.String({
          description: "Checkpoint tag name. Required for 'restore'.",
        }),
      ),
      label: Type.Optional(
        Type.String({
          description: "Label for the checkpoint (used with 'create').",
        }),
      ),
    }),
    async execute(_id: string, params: unknown) {
      if (!isAgentCheckpointParams(params)) {
        return {
          content: [
            {
              type: "text",
              text: "Error: Invalid parameters. Expected { action: 'list'|'restore'|'create', pipeline_id?, workdir?, tag?, label? }.",
            },
          ],
        };
      }

      // Resolve workdir from pipeline_id if needed
      let workdir = params.workdir;
      let sessionId = params.pipeline_id;

      if (!workdir && sessionId && pipelineManager) {
        const run = pipelineManager.get(sessionId);
        if (run) {
          workdir = run.workdir;
        }
      }

      if (!workdir) {
        return {
          content: [
            {
              type: "text",
              text: "Error: Could not determine workdir. Provide workdir or a valid pipeline_id.",
            },
          ],
        };
      }

      if (!sessionId) {
        sessionId = "manual";
      }

      switch (params.action) {
        case "list": {
          const checkpoints = checkpointMgr.listCheckpoints(workdir, sessionId);
          if (checkpoints.length === 0) {
            return {
              content: [{ type: "text", text: `No checkpoints found for session ${sessionId}.` }],
            };
          }

          const lines = checkpoints.map((cp, i) => {
            const date = new Date(cp.timestamp).toISOString();
            const labelStr = cp.label ? ` (${cp.label})` : "";
            return `${i + 1}. ${cp.tag}${labelStr}\n   SHA: ${cp.sha.slice(0, 8)} | Created: ${date}`;
          });

          return {
            content: [
              {
                type: "text",
                text: `📌 Checkpoints for ${sessionId}:\n\n${lines.join("\n\n")}`,
              },
            ],
          };
        }

        case "restore": {
          if (!params.tag) {
            return {
              content: [{ type: "text", text: "Error: 'tag' is required for restore action." }],
            };
          }

          const success = checkpointMgr.restoreCheckpoint(workdir, params.tag);
          if (success) {
            return {
              content: [
                { type: "text", text: `✅ Restored to checkpoint: ${params.tag}` },
              ],
            };
          }
          return {
            content: [
              {
                type: "text",
                text: `❌ Failed to restore checkpoint: ${params.tag}. Tag may not exist.`,
              },
            ],
          };
        }

        case "create": {
          const checkpoint = checkpointMgr.createCheckpoint(workdir, sessionId, params.label);
          if (checkpoint) {
            return {
              content: [
                {
                  type: "text",
                  text: `📌 Checkpoint created: ${checkpoint.tag}\n   SHA: ${checkpoint.sha.slice(0, 8)}`,
                },
              ],
            };
          }
          return {
            content: [{ type: "text", text: "❌ Failed to create checkpoint." }],
          };
        }
      }
    },
  };
}

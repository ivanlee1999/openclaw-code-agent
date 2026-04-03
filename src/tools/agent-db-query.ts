/**
 * Tool for querying the SQLite database for debugging/visibility.
 *
 * @module tools/agent-db-query
 */

import { Type } from "@sinclair/typebox";
import {
  listWorktrees,
  listSessions,
  listPipelineRuns,
  getDbStats,
} from "../database";
import type { OpenClawPluginToolContext } from "../types";

interface AgentDbQueryParams {
  query: string;
  limit?: number;
}

function isAgentDbQueryParams(value: unknown): value is AgentDbQueryParams {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  return typeof p.query === "string";
}

/** Register the `agent_db_query` tool: query the SQLite database. */
export function makeAgentDbQueryTool(_ctx: OpenClawPluginToolContext) {
  return {
    name: "agent_db_query",
    description:
      "Query the code-agent SQLite database for worktrees, sessions, pipelines, or aggregate stats. " +
      "Useful for debugging and visibility into agent activity history.",
    parameters: Type.Object({
      query: Type.Union(
        [
          Type.Literal("worktrees"),
          Type.Literal("sessions"),
          Type.Literal("pipelines"),
          Type.Literal("stats"),
        ],
        {
          description:
            'What to query: "worktrees" lists worktrees, "sessions" lists sessions, "pipelines" lists pipeline runs, "stats" shows aggregate statistics.',
        },
      ),
      limit: Type.Optional(
        Type.Number({
          description: "Maximum number of rows to return (default: 20, max: 100).",
          minimum: 1,
          maximum: 100,
        }),
      ),
    }),
    async execute(_id: string, params: unknown) {
      if (!isAgentDbQueryParams(params)) {
        return {
          content: [
            {
              type: "text" as const,
              text: 'Error: Invalid parameters. Expected { query: "worktrees" | "sessions" | "pipelines" | "stats" }.',
            },
          ],
        };
      }

      try {
        const limit = Math.min(params.limit ?? 20, 100);
        let text: string;

        switch (params.query) {
          case "worktrees": {
            const rows = listWorktrees();
            if (rows.length === 0) {
              text = "No worktrees found in database.";
            } else {
              const lines = rows.slice(0, limit).map((w) =>
                [
                  `• **${w.name}** (${w.status})`,
                  `  Branch: ${w.branch_name} (base: ${w.base_branch ?? "main"})`,
                  `  Path: ${w.path}`,
                  w.github_pr_url ? `  PR: ${w.github_pr_url}` : null,
                  `  Created: ${w.created_at} | Last accessed: ${w.last_accessed_at}`,
                ].filter(Boolean).join("\n"),
              );
              text = `**Worktrees** (${rows.length} total, showing ${Math.min(rows.length, limit)}):\n\n${lines.join("\n\n")}`;
            }
            break;
          }

          case "sessions": {
            const rows = listSessions(undefined, limit);
            if (rows.length === 0) {
              text = "No sessions found in database.";
            } else {
              const lines = rows.map((s) =>
                [
                  `• **${s.name}** [${s.harness}] (${s.status})`,
                  `  ID: ${s.id}${s.pipeline_id ? ` | Pipeline: ${s.pipeline_id}` : ""}`,
                  s.model ? `  Model: ${s.model}` : null,
                  s.cost_usd > 0 ? `  Cost: $${s.cost_usd.toFixed(4)}` : null,
                  s.workdir ? `  Workdir: ${s.workdir}` : null,
                  `  Created: ${s.created_at}${s.completed_at ? ` | Completed: ${s.completed_at}` : ""}`,
                ].filter(Boolean).join("\n"),
              );
              text = `**Sessions** (showing ${rows.length}):\n\n${lines.join("\n\n")}`;
            }
            break;
          }

          case "pipelines": {
            const rows = listPipelineRuns(limit);
            if (rows.length === 0) {
              text = "No pipeline runs found in database.";
            } else {
              const lines = rows.map((p) =>
                [
                  `• **${p.name}** (${p.status})`,
                  `  ID: ${p.id} | Max iterations: ${p.max_iterations}`,
                  `  Workdir: ${p.workdir}`,
                  p.worktree_path ? `  Worktree: ${p.worktree_path}` : null,
                  p.pr_url ? `  PR: ${p.pr_url}` : null,
                  p.error ? `  Error: ${p.error.slice(0, 200)}` : null,
                  `  Started: ${p.started_at}${p.completed_at ? ` | Completed: ${p.completed_at}` : ""}`,
                ].filter(Boolean).join("\n"),
              );
              text = `**Pipeline Runs** (showing ${rows.length}):\n\n${lines.join("\n\n")}`;
            }
            break;
          }

          case "stats": {
            const s = getDbStats();
            text = [
              "**Database Stats**",
              "",
              `Total sessions: ${s.totalSessions}`,
              `Total pipelines: ${s.totalPipelines}`,
              `Total worktrees: ${s.totalWorktrees} (${s.activeWorktrees} active)`,
              `Total cost: $${s.totalCostUsd.toFixed(4)}`,
              "",
              "**Sessions by status:**",
              ...Object.entries(s.sessionsByStatus).map(([k, v]) => `  ${k}: ${v}`),
              "",
              "**Pipelines by status:**",
              ...Object.entries(s.pipelinesByStatus).map(([k, v]) => `  ${k}: ${v}`),
            ].join("\n");
            break;
          }

          default:
            text = `Unknown query type: "${params.query}". Use "worktrees", "sessions", "pipelines", or "stats".`;
        }

        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error querying database: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  };
}

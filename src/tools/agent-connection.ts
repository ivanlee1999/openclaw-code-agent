/**
 * Tool: agent_connection — manage multi-repo connections.
 *
 * Subcommands: create, list, delete, show.
 *
 * @module tools/agent-connection
 */

import { Type } from "@sinclair/typebox";
import { connectionsManager } from "../singletons";
import { sessionManager } from "../singletons";
import type { OpenClawPluginToolContext } from "../types";

interface AgentConnectionParams {
  action: "create" | "list" | "delete" | "show";
  id?: string;
  name?: string;
  repos?: string[];
}

function isAgentConnectionParams(value: unknown): value is AgentConnectionParams {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  return typeof p.action === "string"
    && (p.action === "create" || p.action === "list" || p.action === "delete" || p.action === "show");
}

/** Register the `agent_connection` tool factory. */
export function makeAgentConnectionTool(ctx: OpenClawPluginToolContext) {
  return {
    name: "agent_connection",
    description:
      "Manage multi-repo connections. Connections link multiple repositories into a shared workspace " +
      "with an auto-generated CLAUDE.md. Use with agent_launch(connection_id=...) to launch sessions " +
      "that can work across multiple repos simultaneously.",
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("create"),
          Type.Literal("list"),
          Type.Literal("delete"),
          Type.Literal("show"),
        ],
        { description: "Action to perform." },
      ),
      id: Type.Optional(
        Type.String({ description: "Connection ID (for show/delete)." }),
      ),
      name: Type.Optional(
        Type.String({ description: "Connection name (for create, kebab-case recommended)." }),
      ),
      repos: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Absolute paths to repositories to connect (for create). " +
            "Optionally use 'alias:/path/to/repo' format to specify custom aliases.",
        }),
      ),
    }),
    async execute(_id: string, params: unknown) {
      if (!connectionsManager) {
        return {
          content: [{ type: "text", text: "Error: ConnectionsManager not initialized. The code-agent service must be running." }],
        };
      }
      if (!isAgentConnectionParams(params)) {
        return {
          content: [{ type: "text", text: "Error: Invalid parameters. Expected { action: 'create'|'list'|'delete'|'show', ... }." }],
        };
      }

      try {
        switch (params.action) {
          case "create":
            return handleCreate(params);
          case "list":
            return handleList();
          case "delete":
            return handleDelete(params);
          case "show":
            return handleShow(params);
          default:
            return { content: [{ type: "text", text: `Unknown action: ${params.action}` }] };
        }
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  };
}

function handleCreate(params: AgentConnectionParams) {
  if (!params.name) {
    return { content: [{ type: "text", text: "Error: 'name' is required for create action." }] };
  }
  if (!params.repos || params.repos.length === 0) {
    return { content: [{ type: "text", text: "Error: 'repos' array is required for create action (at least 1 repo path)." }] };
  }

  const parsedRepos = params.repos.map((r) => {
    const colonIdx = r.indexOf(":");
    if (colonIdx > 0 && r[colonIdx + 1] === "/") {
      return { alias: r.slice(0, colonIdx), path: r.slice(colonIdx + 1) };
    }
    return { path: r };
  });

  const connection = connectionsManager!.createConnection({
    name: params.name,
    repos: parsedRepos,
  });

  return {
    content: [{
      type: "text",
      text: [
        `Connection created: **${connection.name}** (ID: ${connection.id})`,
        ``,
        `Repos:`,
        ...connection.repos.map((r) => `  - ${r.alias} -> ${r.path}`),
        ``,
        `Use with: agent_launch(prompt='...', connection_id='${connection.id}')`,
        `Or:       agent_pipeline(prompt='...', workdir='...', connection_id='${connection.id}')`,
      ].join("\n"),
    }],
  };
}

function handleList() {
  const connections = connectionsManager!.listConnections();
  if (connections.length === 0) {
    return { content: [{ type: "text", text: "No connections found. Create one with agent_connection(action='create', name='...', repos=[...])." }] };
  }

  const lines = connections.map((c) => {
    const repos = c.repos.map((r) => r.alias).join(", ");
    return `- **${c.name}** [${c.id}] — repos: ${repos}`;
  });

  return {
    content: [{
      type: "text",
      text: [`Connections (${connections.length}):`, ``, ...lines].join("\n"),
    }],
  };
}

function handleDelete(params: AgentConnectionParams) {
  if (!params.id) {
    return { content: [{ type: "text", text: "Error: 'id' is required for delete action." }] };
  }
  const deleted = connectionsManager!.deleteConnection(params.id);
  if (!deleted) {
    return { content: [{ type: "text", text: `Connection not found: ${params.id}` }] };
  }
  return { content: [{ type: "text", text: `Connection ${params.id} deleted.` }] };
}

function handleShow(params: AgentConnectionParams) {
  if (!params.id) {
    return { content: [{ type: "text", text: "Error: 'id' is required for show action." }] };
  }
  const connection = connectionsManager!.getConnection(params.id);
  if (!connection) {
    return { content: [{ type: "text", text: `Connection not found: ${params.id}` }] };
  }

  const activeSessions: string[] = [];
  if (sessionManager) {
    for (const s of sessionManager.list("all")) {
      if ((s as any).connectionId === params.id) {
        activeSessions.push(`  - ${s.name} [${s.id}] (${s.status})`);
      }
    }
  }

  const workspace = connectionsManager!.getActiveWorkspace(params.id);

  const lines = [
    `Connection: **${connection.name}** (ID: ${connection.id})`,
    `Created: ${new Date(connection.created_at).toISOString()}`,
    `Updated: ${new Date(connection.updated_at).toISOString()}`,
    ``,
    `Repos:`,
    ...connection.repos.map((r) => `  - ${r.alias} -> ${r.path}`),
  ];

  if (workspace) {
    lines.push(``, `Active workspace: ${workspace.rootDir}`);
  }

  if (activeSessions.length > 0) {
    lines.push(``, `Active sessions using this connection:`, ...activeSessions);
  } else {
    lines.push(``, `No active sessions using this connection.`);
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}

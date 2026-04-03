/**
 * Multi-repo connections manager.
 *
 * Creates shared workspace directories where multiple repos are symlinked
 * together, with an auto-generated CLAUDE.md describing the project structure.
 * Inspired by Hive (https://github.com/morapelker/hive).
 *
 * @module connections
 */

import { execFileSync } from "child_process";
import { existsSync, mkdirSync, symlinkSync, unlinkSync, readdirSync, writeFileSync, rmSync } from "fs";
import { basename, join } from "path";
import { nanoid } from "nanoid";
import type { OpenClawDatabase, ConnectionRecord, CreateConnectionInput } from "./database";

/** Materialized workspace for a connection. */
export interface ConnectionWorkspace {
  connectionId: string;
  rootDir: string;
  linkedRepos: Array<{ alias: string; targetPath: string; linkPath: string }>;
  claudeMdPath: string;
}

/** Git metadata for a single repo (best-effort). */
interface RepoGitInfo {
  branch: string;
  lastCommit: string;
}

export interface ConnectionsManagerDeps {
  /** Base directory for connection workspaces. */
  connectionsRoot: string;
  /** Database instance. */
  db: OpenClawDatabase;
}

/**
 * Manages multi-repo connections: CRUD via database, workspace materialization
 * with symlinks, and CLAUDE.md generation.
 */
export class ConnectionsManager {
  private connectionsRoot: string;
  private db: OpenClawDatabase;

  /** Track active workspaces by connectionId for cleanup. */
  private activeWorkspaces: Map<string, ConnectionWorkspace> = new Map();

  constructor(deps: ConnectionsManagerDeps) {
    this.connectionsRoot = deps.connectionsRoot;
    this.db = deps.db;
  }

  // -- CRUD (delegates to database) --

  createConnection(input: { name: string; repos: Array<{ path: string; alias?: string }> }): ConnectionRecord {
    // Validate all repo paths exist
    for (const repo of input.repos) {
      if (!existsSync(repo.path)) {
        throw new Error(`Repository path does not exist: ${repo.path}`);
      }
    }

    // Normalize aliases (use basename if not provided)
    const normalizedRepos = input.repos.map((repo) => ({
      path: repo.path,
      alias: repo.alias || basename(repo.path),
    }));

    // Check for alias collisions
    const aliases = new Set<string>();
    for (const repo of normalizedRepos) {
      if (aliases.has(repo.alias)) {
        throw new Error(`Duplicate alias: "${repo.alias}". Each repo must have a unique alias.`);
      }
      aliases.add(repo.alias);
    }

    // Check for name collision
    const existing = this.db.getConnectionByName(input.name);
    if (existing) {
      throw new Error(`Connection with name "${input.name}" already exists (id: ${existing.id}).`);
    }

    const id = nanoid(8);
    return this.db.createConnection({
      id,
      name: input.name,
      repos: normalizedRepos,
    });
  }

  listConnections(): ConnectionRecord[] {
    return this.db.listConnections();
  }

  getConnection(id: string): ConnectionRecord | undefined {
    return this.db.getConnection(id);
  }

  deleteConnection(id: string): boolean {
    // Clean up workspace if active
    const workspace = this.activeWorkspaces.get(id);
    if (workspace) {
      this.cleanupWorkspace(id);
    }
    return this.db.deleteConnection(id);
  }

  // -- Workspace materialization --

  /**
   * Prepare (or retrieve) a shared workspace for a connection.
   * Creates symlinks from each connected repo into the workspace directory
   * and generates a CLAUDE.md describing the structure.
   */
  prepareWorkspace(connectionId: string): ConnectionWorkspace {
    // Return existing workspace if already prepared
    const existing = this.activeWorkspaces.get(connectionId);
    if (existing && existsSync(existing.rootDir)) {
      return existing;
    }

    const connection = this.db.getConnection(connectionId);
    if (!connection) {
      throw new Error(`Connection not found: ${connectionId}`);
    }

    const rootDir = join(this.connectionsRoot, connection.name);
    mkdirSync(rootDir, { recursive: true });

    const linkedRepos: ConnectionWorkspace["linkedRepos"] = [];

    for (const repo of connection.repos) {
      const linkPath = join(rootDir, repo.alias);

      // Remove stale symlink if it exists
      if (existsSync(linkPath)) {
        try {
          unlinkSync(linkPath);
        } catch {
          // Best effort
        }
      }

      if (!existsSync(repo.path)) {
        throw new Error(`Repository path does not exist: ${repo.path}`);
      }

      symlinkSync(repo.path, linkPath);
      linkedRepos.push({
        alias: repo.alias,
        targetPath: repo.path,
        linkPath,
      });
    }

    // Generate CLAUDE.md
    const claudeMdPath = join(rootDir, "CLAUDE.md");
    const claudeMdContent = this.generateClaudeMd(connection, linkedRepos);
    writeFileSync(claudeMdPath, claudeMdContent, "utf-8");

    const workspace: ConnectionWorkspace = {
      connectionId,
      rootDir,
      linkedRepos,
      claudeMdPath,
    };

    this.activeWorkspaces.set(connectionId, workspace);
    return workspace;
  }

  /**
   * Clean up a connection workspace: remove symlinks and generated files.
   * Idempotent — safe to call multiple times.
   */
  cleanupWorkspace(connectionId: string): void {
    const workspace = this.activeWorkspaces.get(connectionId);
    if (!workspace) return;

    // Remove symlinks
    for (const linked of workspace.linkedRepos) {
      try {
        if (existsSync(linked.linkPath)) {
          unlinkSync(linked.linkPath);
        }
      } catch {
        // Best effort
      }
    }

    // Remove CLAUDE.md
    try {
      if (existsSync(workspace.claudeMdPath)) {
        unlinkSync(workspace.claudeMdPath);
      }
    } catch {
      // Best effort
    }

    // Remove workspace directory if empty
    try {
      const entries = readdirSync(workspace.rootDir);
      if (entries.length === 0) {
        rmSync(workspace.rootDir, { recursive: true, force: true });
      }
    } catch {
      // Best effort
    }

    this.activeWorkspaces.delete(connectionId);
  }

  /** Get the active workspace for a connection, if any. */
  getActiveWorkspace(connectionId: string): ConnectionWorkspace | undefined {
    return this.activeWorkspaces.get(connectionId);
  }

  // -- CLAUDE.md generation --

  private generateClaudeMd(
    connection: ConnectionRecord,
    linkedRepos: ConnectionWorkspace["linkedRepos"],
  ): string {
    const lines: string[] = [
      `# Connected Repositories`,
      ``,
      `Connection: **${connection.name}**`,
      ``,
    ];

    for (const repo of linkedRepos) {
      const gitInfo = this.getRepoGitInfo(repo.targetPath);
      lines.push(`- \`${repo.alias}\` -> \`${repo.targetPath}\``);
      lines.push(`  - branch: \`${gitInfo.branch}\``);
      lines.push(`  - last commit: \`${gitInfo.lastCommit}\``);
    }

    lines.push(``);
    lines.push(`## Working with these repos`);
    lines.push(``);
    lines.push(`Each directory in this workspace is a symlink to the actual repository.`);
    lines.push(`Changes made in any linked directory are applied directly to the source repo.`);
    lines.push(``);

    return lines.join("\n");
  }

  private getRepoGitInfo(repoPath: string): RepoGitInfo {
    let branch = "unknown";
    let lastCommit = "unknown";

    try {
      branch = execFileSync("git", ["-C", repoPath, "rev-parse", "--abbrev-ref", "HEAD"], {
        encoding: "utf-8",
        timeout: 5_000,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim() || "unknown";
    } catch {
      // Best effort
    }

    try {
      lastCommit = execFileSync("git", ["-C", repoPath, "log", "-1", "--format=%h %s"], {
        encoding: "utf-8",
        timeout: 5_000,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim() || "unknown";
    } catch {
      // Best effort
    }

    return { branch, lastCommit };
  }
}

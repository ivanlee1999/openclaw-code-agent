/**
 * SQLite-backed persistence layer for structured data.
 *
 * Uses Node 22's built-in `node:sqlite` (DatabaseSync) so no native
 * dependencies are required. Supports `:memory:` for deterministic tests.
 *
 * @module database
 */

import { DatabaseSync } from "node:sqlite";

/** Shape of a stored connection record. */
export interface ConnectionRecord {
  id: string;
  name: string;
  repos: Array<{ path: string; alias: string }>;
  created_at: number;
  updated_at: number;
}

/** Input for creating a connection. */
export interface CreateConnectionInput {
  id: string;
  name: string;
  repos: Array<{ path: string; alias: string }>;
}

/**
 * Thin SQLite wrapper scoped to OpenClaw structured data.
 *
 * Currently owns the `connections` table. Additional tables
 * (pipeline_runs, pipeline_stages) can be added in future phases.
 */
export class OpenClawDatabase {
  private db: DatabaseSync;

  constructor(dbPath: string = ":memory:") {
    this.db = new DatabaseSync(dbPath);
    this.runMigrations();
  }

  /** Run schema creation / migrations. */
  private runMigrations(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        repos TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
  }

  /** Get the underlying DatabaseSync instance (for advanced queries / testing). */
  getDb(): DatabaseSync {
    return this.db;
  }

  // -- Connections CRUD --

  createConnection(input: CreateConnectionInput): ConnectionRecord {
    const now = Date.now();
    const reposJson = JSON.stringify(input.repos);
    const stmt = this.db.prepare(
      "INSERT INTO connections (id, name, repos, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    );
    stmt.run(input.id, input.name, reposJson, now, now);
    return {
      id: input.id,
      name: input.name,
      repos: input.repos,
      created_at: now,
      updated_at: now,
    };
  }

  listConnections(): ConnectionRecord[] {
    const stmt = this.db.prepare("SELECT * FROM connections ORDER BY created_at DESC");
    const rows = stmt.all() as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToRecord(row));
  }

  getConnection(id: string): ConnectionRecord | undefined {
    const stmt = this.db.prepare("SELECT * FROM connections WHERE id = ?");
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToRecord(row) : undefined;
  }

  getConnectionByName(name: string): ConnectionRecord | undefined {
    const stmt = this.db.prepare("SELECT * FROM connections WHERE name = ?");
    const row = stmt.get(name) as Record<string, unknown> | undefined;
    return row ? this.rowToRecord(row) : undefined;
  }

  deleteConnection(id: string): boolean {
    const stmt = this.db.prepare("DELETE FROM connections WHERE id = ?");
    const result = stmt.run(id);
    return (result as any).changes > 0;
  }

  updateConnectionRepos(id: string, repos: Array<{ path: string; alias: string }>): boolean {
    const stmt = this.db.prepare(
      "UPDATE connections SET repos = ?, updated_at = ? WHERE id = ?",
    );
    const result = stmt.run(JSON.stringify(repos), Date.now(), id);
    return (result as any).changes > 0;
  }

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }

  private rowToRecord(row: Record<string, unknown>): ConnectionRecord {
    return {
      id: row.id as string,
      name: row.name as string,
      repos: JSON.parse(row.repos as string) as Array<{ path: string; alias: string }>,
      created_at: row.created_at as number,
      updated_at: row.updated_at as number,
    };
  }
}


// --- Backward-compatible standalone exports for session-manager.ts ---
// These are no-ops when DB is not initialized; session-manager also writes to JSON.
let _dbInstance: OpenClawDatabase | null = null;

export function setDbInstance(db: OpenClawDatabase | null): void {
  _dbInstance = db;
}

export function insertSession(data: Record<string, unknown>): void {
  // Session data written to JSON by session-store; DB recording is optional
}

export function updateSession(sessionId: string, data: Record<string, unknown>): void {
  // Session data written to JSON by session-store; DB recording is optional
}

export function upsertProject(path: string, name?: string): void {
  if (_dbInstance) {
    try {
      _dbInstance.upsertProject(path, name);
    } catch {}
  }
}

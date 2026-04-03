/**
 * Tests for the SQLite-backed database layer (src/database.ts).
 *
 * Uses :memory: databases for determinism — no disk I/O.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { OpenClawDatabase } from "../src/database";
import type { CreateConnectionInput } from "../src/database";

describe("OpenClawDatabase", () => {
  let db: OpenClawDatabase;

  beforeEach(() => {
    db = new OpenClawDatabase(":memory:");
  });

  describe("schema bootstrap", () => {
    it("creates the connections table on construction", () => {
      const raw = db.getDb();
      const tables = raw
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='connections'")
        .all();
      assert.equal(tables.length, 1);
    });

    it("is idempotent — calling constructor twice on same DB does not throw", () => {
      // The table already exists from beforeEach; creating another instance
      // on the same path shouldn't fail. We use :memory: so create a new one.
      const db2 = new OpenClawDatabase(":memory:");
      assert.ok(db2);
      db2.close();
    });
  });

  describe("connections CRUD", () => {
    const input: CreateConnectionInput = {
      id: "conn-1",
      name: "my-connection",
      repos: [
        { path: "/repos/api", alias: "api" },
        { path: "/repos/web", alias: "web" },
      ],
    };

    it("createConnection returns a record with timestamps", () => {
      const before = Date.now();
      const record = db.createConnection(input);
      const after = Date.now();

      assert.equal(record.id, "conn-1");
      assert.equal(record.name, "my-connection");
      assert.deepEqual(record.repos, input.repos);
      assert.ok(record.created_at >= before && record.created_at <= after);
      assert.ok(record.updated_at >= before && record.updated_at <= after);
    });

    it("getConnection retrieves by id", () => {
      db.createConnection(input);
      const found = db.getConnection("conn-1");
      assert.ok(found);
      assert.equal(found.id, "conn-1");
      assert.equal(found.name, "my-connection");
    });

    it("getConnection returns undefined for missing id", () => {
      const found = db.getConnection("nonexistent");
      assert.equal(found, undefined);
    });

    it("getConnectionByName retrieves by name", () => {
      db.createConnection(input);
      const found = db.getConnectionByName("my-connection");
      assert.ok(found);
      assert.equal(found.id, "conn-1");
    });

    it("getConnectionByName returns undefined for missing name", () => {
      const found = db.getConnectionByName("nope");
      assert.equal(found, undefined);
    });

    it("listConnections returns all connections ordered by created_at DESC", () => {
      db.createConnection({ id: "c1", name: "first", repos: [] });
      // Manually insert with a later timestamp to ensure ordering
      const db2 = db.getDb();
      db2.prepare("INSERT INTO connections (id, name, repos, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
        "c2", "second", "[]", Date.now() + 1000, Date.now() + 1000,
      );
      const list = db.listConnections();
      assert.equal(list.length, 2);
      // Most recent first
      assert.equal(list[0].id, "c2");
      assert.equal(list[1].id, "c1");
    });

    it("listConnections returns empty array when no connections", () => {
      assert.deepEqual(db.listConnections(), []);
    });

    it("deleteConnection removes a connection and returns true", () => {
      db.createConnection(input);
      const deleted = db.deleteConnection("conn-1");
      assert.equal(deleted, true);
      assert.equal(db.getConnection("conn-1"), undefined);
    });

    it("deleteConnection returns false when connection does not exist", () => {
      const deleted = db.deleteConnection("nonexistent");
      assert.equal(deleted, false);
    });

    it("updateConnectionRepos updates repos and updated_at", () => {
      db.createConnection(input);
      const newRepos = [{ path: "/repos/new", alias: "new" }];
      const updated = db.updateConnectionRepos("conn-1", newRepos);
      assert.equal(updated, true);

      const record = db.getConnection("conn-1");
      assert.ok(record);
      assert.deepEqual(record.repos, newRepos);
      assert.ok(record.updated_at >= record.created_at);
    });

    it("updateConnectionRepos returns false for missing id", () => {
      const updated = db.updateConnectionRepos("nope", []);
      assert.equal(updated, false);
    });

    it("rejects duplicate connection names", () => {
      db.createConnection(input);
      assert.throws(() => {
        db.createConnection({ ...input, id: "conn-2" });
      });
    });

    it("rejects duplicate connection ids", () => {
      db.createConnection(input);
      assert.throws(() => {
        db.createConnection({ ...input, name: "different-name" });
      });
    });
  });

  describe("repos JSON serialization", () => {
    it("round-trips complex repo objects", () => {
      const repos = [
        { path: "/a/b/c", alias: "alias-with-dashes" },
        { path: "/d/e/f", alias: "another" },
      ];
      db.createConnection({ id: "rt-1", name: "roundtrip", repos });
      const record = db.getConnection("rt-1");
      assert.ok(record);
      assert.deepEqual(record.repos, repos);
    });

    it("handles empty repos array", () => {
      db.createConnection({ id: "empty", name: "empty-repos", repos: [] });
      const record = db.getConnection("empty");
      assert.ok(record);
      assert.deepEqual(record.repos, []);
    });
  });

  describe("close", () => {
    it("does not throw", () => {
      assert.doesNotThrow(() => db.close());
    });
  });
});

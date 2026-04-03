/**
 * Tests for the multi-repo connections manager (src/connections.ts).
 *
 * Uses tmp directories and :memory: SQLite for determinism.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, existsSync, readFileSync, lstatSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";
import { OpenClawDatabase } from "../src/database";
import { ConnectionsManager } from "../src/connections";

function createTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "connections-test-"));
}

function createTmpGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execSync("git init && git commit --allow-empty -m 'init'", {
    cwd: dir,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@test.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@test.com" },
  });
}

describe("ConnectionsManager", () => {
  let db: OpenClawDatabase;
  let connectionsRoot: string;
  let manager: ConnectionsManager;
  let tmpDirs: string[];

  beforeEach(() => {
    db = new OpenClawDatabase(":memory:");
    connectionsRoot = createTmpDir();
    manager = new ConnectionsManager({ connectionsRoot, db });
    tmpDirs = [connectionsRoot];
  });

  afterEach(() => {
    db.close();
    for (const dir of tmpDirs) {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  describe("createConnection", () => {
    it("creates a connection with auto-generated alias from basename", () => {
      const repoDir = createTmpDir();
      tmpDirs.push(repoDir);

      const conn = manager.createConnection({
        name: "test-conn",
        repos: [{ path: repoDir }],
      });

      assert.ok(conn.id);
      assert.equal(conn.name, "test-conn");
      assert.equal(conn.repos.length, 1);
      // Alias should be basename of repoDir
      assert.ok(conn.repos[0].alias.length > 0);
      assert.equal(conn.repos[0].path, repoDir);
    });

    it("creates a connection with explicit aliases", () => {
      const repoDir = createTmpDir();
      tmpDirs.push(repoDir);

      const conn = manager.createConnection({
        name: "explicit",
        repos: [{ path: repoDir, alias: "my-alias" }],
      });

      assert.equal(conn.repos[0].alias, "my-alias");
    });

    it("throws on missing repo path", () => {
      assert.throws(
        () => manager.createConnection({
          name: "bad",
          repos: [{ path: "/nonexistent/path/that/does/not/exist" }],
        }),
        /does not exist/,
      );
    });

    it("throws on duplicate alias", () => {
      const dir1 = createTmpDir();
      const dir2 = createTmpDir();
      tmpDirs.push(dir1, dir2);

      assert.throws(
        () => manager.createConnection({
          name: "dup-alias",
          repos: [
            { path: dir1, alias: "same" },
            { path: dir2, alias: "same" },
          ],
        }),
        /Duplicate alias/,
      );
    });

    it("throws on duplicate connection name", () => {
      const dir = createTmpDir();
      tmpDirs.push(dir);

      manager.createConnection({ name: "unique", repos: [{ path: dir }] });
      assert.throws(
        () => manager.createConnection({ name: "unique", repos: [{ path: dir }] }),
        /already exists/,
      );
    });
  });

  describe("listConnections", () => {
    it("returns empty list initially", () => {
      assert.deepEqual(manager.listConnections(), []);
    });

    it("returns created connections", () => {
      const dir = createTmpDir();
      tmpDirs.push(dir);
      manager.createConnection({ name: "c1", repos: [{ path: dir }] });
      const list = manager.listConnections();
      assert.equal(list.length, 1);
      assert.equal(list[0].name, "c1");
    });
  });

  describe("getConnection / deleteConnection", () => {
    it("retrieves and deletes by id", () => {
      const dir = createTmpDir();
      tmpDirs.push(dir);
      const conn = manager.createConnection({ name: "del-test", repos: [{ path: dir }] });

      assert.ok(manager.getConnection(conn.id));
      assert.equal(manager.deleteConnection(conn.id), true);
      assert.equal(manager.getConnection(conn.id), undefined);
    });

    it("deleteConnection returns false for unknown id", () => {
      assert.equal(manager.deleteConnection("nonexistent"), false);
    });
  });

  describe("prepareWorkspace", () => {
    it("creates symlinks and CLAUDE.md", () => {
      const repoDir = createTmpDir();
      tmpDirs.push(repoDir);
      createTmpGitRepo(repoDir);

      const conn = manager.createConnection({
        name: "workspace-test",
        repos: [{ path: repoDir, alias: "my-repo" }],
      });

      const workspace = manager.prepareWorkspace(conn.id);

      assert.ok(existsSync(workspace.rootDir));
      assert.ok(existsSync(workspace.claudeMdPath));
      assert.equal(workspace.linkedRepos.length, 1);

      // Verify symlink
      const linkPath = workspace.linkedRepos[0].linkPath;
      assert.ok(existsSync(linkPath));
      assert.ok(lstatSync(linkPath).isSymbolicLink());

      // Verify CLAUDE.md content
      const claudeMd = readFileSync(workspace.claudeMdPath, "utf-8");
      assert.ok(claudeMd.includes("Connected Repositories"));
      assert.ok(claudeMd.includes("my-repo"));
      assert.ok(claudeMd.includes(repoDir));
    });

    it("returns same workspace on second call (idempotent)", () => {
      const repoDir = createTmpDir();
      tmpDirs.push(repoDir);
      createTmpGitRepo(repoDir);

      const conn = manager.createConnection({
        name: "idem-test",
        repos: [{ path: repoDir, alias: "repo" }],
      });

      const ws1 = manager.prepareWorkspace(conn.id);
      const ws2 = manager.prepareWorkspace(conn.id);
      assert.equal(ws1.rootDir, ws2.rootDir);
    });

    it("throws for unknown connection id", () => {
      assert.throws(
        () => manager.prepareWorkspace("nonexistent"),
        /Connection not found/,
      );
    });

    it("throws when repo path is missing at workspace time", () => {
      const dir = createTmpDir();
      tmpDirs.push(dir);

      const conn = manager.createConnection({
        name: "missing-repo",
        repos: [{ path: dir, alias: "repo" }],
      });

      // Remove the directory
      rmSync(dir, { recursive: true, force: true });

      assert.throws(
        () => manager.prepareWorkspace(conn.id),
        /does not exist/,
      );
    });
  });

  describe("cleanupWorkspace", () => {
    it("removes symlinks and CLAUDE.md", () => {
      const repoDir = createTmpDir();
      tmpDirs.push(repoDir);
      createTmpGitRepo(repoDir);

      const conn = manager.createConnection({
        name: "cleanup-test",
        repos: [{ path: repoDir, alias: "repo" }],
      });

      const workspace = manager.prepareWorkspace(conn.id);
      assert.ok(existsSync(workspace.linkedRepos[0].linkPath));
      assert.ok(existsSync(workspace.claudeMdPath));

      manager.cleanupWorkspace(conn.id);

      assert.ok(!existsSync(workspace.linkedRepos[0].linkPath));
      assert.ok(!existsSync(workspace.claudeMdPath));
    });

    it("is idempotent — calling twice does not throw", () => {
      const repoDir = createTmpDir();
      tmpDirs.push(repoDir);
      createTmpGitRepo(repoDir);

      const conn = manager.createConnection({
        name: "idem-cleanup",
        repos: [{ path: repoDir, alias: "repo" }],
      });

      manager.prepareWorkspace(conn.id);
      manager.cleanupWorkspace(conn.id);
      assert.doesNotThrow(() => manager.cleanupWorkspace(conn.id));
    });

    it("does nothing when no active workspace", () => {
      assert.doesNotThrow(() => manager.cleanupWorkspace("nonexistent"));
    });
  });

  describe("getActiveWorkspace", () => {
    it("returns undefined when no workspace is prepared", () => {
      assert.equal(manager.getActiveWorkspace("nonexistent"), undefined);
    });

    it("returns workspace after prepare", () => {
      const repoDir = createTmpDir();
      tmpDirs.push(repoDir);
      createTmpGitRepo(repoDir);

      const conn = manager.createConnection({
        name: "active-ws",
        repos: [{ path: repoDir, alias: "repo" }],
      });

      manager.prepareWorkspace(conn.id);
      const ws = manager.getActiveWorkspace(conn.id);
      assert.ok(ws);
      assert.equal(ws.connectionId, conn.id);
    });

    it("returns undefined after cleanup", () => {
      const repoDir = createTmpDir();
      tmpDirs.push(repoDir);
      createTmpGitRepo(repoDir);

      const conn = manager.createConnection({
        name: "cleaned-ws",
        repos: [{ path: repoDir, alias: "repo" }],
      });

      manager.prepareWorkspace(conn.id);
      manager.cleanupWorkspace(conn.id);
      assert.equal(manager.getActiveWorkspace(conn.id), undefined);
    });
  });

  describe("CLAUDE.md generation", () => {
    it("includes branch and commit info for git repos", () => {
      const repoDir = createTmpDir();
      tmpDirs.push(repoDir);
      createTmpGitRepo(repoDir);

      const conn = manager.createConnection({
        name: "claude-md-test",
        repos: [{ path: repoDir, alias: "my-git-repo" }],
      });

      const workspace = manager.prepareWorkspace(conn.id);
      const content = readFileSync(workspace.claudeMdPath, "utf-8");

      assert.ok(content.includes("branch:"));
      assert.ok(content.includes("last commit:"));
      // Should have the init commit
      assert.ok(content.includes("init") || content.includes("unknown"));
    });

    it("handles non-git directories with 'unknown' metadata", () => {
      const plainDir = createTmpDir();
      tmpDirs.push(plainDir);

      const conn = manager.createConnection({
        name: "non-git-test",
        repos: [{ path: plainDir, alias: "plain" }],
      });

      const workspace = manager.prepareWorkspace(conn.id);
      const content = readFileSync(workspace.claudeMdPath, "utf-8");

      assert.ok(content.includes("unknown"));
    });

    it("includes multi-repo working instructions", () => {
      const dir = createTmpDir();
      tmpDirs.push(dir);

      const conn = manager.createConnection({
        name: "instructions-test",
        repos: [{ path: dir, alias: "repo" }],
      });

      const workspace = manager.prepareWorkspace(conn.id);
      const content = readFileSync(workspace.claudeMdPath, "utf-8");

      assert.ok(content.includes("Working with these repos"));
      assert.ok(content.includes("symlink"));
    });
  });

  describe("multiple repos in one connection", () => {
    it("creates symlinks for all repos", () => {
      const dir1 = createTmpDir();
      const dir2 = createTmpDir();
      tmpDirs.push(dir1, dir2);
      createTmpGitRepo(dir1);
      createTmpGitRepo(dir2);

      const conn = manager.createConnection({
        name: "multi-repo",
        repos: [
          { path: dir1, alias: "api" },
          { path: dir2, alias: "web" },
        ],
      });

      const workspace = manager.prepareWorkspace(conn.id);
      assert.equal(workspace.linkedRepos.length, 2);
      assert.ok(existsSync(join(workspace.rootDir, "api")));
      assert.ok(existsSync(join(workspace.rootDir, "web")));
    });
  });

  describe("deleteConnection cleans up workspace", () => {
    it("removes active workspace when deleting a connection", () => {
      const dir = createTmpDir();
      tmpDirs.push(dir);
      createTmpGitRepo(dir);

      const conn = manager.createConnection({
        name: "delete-cleanup",
        repos: [{ path: dir, alias: "repo" }],
      });

      const workspace = manager.prepareWorkspace(conn.id);
      assert.ok(existsSync(workspace.linkedRepos[0].linkPath));

      manager.deleteConnection(conn.id);
      assert.ok(!existsSync(workspace.linkedRepos[0].linkPath));
      assert.equal(manager.getActiveWorkspace(conn.id), undefined);
    });
  });
});

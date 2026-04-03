/**
 * Tests for checkpoints.ts — git-based checkpoint management.
 *
 * Uses real temporary git repos for deterministic testing.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";

import { CheckpointManager } from "../src/checkpoints";
import type { Checkpoint } from "../src/checkpoints";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

function createTmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "checkpoint-test-"));
  execSync("git init -b main", { cwd: dir, stdio: "pipe", env: GIT_ENV });
  writeFileSync(join(dir, "README.md"), "# Test\n");
  execSync("git add -A && git commit -m 'initial'", {
    cwd: dir,
    stdio: "pipe",
    env: GIT_ENV,
  });
  return dir;
}

function addCommit(repoDir: string, filename: string, content: string, message: string): string {
  writeFileSync(join(repoDir, filename), content);
  execSync(`git add -A && git commit -m '${message}'`, {
    cwd: repoDir,
    stdio: "pipe",
    env: GIT_ENV,
  });
  return execSync("git rev-parse HEAD", {
    cwd: repoDir,
    encoding: "utf-8",
    stdio: "pipe",
    env: GIT_ENV,
  }).trim();
}

function getCurrentSha(repoDir: string): string {
  return execSync("git rev-parse HEAD", {
    cwd: repoDir,
    encoding: "utf-8",
    stdio: "pipe",
    env: GIT_ENV,
  }).trim();
}

describe("CheckpointManager", () => {
  let repoDir: string;
  let mgr: CheckpointManager;

  beforeEach(() => {
    repoDir = createTmpRepo();
    mgr = new CheckpointManager();
  });

  afterEach(() => {
    try { rmSync(repoDir, { recursive: true, force: true }); } catch {}
  });

  describe("createCheckpoint", () => {
    it("creates a checkpoint tag at current HEAD", () => {
      const sha = getCurrentSha(repoDir);
      const cp = mgr.createCheckpoint(repoDir, "session-1", "test-label");

      assert.ok(cp, "should return a checkpoint");
      assert.equal(cp.sessionId, "session-1");
      assert.equal(cp.sha, sha);
      assert.equal(cp.label, "test-label");
      assert.ok(cp.tag.startsWith("checkpoint/session-1/"), `unexpected tag: ${cp.tag}`);
      assert.ok(cp.tag.includes("-test-label"), `tag should include label: ${cp.tag}`);
    });

    it("creates a checkpoint without a label", () => {
      const cp = mgr.createCheckpoint(repoDir, "session-2");

      assert.ok(cp, "should return a checkpoint");
      assert.equal(cp.sessionId, "session-2");
      assert.equal(cp.label, undefined);
      assert.ok(cp.tag.startsWith("checkpoint/session-2/"), `unexpected tag: ${cp.tag}`);
    });

    it("creates multiple checkpoints for same session", async () => {
      addCommit(repoDir, "a.txt", "content-a", "commit a");
      const cp1 = mgr.createCheckpoint(repoDir, "session-3", "first");
      assert.ok(cp1);

      // Small delay to ensure different timestamps
      await new Promise((r) => setTimeout(r, 5));

      addCommit(repoDir, "b.txt", "content-b", "commit b");
      const cp2 = mgr.createCheckpoint(repoDir, "session-3", "second");
      assert.ok(cp2);

      assert.notEqual(cp1.tag, cp2.tag, "tags should be unique");
      assert.notEqual(cp1.sha, cp2.sha, "SHAs should differ");
    });

    it("returns undefined for invalid workdir", () => {
      const cp = mgr.createCheckpoint("/nonexistent/path", "session-bad");
      assert.equal(cp, undefined);
    });
  });

  describe("listCheckpoints", () => {
    it("returns empty array when no checkpoints exist", () => {
      const list = mgr.listCheckpoints(repoDir, "session-none");
      assert.deepEqual(list, []);
    });

    it("lists checkpoints sorted by timestamp", async () => {
      addCommit(repoDir, "a.txt", "a", "commit a");
      mgr.createCheckpoint(repoDir, "session-list", "first");

      await new Promise((r) => setTimeout(r, 5));

      addCommit(repoDir, "b.txt", "b", "commit b");
      mgr.createCheckpoint(repoDir, "session-list", "second");

      const list = mgr.listCheckpoints(repoDir, "session-list");
      assert.equal(list.length, 2);
      assert.ok(list[0].timestamp <= list[1].timestamp, "should be sorted ascending");
      assert.equal(list[0].label, "first");
      assert.equal(list[1].label, "second");
    });

    it("does not return checkpoints from other sessions", () => {
      mgr.createCheckpoint(repoDir, "session-a", "label-a");
      mgr.createCheckpoint(repoDir, "session-b", "label-b");

      const listA = mgr.listCheckpoints(repoDir, "session-a");
      const listB = mgr.listCheckpoints(repoDir, "session-b");

      assert.equal(listA.length, 1);
      assert.equal(listB.length, 1);
      assert.equal(listA[0].sessionId, "session-a");
      assert.equal(listB[0].sessionId, "session-b");
    });
  });

  describe("restoreCheckpoint", () => {
    it("restores to a previous checkpoint", () => {
      const sha1 = addCommit(repoDir, "a.txt", "content-a", "commit a");
      const cp = mgr.createCheckpoint(repoDir, "session-restore", "before-b");
      assert.ok(cp);

      addCommit(repoDir, "b.txt", "content-b", "commit b");
      const sha2 = getCurrentSha(repoDir);
      assert.notEqual(sha1, sha2);

      const result = mgr.restoreCheckpoint(repoDir, cp.tag);
      assert.equal(result, true);

      const currentSha = getCurrentSha(repoDir);
      assert.equal(currentSha, sha1, "should be back at checkpoint SHA");

      // Verify file b.txt is gone
      assert.throws(() => readFileSync(join(repoDir, "b.txt")), "b.txt should not exist");
    });

    it("returns false for non-existent tag", () => {
      const result = mgr.restoreCheckpoint(repoDir, "checkpoint/session-x/9999999999-nonexistent");
      assert.equal(result, false);
    });

    it("returns false for invalid workdir", () => {
      const result = mgr.restoreCheckpoint("/nonexistent/path", "checkpoint/x/123");
      assert.equal(result, false);
    });
  });

  describe("deleteCheckpoint", () => {
    it("deletes a checkpoint tag", () => {
      const cp = mgr.createCheckpoint(repoDir, "session-del", "to-delete");
      assert.ok(cp);

      const listBefore = mgr.listCheckpoints(repoDir, "session-del");
      assert.equal(listBefore.length, 1);

      const result = mgr.deleteCheckpoint(repoDir, cp.tag);
      assert.equal(result, true);

      const listAfter = mgr.listCheckpoints(repoDir, "session-del");
      assert.equal(listAfter.length, 0);
    });

    it("returns false for non-existent tag", () => {
      const result = mgr.deleteCheckpoint(repoDir, "checkpoint/session-x/9999999999-fake");
      assert.equal(result, false);
    });
  });

  describe("deleteAllCheckpoints", () => {
    it("deletes all checkpoints for a session", async () => {
      mgr.createCheckpoint(repoDir, "session-delall", "cp1");
      await new Promise((r) => setTimeout(r, 5));
      addCommit(repoDir, "a.txt", "a", "commit a");
      mgr.createCheckpoint(repoDir, "session-delall", "cp2");

      const listBefore = mgr.listCheckpoints(repoDir, "session-delall");
      assert.equal(listBefore.length, 2);

      const count = mgr.deleteAllCheckpoints(repoDir, "session-delall");
      assert.equal(count, 2);

      const listAfter = mgr.listCheckpoints(repoDir, "session-delall");
      assert.equal(listAfter.length, 0);
    });

    it("does not affect other sessions", async () => {
      mgr.createCheckpoint(repoDir, "session-keep", "keep-me");
      await new Promise((r) => setTimeout(r, 5));
      mgr.createCheckpoint(repoDir, "session-remove", "remove-me");

      mgr.deleteAllCheckpoints(repoDir, "session-remove");

      const kept = mgr.listCheckpoints(repoDir, "session-keep");
      assert.equal(kept.length, 1);
      assert.equal(kept[0].label, "keep-me");
    });
  });

  describe("edge cases", () => {
    it("handles labels with special characters", () => {
      const cp = mgr.createCheckpoint(repoDir, "session-special", "after plan & review!!!");
      assert.ok(cp, "should create checkpoint with sanitized label");
      assert.ok(cp.tag.includes("after-plan"), `tag should include sanitized label: ${cp.tag}`);
    });

    it("handles checkpoint on detached HEAD gracefully", () => {
      const sha = getCurrentSha(repoDir);
      execSync(`git checkout ${sha}`, {
        cwd: repoDir,
        stdio: "pipe",
        env: GIT_ENV,
      });

      const cp = mgr.createCheckpoint(repoDir, "session-detached", "detached");
      assert.ok(cp, "should still create checkpoint on detached HEAD");
      assert.equal(cp.sha, sha);
    });

    it("can restore and then create a new checkpoint", () => {
      const sha1 = addCommit(repoDir, "a.txt", "content-a", "commit a");
      const cp1 = mgr.createCheckpoint(repoDir, "session-rc", "first");
      assert.ok(cp1);

      addCommit(repoDir, "b.txt", "content-b", "commit b");
      mgr.restoreCheckpoint(repoDir, cp1.tag);

      // Create a new checkpoint at the restored state
      const cp2 = mgr.createCheckpoint(repoDir, "session-rc", "after-restore");
      assert.ok(cp2);
      assert.equal(cp2.sha, sha1);
    });
  });
});

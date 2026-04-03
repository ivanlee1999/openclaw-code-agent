/**
 * Tests for worktree merge/PR logic (src/worktree-merge.ts, src/worktree-pr.ts).
 *
 * Uses real temporary git repos for deterministic merge/conflict testing.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";

import { getDiffSummary } from "../src/worktree-merge";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

function createTmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "worktree-merge-test-"));
  execSync("git init -b main", { cwd: dir, stdio: "pipe", env: GIT_ENV });
  writeFileSync(join(dir, "README.md"), "# Test repo\n");
  execSync("git add -A && git commit -m 'initial'", {
    cwd: dir,
    stdio: "pipe",
    env: GIT_ENV,
  });
  return dir;
}

function getDefaultBranch(repoDir: string): string {
  return execSync("git rev-parse --abbrev-ref HEAD", {
    cwd: repoDir,
    encoding: "utf-8",
    stdio: "pipe",
    env: GIT_ENV,
  }).trim();
}

function createBranch(repoDir: string, branchName: string): void {
  execSync(`git checkout -b ${branchName}`, {
    cwd: repoDir,
    stdio: "pipe",
    env: GIT_ENV,
  });
}

function switchBranch(repoDir: string, branchName: string): void {
  execSync(`git checkout ${branchName}`, {
    cwd: repoDir,
    stdio: "pipe",
    env: GIT_ENV,
  });
}

function addCommit(repoDir: string, filename: string, content: string, message: string): void {
  writeFileSync(join(repoDir, filename), content);
  execSync(`git add -A && git commit -m '${message}'`, {
    cwd: repoDir,
    stdio: "pipe",
    env: GIT_ENV,
  });
}

describe("Worktree merge logic", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = createTmpRepo();
  });

  afterEach(() => {
    try { rmSync(repoDir, { recursive: true, force: true }); } catch {}
  });

  describe("getDiffSummary", () => {
    it("returns correct diff stats for a branch with commits", () => {
      createBranch(repoDir, "feature/test");
      addCommit(repoDir, "new-file.ts", "export const x = 1;\n", "add new file");
      addCommit(repoDir, "another.ts", "export const y = 2;\n", "add another file");

      const summary = getDiffSummary(repoDir, "feature/test", "main");
      assert.ok(summary);
      assert.equal(summary.commits, 2);
      assert.ok(summary.filesChanged >= 2);
      assert.ok(summary.insertions > 0);
      assert.ok(summary.changedFiles.includes("new-file.ts"));
      assert.ok(summary.changedFiles.includes("another.ts"));
    });

    it("returns 0 commits for identical branches", () => {
      createBranch(repoDir, "identical");
      // No commits on the branch
      const summary = getDiffSummary(repoDir, "identical", "main");
      assert.ok(summary);
      assert.equal(summary.commits, 0);
    });

    it("includes commit messages", () => {
      createBranch(repoDir, "feature/messages");
      addCommit(repoDir, "foo.txt", "content", "descriptive commit message");

      const summary = getDiffSummary(repoDir, "feature/messages", "main");
      assert.ok(summary);
      assert.ok(summary.commitMessages.length > 0);
      assert.ok(summary.commitMessages[0].message.includes("descriptive commit message"));
    });

    it("returns undefined for nonexistent branch", () => {
      const summary = getDiffSummary(repoDir, "nonexistent-branch", "main");
      assert.equal(summary, undefined);
    });
  });

  describe("cherry-pick detection via diff", () => {
    it("detects that cherry-picked content creates identical diffs", () => {
      // Create a feature branch with a commit
      createBranch(repoDir, "feature/cherry");
      addCommit(repoDir, "cherry.txt", "cherry content\n", "cherry commit");

      // Switch back to main and cherry-pick
      switchBranch(repoDir, "main");
      execSync("git cherry-pick feature/cherry", {
        cwd: repoDir,
        stdio: "pipe",
        env: GIT_ENV,
      });

      // Now feature/cherry and main have the same content
      const summary = getDiffSummary(repoDir, "feature/cherry", "main");
      assert.ok(summary);
      assert.equal(summary.commits, 0); // No unique commits on feature branch
    });
  });

  describe("branch cleanup", () => {
    it("branch can be deleted after merge", () => {
      createBranch(repoDir, "feature/cleanup");
      addCommit(repoDir, "cleanup.txt", "data\n", "to be cleaned up");
      switchBranch(repoDir, "main");

      execSync("git merge feature/cleanup", {
        cwd: repoDir,
        stdio: "pipe",
        env: GIT_ENV,
      });

      // Verify branch can be deleted
      execSync("git branch -d feature/cleanup", {
        cwd: repoDir,
        stdio: "pipe",
        env: GIT_ENV,
      });

      // Verify it's gone
      const branches = execSync("git branch", {
        cwd: repoDir,
        encoding: "utf-8",
        stdio: "pipe",
      });
      assert.ok(!branches.includes("feature/cleanup"));
    });
  });

  describe("merge conflict detection", () => {
    it("detects conflicts when same file modified differently", () => {
      // Add a file on main
      addCommit(repoDir, "conflict.txt", "main version\n", "main edit");

      // Create branch from before the main edit
      execSync("git checkout HEAD~1", {
        cwd: repoDir,
        stdio: "pipe",
        env: GIT_ENV,
      });
      execSync("git checkout -b feature/conflict", {
        cwd: repoDir,
        stdio: "pipe",
        env: GIT_ENV,
      });
      addCommit(repoDir, "conflict.txt", "branch version\n", "branch edit");

      switchBranch(repoDir, "main");

      let mergeResult: { success: boolean; error?: string };
      try {
        execSync("git merge feature/conflict --no-edit", {
          cwd: repoDir,
          stdio: "pipe",
          env: GIT_ENV,
        });
        mergeResult = { success: true };
      } catch (err) {
        mergeResult = {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
        // Abort the merge
        execSync("git merge --abort", {
          cwd: repoDir,
          stdio: "pipe",
          env: GIT_ENV,
        });
      }

      assert.equal(mergeResult.success, false);
      assert.ok(mergeResult.error);
    });
  });

  describe("fast-forward merge detection", () => {
    it("detects fast-forward merge when base has no new commits", () => {
      createBranch(repoDir, "feature/ff");
      addCommit(repoDir, "ff.txt", "fast forward\n", "ff commit");
      switchBranch(repoDir, "main");

      const output = execSync("git merge feature/ff --ff-only 2>&1", {
        cwd: repoDir,
        encoding: "utf-8",
        stdio: "pipe",
        env: GIT_ENV,
      });

      assert.ok(output.includes("Fast-forward") || output.includes("fast-forward") || output.includes("Updating"));
    });
  });
});

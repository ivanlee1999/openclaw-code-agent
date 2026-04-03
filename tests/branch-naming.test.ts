/**
 * Tests for branch-naming.ts — smart branch name inference from plan output.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";

import { inferBranchName, renameBranch } from "../src/branch-naming";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

function createTmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "branch-naming-test-"));
  execSync("git init -b main", { cwd: dir, stdio: "pipe", env: GIT_ENV });
  writeFileSync(join(dir, "README.md"), "# Test\n");
  execSync("git add -A && git commit -m 'initial'", {
    cwd: dir,
    stdio: "pipe",
    env: GIT_ENV,
  });
  return dir;
}

describe("inferBranchName", () => {
  it("returns undefined for empty plan", () => {
    assert.equal(inferBranchName(""), undefined);
    assert.equal(inferBranchName("  "), undefined);
    assert.equal(inferBranchName("\n\n"), undefined);
  });

  it("returns undefined for very short plan", () => {
    assert.equal(inferBranchName("ok"), undefined);
    assert.equal(inferBranchName("ab"), undefined);
  });

  it("extracts from a Plan: header", () => {
    const plan = "Plan: Add user authentication module\n\n1. Create auth.ts\n2. Add login flow";
    const name = inferBranchName(plan);
    assert.ok(name, "should return a name");
    assert.ok(name.startsWith("feat/"), `expected feat/ prefix, got: ${name}`);
    assert.ok(name.includes("add"), `expected 'add' in name, got: ${name}`);
    assert.ok(name.includes("user"), `expected 'user' in name, got: ${name}`);
    assert.ok(name.includes("authentication"), `expected 'authentication' in name, got: ${name}`);
  });

  it("extracts from a Summary: header", () => {
    const plan = "Summary: Fix null pointer bug in parser module\nThis bug causes a crash when parsing empty input.";
    const name = inferBranchName(plan);
    assert.ok(name, "should return a name");
    assert.ok(name.startsWith("fix/"), `expected fix/ prefix, got: ${name}`);
    assert.ok(name.includes("null"), `expected 'null' in name, got: ${name}`);
  });

  it("uses feat/ prefix for feature-like plans", () => {
    const plan = "We will implement a new dashboard component that displays user metrics and graphs.";
    const name = inferBranchName(plan);
    assert.ok(name, "should return a name");
    assert.ok(name.startsWith("feat/"), `expected feat/ prefix, got: ${name}`);
  });

  it("uses fix/ prefix for bugfix plans", () => {
    const plan = "The bug is in the authentication module. We need to fix the broken token refresh logic and resolve the error handling issue.";
    const name = inferBranchName(plan);
    assert.ok(name, "should return a name");
    assert.ok(name.startsWith("fix/"), `expected fix/ prefix, got: ${name}`);
  });

  it("converts to kebab-case", () => {
    const plan = "Plan: Add User Profile Settings Page\nImplementation details below.";
    const name = inferBranchName(plan);
    assert.ok(name, "should return a name");
    assert.ok(!name.includes(" "), `should not contain spaces: ${name}`);
    assert.ok(!name.includes("_"), `should not contain underscores: ${name}`);
    assert.equal(name, name.toLowerCase(), "should be lowercase");
  });

  it("respects 50 char total limit", () => {
    const plan = "Plan: Implement comprehensive internationalization support with locale detection and automatic translation fallback mechanisms";
    const name = inferBranchName(plan);
    assert.ok(name, "should return a name");
    assert.ok(name.length <= 50, `should be <= 50 chars, got ${name.length}: ${name}`);
  });

  it("handles plans with code blocks", () => {
    const plan = "```\nsome code\n```\nPlan: Refactor the database connection pool for better performance";
    const name = inferBranchName(plan);
    assert.ok(name, "should return a name");
    assert.ok(name.startsWith("feat/"), `expected feat/ prefix, got: ${name}`);
  });

  it("handles plans with markdown headers", () => {
    const plan = "## Implementation Plan\n\nAdd API rate limiting to prevent abuse of the endpoints";
    const name = inferBranchName(plan);
    assert.ok(name, "should return a name");
    assert.ok(name.includes("api") || name.includes("rate") || name.includes("limiting"),
      `expected descriptive name, got: ${name}`);
  });

  it("handles numbered list plans", () => {
    const plan = "1. Read the authentication module\n2. Fix the token validation\n3. Add retry logic for expired tokens";
    const name = inferBranchName(plan);
    assert.ok(name, "should return a name");
  });

  it("handles special characters gracefully", () => {
    const plan = "Plan: Fix the @#$% broken résumé upload & download feature!!!";
    const name = inferBranchName(plan);
    assert.ok(name, "should return a name");
    assert.ok(/^(feat|fix)\/[a-z0-9-]+$/.test(name), `should be valid branch name: ${name}`);
  });

  it("strips stop words for conciseness", () => {
    const plan = "Plan: Add the new user profile settings page to the dashboard";
    const name = inferBranchName(plan);
    assert.ok(name, "should return a name");
    // Stop words like "the", "new", "to" should be stripped
    assert.ok(!name.includes("-the-"), `should not contain 'the': ${name}`);
    assert.ok(!name.includes("-to-"), `should not contain 'to': ${name}`);
  });

  it("falls back to first meaningful line when no header", () => {
    const plan = "We need to implement WebSocket support for real-time notifications.";
    const name = inferBranchName(plan);
    assert.ok(name, "should return a name");
    assert.ok(name.startsWith("feat/"), `expected feat/ prefix, got: ${name}`);
  });

  it("limits to 4 words max in the kebab portion", () => {
    const plan = "Plan: Add user profile settings page component wrapper container handler";
    const name = inferBranchName(plan);
    assert.ok(name, "should return a name");
    // Count hyphens in the description part (after prefix)
    const descPart = name.replace(/^(feat|fix)\//, "");
    const wordCount = descPart.split("-").length;
    assert.ok(wordCount <= 4, `should have <= 4 words, got ${wordCount}: ${descPart}`);
  });
});

describe("renameBranch", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = createTmpRepo();
  });

  afterEach(() => {
    try { rmSync(repoDir, { recursive: true, force: true }); } catch {}
  });

  it("renames a branch successfully", () => {
    // Create a new branch
    execSync("git checkout -b agent/test-branch", {
      cwd: repoDir,
      stdio: "pipe",
      env: GIT_ENV,
    });

    const result = renameBranch(repoDir, "agent/test-branch", "feat/new-name");
    assert.equal(result, true);

    // Verify the branch was renamed
    const currentBranch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: repoDir,
      encoding: "utf-8",
      stdio: "pipe",
      env: GIT_ENV,
    }).trim();
    assert.equal(currentBranch, "feat/new-name");
  });

  it("returns false for non-existent branch", () => {
    const result = renameBranch(repoDir, "nonexistent-branch", "feat/new-name");
    assert.equal(result, false);
  });

  it("returns false for invalid directory", () => {
    const result = renameBranch("/nonexistent/path", "old", "new");
    assert.equal(result, false);
  });
});

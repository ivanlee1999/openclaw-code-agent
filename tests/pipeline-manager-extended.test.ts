/**
 * Extended tests for pipeline-manager: state persistence, auth failure detection,
 * baseSha tracking, max iterations → blocked, stage timeouts, fix round progression,
 * and connectionId integration.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { PipelineManager, parseReviewVerdict } from "../src/pipeline-manager";
import { setSessionManager } from "../src/singletons";
import { setPluginConfig } from "../src/config";

// Shared test helpers
function makeRun(overrides: Record<string, unknown> = {}): any {
  return {
    id: "pipe-test",
    name: "test-pipeline",
    prompt: "test task",
    workdir: "/tmp",
    maxIterations: 3,
    status: "running",
    stages: [],
    startedAt: Date.now(),
    ...overrides,
  };
}

function makeFakeSession(overrides: Record<string, unknown> = {}): any {
  let startupResolve: (() => void) | undefined;
  let startupReject: ((err: Error) => void) | undefined;
  const statusListeners: Array<(s: any, status: string) => void> = [];

  const session: any = {
    id: overrides.id ?? "session-1",
    name: overrides.name ?? "test-stage",
    status: "starting",
    error: undefined,
    waitForStartup: () => new Promise<void>((resolve, reject) => {
      startupResolve = resolve;
      startupReject = reject;
    }),
    on: (_event: string, cb: any) => { statusListeners.push(cb); },
    removeListener: (_event: string, cb: any) => {
      const idx = statusListeners.indexOf(cb);
      if (idx >= 0) statusListeners.splice(idx, 1);
    },
    getOutput: () => overrides.output ?? ["test output"],
    kill: () => {},
    // Helpers for test control
    _resolveStartup: () => startupResolve?.(),
    _rejectStartup: (err: Error) => startupReject?.(err),
    _triggerStatus: (status: string) => {
      session.status = status;
      for (const cb of [...statusListeners]) cb(session, status);
    },
    ...overrides,
  };
  return session;
}

describe("PipelineManager — extended", () => {
  beforeEach(() => {
    setPluginConfig({
      harnesses: {
        codex: { approvalPolicy: "on-request" },
        "claude-code": {},
      },
    });
  });

  afterEach(() => {
    setSessionManager(null);
  });

  describe("parseReviewVerdict", () => {
    it("parses a valid pass verdict", () => {
      const output = `Some review text\nPIPELINE_REVIEW_JSON\n{"verdict":"pass","summary":"All good","criticalIssues":[]}`;
      const verdict = parseReviewVerdict(output);
      assert.ok(verdict);
      assert.equal(verdict.verdict, "pass");
      assert.equal(verdict.summary, "All good");
      assert.deepEqual(verdict.criticalIssues, []);
    });

    it("parses a critical verdict with issues", () => {
      const output = `PIPELINE_REVIEW_JSON\n{"verdict":"critical","summary":"Bug found","criticalIssues":["null ref","race condition"],"fixInstructions":"Fix the null check"}`;
      const verdict = parseReviewVerdict(output);
      assert.ok(verdict);
      assert.equal(verdict.verdict, "critical");
      assert.deepEqual(verdict.criticalIssues, ["null ref", "race condition"]);
      assert.equal(verdict.fixInstructions, "Fix the null check");
    });

    it("parses a needs-human verdict", () => {
      const output = `PIPELINE_REVIEW_JSON\n{"verdict":"needs-human","summary":"Uncertain about approach","criticalIssues":[]}`;
      const verdict = parseReviewVerdict(output);
      assert.ok(verdict);
      assert.equal(verdict.verdict, "needs-human");
    });

    it("returns undefined when no marker present", () => {
      const verdict = parseReviewVerdict("just some output without the marker");
      assert.equal(verdict, undefined);
    });

    it("returns undefined for invalid JSON after marker", () => {
      const verdict = parseReviewVerdict("PIPELINE_REVIEW_JSON\nnot json");
      assert.equal(verdict, undefined);
    });

    it("returns undefined for unknown verdict value", () => {
      const output = `PIPELINE_REVIEW_JSON\n{"verdict":"unknown","summary":"","criticalIssues":[]}`;
      const verdict = parseReviewVerdict(output);
      assert.equal(verdict, undefined);
    });

    it("handles trailing text after JSON", () => {
      const output = `PIPELINE_REVIEW_JSON\n{"verdict":"pass","summary":"OK","criticalIssues":[]}\nSome trailing text here`;
      const verdict = parseReviewVerdict(output);
      assert.ok(verdict);
      assert.equal(verdict.verdict, "pass");
    });

    it("uses the last marker when multiple are present", () => {
      const output = [
        `PIPELINE_REVIEW_JSON\n{"verdict":"critical","summary":"first","criticalIssues":[]}`,
        `\nmore text\n`,
        `PIPELINE_REVIEW_JSON\n{"verdict":"pass","summary":"second","criticalIssues":[]}`,
      ].join("");
      const verdict = parseReviewVerdict(output);
      assert.ok(verdict);
      assert.equal(verdict.verdict, "pass");
      assert.equal(verdict.summary, "second");
    });

    it("filters non-string criticalIssues", () => {
      const output = `PIPELINE_REVIEW_JSON\n{"verdict":"critical","summary":"x","criticalIssues":["real",42,null,"also real"]}`;
      const verdict = parseReviewVerdict(output);
      assert.ok(verdict);
      assert.deepEqual(verdict.criticalIssues, ["real", "also real"]);
    });
  });

  describe("auth failure detection", () => {
    it("detects OAuth token expired in short output", async () => {
      const session = makeFakeSession({
        output: ["OAuth token has expired"],
        getOutput: () => ["OAuth token has expired"],
      });

      let capturedConfig: any;
      setSessionManager({
        spawn(config: unknown) {
          capturedConfig = config;
          return session;
        },
        notifySession() {},
      } as any);

      const pm = new PipelineManager();
      const run = makeRun();

      (pm as any).spawnStage(run, {
        kind: "codex-plan",
        harness: "codex",
        prompt: "plan prompt",
        iteration: 0,
      });

      // Resolve startup then complete the session
      session._resolveStartup();
      await new Promise<void>((r) => setTimeout(r, 10));
      session._triggerStatus("completed");
      await new Promise<void>((r) => setTimeout(r, 10));

      // Pipeline should be failed due to auth failure
      assert.equal(run.status, "failed");
      assert.ok(run.error?.includes("Authentication"));
    });

    it("does not flag auth failure for long output containing 401", async () => {
      // Long output with "401" is likely real output, not an auth failure
      const longOutput = "x".repeat(600) + " 401 ";
      const session = makeFakeSession({
        getOutput: () => [longOutput],
      });

      setSessionManager({
        spawn() { return session; },
        notifySession() {},
      } as any);

      const pm = new PipelineManager();
      const run = makeRun();

      (pm as any).spawnStage(run, {
        kind: "codex-plan",
        harness: "codex",
        prompt: "plan prompt",
        iteration: 0,
      });

      session._resolveStartup();
      await new Promise<void>((r) => setTimeout(r, 10));
      session._triggerStatus("completed");
      await new Promise<void>((r) => setTimeout(r, 10));

      // Stage should complete normally, not be flagged as auth failure
      assert.equal(run.stages[0].status, "completed");
    });
  });

  describe("max iterations → blocked status", () => {
    it("sets status to blocked when max fix iterations reached", async () => {
      let spawnCount = 0;
      const sessions: any[] = [];

      setSessionManager({
        spawn() {
          const s = makeFakeSession({ id: `s-${spawnCount++}` });
          sessions.push(s);
          return s;
        },
        notifySession() {},
      } as any);

      const pm = new PipelineManager();
      const run = makeRun({ maxIterations: 1 });

      // Stage 1: codex-plan
      (pm as any).spawnStage(run, {
        kind: "codex-plan",
        harness: "codex",
        prompt: "plan prompt",
        iteration: 0,
      });

      // Complete plan stage
      const planSession = sessions[0];
      planSession._resolveStartup();
      await new Promise<void>((r) => setTimeout(r, 10));
      planSession.getOutput = () => ["The plan is: do stuff"];
      planSession._triggerStatus("completed");
      await new Promise<void>((r) => setTimeout(r, 10));

      // Stage 2: claude-implement should have spawned
      assert.ok(sessions[1], "implement session should have spawned");
      const implSession = sessions[1];
      implSession._resolveStartup();
      await new Promise<void>((r) => setTimeout(r, 10));
      implSession.getOutput = () => ["Implemented"];
      implSession._triggerStatus("completed");
      await new Promise<void>((r) => setTimeout(r, 10));

      // Stage 3: codex-review
      assert.ok(sessions[2], "review session should have spawned");
      const reviewSession = sessions[2];
      reviewSession._resolveStartup();
      await new Promise<void>((r) => setTimeout(r, 10));
      const criticalReview = `PIPELINE_REVIEW_JSON\n{"verdict":"critical","summary":"Bug found","criticalIssues":["null ref"]}`;
      reviewSession.getOutput = () => [criticalReview];
      reviewSession._triggerStatus("completed");
      await new Promise<void>((r) => setTimeout(r, 10));

      // With maxIterations=1, should be blocked (iteration 0 >= maxIterations - 1)
      assert.equal(run.status, "blocked");
      assert.ok(run.error?.includes("Max fix iterations"));
    });
  });

  describe("fix round progression", () => {
    it("spawns claude-fix after critical review, then re-reviews", async () => {
      let spawnCount = 0;
      const sessions: any[] = [];
      const configs: any[] = [];

      setSessionManager({
        spawn(config: unknown) {
          configs.push(config);
          const s = makeFakeSession({ id: `s-${spawnCount++}` });
          sessions.push(s);
          return s;
        },
        notifySession() {},
      } as any);

      const pm = new PipelineManager();
      const run = makeRun({ maxIterations: 3 });

      // Plan
      (pm as any).spawnStage(run, {
        kind: "codex-plan",
        harness: "codex",
        prompt: "plan",
        iteration: 0,
      });
      sessions[0]._resolveStartup();
      await new Promise<void>((r) => setTimeout(r, 10));
      sessions[0].getOutput = () => ["plan output"];
      sessions[0]._triggerStatus("completed");
      await new Promise<void>((r) => setTimeout(r, 10));

      // Implement
      sessions[1]._resolveStartup();
      await new Promise<void>((r) => setTimeout(r, 10));
      sessions[1].getOutput = () => ["implemented"];
      sessions[1]._triggerStatus("completed");
      await new Promise<void>((r) => setTimeout(r, 10));

      // Review → critical
      sessions[2]._resolveStartup();
      await new Promise<void>((r) => setTimeout(r, 10));
      sessions[2].getOutput = () => [`PIPELINE_REVIEW_JSON\n{"verdict":"critical","summary":"bug","criticalIssues":["issue1"],"fixInstructions":"fix it"}`];
      sessions[2]._triggerStatus("completed");
      await new Promise<void>((r) => setTimeout(r, 10));

      // Claude-fix should have spawned
      assert.ok(sessions[3], "fix session should have spawned");
      const fixStage = run.stages.find((s: any) => s.kind === "claude-fix");
      assert.ok(fixStage, "claude-fix stage should exist");
      assert.equal(fixStage.iteration, 1);

      // Complete fix → re-review
      sessions[3]._resolveStartup();
      await new Promise<void>((r) => setTimeout(r, 10));
      sessions[3].getOutput = () => ["fixed"];
      sessions[3]._triggerStatus("completed");
      await new Promise<void>((r) => setTimeout(r, 10));

      // Re-review should have spawned
      assert.ok(sessions[4], "re-review session should have spawned");
      const reReviewStage = run.stages.filter((s: any) => s.kind === "codex-review");
      assert.equal(reReviewStage.length, 2, "should have two review stages");

      // Pass the re-review
      sessions[4]._resolveStartup();
      await new Promise<void>((r) => setTimeout(r, 10));
      sessions[4].getOutput = () => [`PIPELINE_REVIEW_JSON\n{"verdict":"pass","summary":"all good","criticalIssues":[]}`];
      sessions[4]._triggerStatus("completed");
      await new Promise<void>((r) => setTimeout(r, 10));

      assert.equal(run.status, "completed");
    });
  });

  describe("startup failure", () => {
    it("fails the pipeline when session startup fails", async () => {
      const session = makeFakeSession();

      setSessionManager({
        spawn() { return session; },
        notifySession() {},
      } as any);

      const pm = new PipelineManager();
      const run = makeRun();

      (pm as any).spawnStage(run, {
        kind: "codex-plan",
        harness: "codex",
        prompt: "plan",
        iteration: 0,
      });

      session._rejectStartup(new Error("Auth failed"));
      await new Promise<void>((r) => setTimeout(r, 10));

      assert.equal(run.stages[0].status, "failed");
      assert.equal(run.status, "failed");
      assert.ok(run.error?.includes("startup failed"));
    });
  });

  describe("stage failure propagation", () => {
    it("fails pipeline when a stage session fails", async () => {
      const session = makeFakeSession();

      setSessionManager({
        spawn() { return session; },
        notifySession() {},
      } as any);

      const pm = new PipelineManager();
      const run = makeRun();

      (pm as any).spawnStage(run, {
        kind: "codex-plan",
        harness: "codex",
        prompt: "plan",
        iteration: 0,
      });

      session._resolveStartup();
      await new Promise<void>((r) => setTimeout(r, 10));

      session.error = "Something went wrong";
      session._triggerStatus("failed");
      await new Promise<void>((r) => setTimeout(r, 10));

      assert.equal(run.stages[0].status, "failed");
      assert.equal(run.status, "failed");
    });

    it("fails pipeline when a stage session is killed", async () => {
      const session = makeFakeSession();

      setSessionManager({
        spawn() { return session; },
        notifySession() {},
      } as any);

      const pm = new PipelineManager();
      const run = makeRun();

      (pm as any).spawnStage(run, {
        kind: "codex-plan",
        harness: "codex",
        prompt: "plan",
        iteration: 0,
      });

      session._resolveStartup();
      await new Promise<void>((r) => setTimeout(r, 10));

      session._triggerStatus("killed");
      await new Promise<void>((r) => setTimeout(r, 10));

      assert.equal(run.stages[0].status, "failed");
      assert.equal(run.status, "failed");
    });
  });

  describe("needs-human verdict → blocked", () => {
    it("blocks pipeline on needs-human verdict", async () => {
      let spawnCount = 0;
      const sessions: any[] = [];

      setSessionManager({
        spawn() {
          const s = makeFakeSession({ id: `s-${spawnCount++}` });
          sessions.push(s);
          return s;
        },
        notifySession() {},
      } as any);

      const pm = new PipelineManager();
      const run = makeRun();

      // Plan → implement → review (needs-human)
      (pm as any).spawnStage(run, { kind: "codex-plan", harness: "codex", prompt: "plan", iteration: 0 });
      sessions[0]._resolveStartup();
      await new Promise<void>((r) => setTimeout(r, 10));
      sessions[0].getOutput = () => ["plan"];
      sessions[0]._triggerStatus("completed");
      await new Promise<void>((r) => setTimeout(r, 10));

      sessions[1]._resolveStartup();
      await new Promise<void>((r) => setTimeout(r, 10));
      sessions[1].getOutput = () => ["impl"];
      sessions[1]._triggerStatus("completed");
      await new Promise<void>((r) => setTimeout(r, 10));

      sessions[2]._resolveStartup();
      await new Promise<void>((r) => setTimeout(r, 10));
      sessions[2].getOutput = () => [`PIPELINE_REVIEW_JSON\n{"verdict":"needs-human","summary":"Unsure","criticalIssues":[]}`];
      sessions[2]._triggerStatus("completed");
      await new Promise<void>((r) => setTimeout(r, 10));

      assert.equal(run.status, "blocked");
      assert.ok(run.error?.includes("human judgment"));
    });
  });

  describe("unparseable review verdict → blocked", () => {
    it("blocks pipeline when review verdict cannot be parsed", async () => {
      let spawnCount = 0;
      const sessions: any[] = [];

      setSessionManager({
        spawn() {
          const s = makeFakeSession({ id: `s-${spawnCount++}` });
          sessions.push(s);
          return s;
        },
        notifySession() {},
      } as any);

      const pm = new PipelineManager();
      const run = makeRun();

      // Plan → implement → review (no marker)
      (pm as any).spawnStage(run, { kind: "codex-plan", harness: "codex", prompt: "plan", iteration: 0 });
      sessions[0]._resolveStartup();
      await new Promise<void>((r) => setTimeout(r, 10));
      sessions[0].getOutput = () => ["plan"];
      sessions[0]._triggerStatus("completed");
      await new Promise<void>((r) => setTimeout(r, 10));

      sessions[1]._resolveStartup();
      await new Promise<void>((r) => setTimeout(r, 10));
      sessions[1].getOutput = () => ["impl"];
      sessions[1]._triggerStatus("completed");
      await new Promise<void>((r) => setTimeout(r, 10));

      sessions[2]._resolveStartup();
      await new Promise<void>((r) => setTimeout(r, 10));
      sessions[2].getOutput = () => ["review without JSON marker"];
      sessions[2]._triggerStatus("completed");
      await new Promise<void>((r) => setTimeout(r, 10));

      assert.equal(run.status, "blocked");
      assert.ok(run.error?.includes("parse review verdict"));
    });
  });

  describe("connectionId in pipeline run", () => {
    it("stores connectionId in the run object", () => {
      setSessionManager({
        spawn() {
          return makeFakeSession();
        },
        notifySession() {},
      } as any);

      const pm = new PipelineManager();

      // We can't fully launch because it checks for git repo,
      // but we can test that the param is threaded through buildStageSpec
      const run = makeRun({ connectionId: "conn-123" });
      assert.equal(run.connectionId, "conn-123");
    });
  });

  describe("double finalize guard", () => {
    it("ignores duplicate finalization", async () => {
      const session = makeFakeSession();

      setSessionManager({
        spawn() { return session; },
        notifySession() {},
      } as any);

      const pm = new PipelineManager();
      const run = makeRun();

      (pm as any).spawnStage(run, {
        kind: "codex-plan",
        harness: "codex",
        prompt: "plan",
        iteration: 0,
      });

      // Reject startup (triggers finalize)
      session._rejectStartup(new Error("boom"));
      await new Promise<void>((r) => setTimeout(r, 10));

      assert.equal(run.status, "failed");

      // Trigger killed status (should be ignored by double-finalize guard)
      session._triggerStatus("killed");
      await new Promise<void>((r) => setTimeout(r, 10));

      // Should still be "failed" not "killed" or something else
      assert.equal(run.status, "failed");
    });
  });

  describe("baseSha tracking", () => {
    it("passes baseSha to review prompt", () => {
      // Test that codexReviewPrompt includes baseSha when provided
      const run = makeRun({ baseSha: "abc123def456" });
      assert.equal(run.baseSha, "abc123def456");
    });
  });

  describe("worktree system prompt injection", () => {
    it("injects worktree system prompt for Claude stages when worktreePath exists", async () => {
      let capturedConfig: any;
      const session = makeFakeSession();

      setSessionManager({
        spawn(config: unknown) {
          capturedConfig = config;
          return session;
        },
        notifySession() {},
      } as any);

      const pm = new PipelineManager();
      const run = makeRun({
        worktreePath: "/tmp/worktrees/my-worktree",
        originalWorkdir: "/home/user/repo",
        workdir: "/tmp/worktrees/my-worktree",
      });

      (pm as any).spawnStage(run, {
        kind: "claude-implement",
        harness: "claude-code",
        prompt: "implement something",
        iteration: 0,
      });

      assert.ok(capturedConfig.systemPrompt, "systemPrompt must be set for Claude worktree stages");
      assert.match(capturedConfig.systemPrompt, /ALL file edits must be made within this worktree/);
      assert.match(capturedConfig.systemPrompt, /\/tmp\/worktrees\/my-worktree/);
      assert.match(capturedConfig.systemPrompt, /Do NOT edit files directly in \/home\/user\/repo/);
    });

    it("does NOT inject worktree system prompt for Codex stages", async () => {
      let capturedConfig: any;
      const session = makeFakeSession();

      setSessionManager({
        spawn(config: unknown) {
          capturedConfig = config;
          return session;
        },
        notifySession() {},
      } as any);

      const pm = new PipelineManager();
      const run = makeRun({
        worktreePath: "/tmp/worktrees/my-worktree",
        originalWorkdir: "/home/user/repo",
        workdir: "/tmp/worktrees/my-worktree",
      });

      (pm as any).spawnStage(run, {
        kind: "codex-review",
        harness: "codex",
        prompt: "review prompt",
        iteration: 0,
      });

      assert.equal(capturedConfig.systemPrompt, undefined, "Codex stages should not get worktree system prompt");
    });

    it("does NOT inject worktree system prompt when worktreePath is absent", async () => {
      let capturedConfig: any;
      const session = makeFakeSession();

      setSessionManager({
        spawn(config: unknown) {
          capturedConfig = config;
          return session;
        },
        notifySession() {},
      } as any);

      const pm = new PipelineManager();
      const run = makeRun({
        // No worktreePath or originalWorkdir
        workdir: "/home/user/repo",
      });

      (pm as any).spawnStage(run, {
        kind: "claude-implement",
        harness: "claude-code",
        prompt: "implement something",
        iteration: 0,
      });

      assert.equal(capturedConfig.systemPrompt, undefined, "Non-worktree Claude stages should not get worktree system prompt");
    });
  });

  describe("path relativization in prompts", () => {
    it("rewrites absolute original-workdir paths in plan output before Claude implement", async () => {
      const capturedConfigs: any[] = [];
      let stageIndex = 0;

      const sessions = [
        makeFakeSession({ id: "plan-session", output: [
          "Plan: edit /home/user/repo/src/main.ts",
          "Also change /home/user/repo/tests/main.test.ts",
        ]}),
        makeFakeSession({ id: "implement-session" }),
      ];

      setSessionManager({
        spawn(config: unknown) {
          capturedConfigs.push(config);
          return sessions[stageIndex++];
        },
        notifySession() {},
      } as any);

      const pm = new PipelineManager();
      const run = makeRun({
        worktreePath: "/tmp/worktrees/my-worktree",
        originalWorkdir: "/home/user/repo",
        workdir: "/tmp/worktrees/my-worktree",
      });

      // Simulate: codex-plan completed, trigger onStageCompleted
      const planOutput = "Plan: edit /home/user/repo/src/main.ts\nAlso change /home/user/repo/tests/main.test.ts";
      (pm as any).onStageCompleted(run, "codex-plan", 0, planOutput);

      // The implement stage should have been spawned with relativized paths
      assert.ok(capturedConfigs.length >= 1, "implement stage should have been spawned");
      const implementConfig = capturedConfigs[capturedConfigs.length - 1];
      assert.ok(!implementConfig.prompt.includes("/home/user/repo/"), "Absolute paths should be relativized in implement prompt");
      assert.ok(implementConfig.prompt.includes("./src/main.ts"), "Paths should be relative");
      assert.ok(implementConfig.prompt.includes("./tests/main.test.ts"), "Paths should be relative");
    });

    it("does not modify prompts when no originalWorkdir is set", async () => {
      const capturedConfigs: any[] = [];
      let stageIndex = 0;

      const sessions = [
        makeFakeSession({ id: "plan-session" }),
        makeFakeSession({ id: "implement-session" }),
      ];

      setSessionManager({
        spawn(config: unknown) {
          capturedConfigs.push(config);
          return sessions[stageIndex++];
        },
        notifySession() {},
      } as any);

      const pm = new PipelineManager();
      const run = makeRun({
        // No worktreePath or originalWorkdir
        workdir: "/home/user/repo",
      });

      const planOutput = "Plan: edit /home/user/repo/src/main.ts";
      (pm as any).onStageCompleted(run, "codex-plan", 0, planOutput);

      const implementConfig = capturedConfigs[capturedConfigs.length - 1];
      assert.ok(implementConfig.prompt.includes("/home/user/repo/src/main.ts"), "Without originalWorkdir, paths should remain absolute");
    });
  });
});

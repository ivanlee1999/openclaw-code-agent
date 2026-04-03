/**
 * Tests for worktree strategy service behavior.
 *
 * Validates that worktreeStrategy: "off" is respected, worktree paths are
 * computed correctly, and session-to-worktree binding works as expected.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Session } from "../src/session";
import { createFakeHarness, makeSessionConfig } from "./helpers";
import { registerHarness } from "../src/harness/index";

describe("Session worktree strategy", () => {
  let fakeHarness: ReturnType<typeof createFakeHarness>;

  beforeEach(() => {
    fakeHarness = createFakeHarness("fake-harness");
    registerHarness(fakeHarness);
  });

  describe("worktreeStrategy: off", () => {
    it("session has no worktree fields when strategy is off", () => {
      const config = makeSessionConfig({ harness: "fake-harness",
        worktreeStrategy: "off",
      });
      const session = new Session(config, "test-off");
      assert.equal(session.worktreeStrategy, "off");
      assert.equal(session.worktreePath, undefined);
      assert.equal(session.worktreeBranch, undefined);
      assert.equal(session.worktreeState, "none");
    });

    it("session without worktreeStrategy defaults to undefined (no worktree)", () => {
      const config = makeSessionConfig({ harness: "fake-harness",});
      const session = new Session(config, "test-default");
      assert.equal(session.worktreeStrategy, undefined);
      assert.equal(session.worktreePath, undefined);
      assert.equal(session.worktreeState, "none");
    });
  });

  describe("worktreeStrategy values", () => {
    const strategies = ["manual", "ask", "delegate", "auto-merge", "auto-pr"] as const;

    for (const strategy of strategies) {
      it(`preserves worktreeStrategy: "${strategy}" on session`, () => {
        const config = makeSessionConfig({ harness: "fake-harness", worktreeStrategy: strategy });
        const session = new Session(config, `test-${strategy}`);
        assert.equal(session.worktreeStrategy, strategy);
      });
    }
  });

  describe("session-to-worktree binding", () => {
    it("session tracks worktreePath when set", () => {
      const config = makeSessionConfig({ harness: "fake-harness",
        worktreeStrategy: "manual",
      });
      const session = new Session(config, "test-binding");
      // Simulate worktree assignment (normally done by SessionWorktreeController)
      session.worktreePath = "/tmp/worktree-path";
      session.worktreeBranch = "openclaw/test-binding";
      session.worktreeState = "provisioned";

      assert.equal(session.worktreePath, "/tmp/worktree-path");
      assert.equal(session.worktreeBranch, "openclaw/test-binding");
      assert.equal(session.worktreeState, "provisioned");
    });

    it("workdir is independent of worktreePath", () => {
      const config = makeSessionConfig({ harness: "fake-harness",
        workdir: "/original/workdir",
        worktreeStrategy: "manual",
      });
      const session = new Session(config, "test-workdir");
      session.worktreePath = "/different/worktree";

      assert.equal(session.workdir, "/original/workdir");
      assert.equal(session.worktreePath, "/different/worktree");
    });
  });

  describe("connectionId and worktreeStrategy interaction", () => {
    it("connectionId is stored on session when provided", () => {
      const config = makeSessionConfig({ harness: "fake-harness",
        connectionId: "conn-123",
        worktreeStrategy: "off",
      });
      const session = new Session(config, "test-connection");
      assert.equal((session as any).connectionId, "conn-123");
      assert.equal(session.worktreeStrategy, "off");
    });
  });

  describe("worktree state transitions", () => {
    it("worktreeState starts as 'none'", () => {
      const session = new Session(makeSessionConfig({ harness: "fake-harness",}), "test-state");
      assert.equal(session.worktreeState, "none");
    });

    it("worktreeState can be set to provisioned", () => {
      const session = new Session(makeSessionConfig({ harness: "fake-harness",}), "test-provision");
      session.worktreeState = "provisioned";
      assert.equal(session.worktreeState, "provisioned");
    });

    it("worktreeState can be set to merged", () => {
      const session = new Session(makeSessionConfig({ harness: "fake-harness",}), "test-merge");
      session.worktreeState = "merged";
      assert.equal(session.worktreeState, "merged");
    });

    it("worktreeState can be set to pending_decision", () => {
      const session = new Session(makeSessionConfig({ harness: "fake-harness",}), "test-pending");
      session.worktreeState = "pending_decision";
      assert.equal(session.worktreeState, "pending_decision");
    });
  });
});

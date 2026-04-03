import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { TaskrClient } from "../src/taskr-integration";

// ---------------------------------------------------------------------------
// Helpers — intercept global fetch to mock Taskr HTTP calls
// ---------------------------------------------------------------------------

type FetchFn = typeof globalThis.fetch;

interface CapturedCall {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

let originalFetch: FetchFn;
let captured: CapturedCall[];
let mockResponse: { status: number; body: unknown } | "network-error";

function installMockFetch(): void {
  originalFetch = globalThis.fetch;
  captured = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    captured.push({ url, init: init || {}, body });

    if (mockResponse === "network-error") {
      throw new Error("fetch failed: ECONNREFUSED");
    }

    return {
      ok: mockResponse.status >= 200 && mockResponse.status < 300,
      status: mockResponse.status,
      text: async () => JSON.stringify(mockResponse.body),
      json: async () => mockResponse.body,
    } as Response;
  }) as FetchFn;
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TaskrClient", () => {
  beforeEach(() => {
    installMockFetch();
    // Set env vars so the client is enabled
    process.env.TASKR_API_KEY = "test-key-123";
    process.env.TASKR_PROJECT_ID = "PR_TEST";
    process.env.TASKR_API_URL = "https://taskr.test/api/mcp";
  });

  afterEach(() => {
    restoreFetch();
    delete process.env.TASKR_API_KEY;
    delete process.env.TASKR_PROJECT_ID;
    delete process.env.TASKR_API_URL;
  });

  describe("createPipelineTaskList", () => {
    it("sends correct JSON-RPC payload with task structure", async () => {
      mockResponse = {
        status: 200,
        body: {
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  taskListId: "TL_001",
                  tasks: [
                    { id: "TSK_PLAN", title: "Plan (Codex)" },
                    { id: "TSK_IMPL", title: "Implement (Claude Code)" },
                    { id: "TSK_REV", title: "Review (Codex)" },
                  ],
                }),
              },
            ],
          },
        },
      };

      const client = new TaskrClient();
      const ids = await client.createPipelineTaskList("pipeline-test", "fix the auth bug");

      // Verify we made exactly one call
      assert.equal(captured.length, 1);

      // Verify URL and headers
      assert.equal(captured[0].url, "https://taskr.test/api/mcp");
      const headers = captured[0].init.headers as Record<string, string>;
      assert.equal(headers["x-project-id"], "PR_TEST");
      assert.equal(headers["x-user-api-key"], "test-key-123");

      // Verify JSON-RPC structure
      const body = captured[0].body;
      assert.equal(body.jsonrpc, "2.0");
      assert.equal(body.method, "tools/call");
      const params = body.params as { name: string; arguments: Record<string, unknown> };
      assert.equal(params.name, "create_task");
      assert.equal(params.arguments.taskListTitle, "Pipeline: pipeline-test");

      const tasks = params.arguments.tasks as Array<{ hierarchy: string; title: string }>;
      assert.equal(tasks.length, 3);
      assert.equal(tasks[0].title, "Plan (Codex)");
      assert.equal(tasks[1].title, "Implement (Claude Code)");
      assert.equal(tasks[2].title, "Review (Codex)");

      // Verify extracted IDs
      assert.equal(ids.listId, "TL_001");
      assert.equal(ids.plan, "TSK_PLAN");
      assert.equal(ids.implement, "TSK_IMPL");
      assert.equal(ids.review, "TSK_REV");
    });

    it("returns empty IDs when API returns non-parseable response", async () => {
      mockResponse = {
        status: 200,
        body: {
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: "OK" }] },
        },
      };

      const client = new TaskrClient();
      const ids = await client.createPipelineTaskList("test", "task");

      assert.equal(captured.length, 1);
      assert.deepEqual(ids.fixes, {});
      // No crash — graceful handling
    });
  });

  describe("updateStageStatus", () => {
    it("sends update_task with correct status", async () => {
      mockResponse = {
        status: 200,
        body: { jsonrpc: "2.0", id: 1, result: { content: [] } },
      };

      const client = new TaskrClient();
      await client.updateStageStatus("TSK_123", "wip");

      assert.equal(captured.length, 1);
      const params = captured[0].body.params as { name: string; arguments: Record<string, unknown> };
      assert.equal(params.name, "update_task");
      assert.equal(params.arguments.taskId, "TSK_123");
      assert.equal(params.arguments.status, "wip");
      assert.equal(params.arguments.ruleContext, "RU-PROC-001");
    });

    it("skips call when taskId is empty", async () => {
      mockResponse = {
        status: 200,
        body: { jsonrpc: "2.0", id: 1, result: { content: [] } },
      };

      const client = new TaskrClient();
      await client.updateStageStatus("", "done");

      assert.equal(captured.length, 0);
    });
  });

  describe("addStageNote", () => {
    it("sends create_note with correct structure", async () => {
      mockResponse = {
        status: 200,
        body: { jsonrpc: "2.0", id: 1, result: { content: [] } },
      };

      const client = new TaskrClient();
      await client.addStageNote("TSK_456", "Review passed", "All checks OK");

      assert.equal(captured.length, 1);
      const params = captured[0].body.params as { name: string; arguments: Record<string, unknown> };
      assert.equal(params.name, "create_note");
      assert.equal(params.arguments.type, "PROGRESS");
      assert.equal(params.arguments.title, "Review passed");
      assert.equal(params.arguments.body, "All checks OK");
      assert.equal(params.arguments.taskId, "TSK_456");
      assert.equal(params.arguments.ruleContext, "RU-NOTE-001");
    });

    it("skips call when taskId is empty", async () => {
      mockResponse = {
        status: 200,
        body: { jsonrpc: "2.0", id: 1, result: { content: [] } },
      };

      const client = new TaskrClient();
      await client.addStageNote("", "title", "body");

      assert.equal(captured.length, 0);
    });
  });

  describe("graceful failure", () => {
    it("does not throw on network error (createPipelineTaskList)", async () => {
      mockResponse = "network-error";

      const client = new TaskrClient();
      const ids = await client.createPipelineTaskList("test-pipe", "do stuff");

      // Should return empty IDs, no throw
      assert.deepEqual(ids.fixes, {});
      assert.equal(ids.plan, undefined);
    });

    it("does not throw on network error (updateStageStatus)", async () => {
      mockResponse = "network-error";

      const client = new TaskrClient();
      // Should not throw
      await client.updateStageStatus("TSK_999", "done");
    });

    it("does not throw on network error (addStageNote)", async () => {
      mockResponse = "network-error";

      const client = new TaskrClient();
      // Should not throw
      await client.addStageNote("TSK_999", "note", "body");
    });

    it("does not throw on HTTP 500", async () => {
      mockResponse = { status: 500, body: { error: "Internal server error" } };

      const client = new TaskrClient();
      const ids = await client.createPipelineTaskList("test-pipe", "task");

      // No crash, empty IDs
      assert.deepEqual(ids.fixes, {});
    });

    it("does not throw on HTTP 401", async () => {
      mockResponse = { status: 401, body: { error: "Unauthorized" } };

      const client = new TaskrClient();
      await client.updateStageStatus("TSK_001", "wip");
      // No crash
      assert.equal(captured.length, 1);
    });
  });

  describe("disabled when no API key", () => {
    it("skips all calls when TASKR_API_KEY is empty", async () => {
      process.env.TASKR_API_KEY = "";
      mockResponse = {
        status: 200,
        body: { jsonrpc: "2.0", id: 1, result: { content: [] } },
      };

      const client = new TaskrClient();
      const ids = await client.createPipelineTaskList("test", "task");
      await client.updateStageStatus("TSK_1", "wip");
      await client.addStageNote("TSK_1", "t", "b");

      assert.equal(captured.length, 0);
      assert.deepEqual(ids.fixes, {});
    });
  });
});

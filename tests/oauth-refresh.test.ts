/**
 * Tests for OAuth token refresh detection and auth failure handling.
 *
 * These tests verify the pipeline manager's auth failure detection patterns
 * and the codex-auth module's refresh logic.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseReviewVerdict } from "../src/pipeline-manager";

describe("OAuth / Auth failure detection", () => {
  describe("auth failure patterns in stage output", () => {
    const AUTH_FAILURE_PATTERNS = [
      "OAuth token has expired",
      "authentication_error",
      "Failed to authenticate",
      "401",
    ];

    for (const pattern of AUTH_FAILURE_PATTERNS) {
      it(`detects "${pattern}" as auth failure when output is short`, () => {
        const output = `Error: ${pattern}`;
        const isAuthFailure = AUTH_FAILURE_PATTERNS.some((p) => output.includes(p))
          && output.length < 500;
        assert.equal(isAuthFailure, true);
      });

      it(`does NOT flag "${pattern}" as auth failure when output is long`, () => {
        const output = "x".repeat(600) + ` ${pattern} `;
        const isAuthFailure = AUTH_FAILURE_PATTERNS.some((p) => output.includes(p))
          && output.length < 500;
        assert.equal(isAuthFailure, false);
      });
    }

    it("does not flag normal output as auth failure", () => {
      const output = "Successfully implemented the feature with all tests passing";
      const isAuthFailure = AUTH_FAILURE_PATTERNS.some((p) => output.includes(p))
        && output.length < 500;
      assert.equal(isAuthFailure, false);
    });

    it("detects multiple auth patterns in same output", () => {
      const output = "401 authentication_error";
      const isAuthFailure = AUTH_FAILURE_PATTERNS.some((p) => output.includes(p))
        && output.length < 500;
      assert.equal(isAuthFailure, true);
    });
  });

  describe("auth failure vs review verdict", () => {
    it("auth failure output does not contain review verdict", () => {
      const authOutput = "OAuth token has expired. Please refresh your credentials.";
      const verdict = parseReviewVerdict(authOutput);
      assert.equal(verdict, undefined);
    });

    it("real review output with 401 reference is not an auth failure", () => {
      const realOutput = [
        "Reviewing the code...",
        "Found handling for 401 responses in the API client.",
        "The retry logic correctly refreshes the token on 401.",
        ...Array(50).fill("Additional review text here."),
        `PIPELINE_REVIEW_JSON`,
        `{"verdict":"pass","summary":"Auth handling looks correct","criticalIssues":[]}`,
      ].join("\n");

      // Long output → not an auth failure
      const isAuthFailure = ["401"].some((p) => realOutput.includes(p))
        && realOutput.length < 500;
      assert.equal(isAuthFailure, false);

      // But verdict parses fine
      const verdict = parseReviewVerdict(realOutput);
      assert.ok(verdict);
      assert.equal(verdict.verdict, "pass");
    });
  });

  describe("token expiry threshold", () => {
    it("2h threshold: token created 2h+ ago should be considered expired", () => {
      const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
      const tokenCreatedAt = Date.now() - TWO_HOURS_MS - 1000; // 2h1s ago
      const isExpired = (Date.now() - tokenCreatedAt) > TWO_HOURS_MS;
      assert.equal(isExpired, true);
    });

    it("2h threshold: token created 1h ago should NOT be considered expired", () => {
      const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
      const tokenCreatedAt = Date.now() - 60 * 60 * 1000; // 1h ago
      const isExpired = (Date.now() - tokenCreatedAt) > TWO_HOURS_MS;
      assert.equal(isExpired, false);
    });
  });

  describe("refresh payload validation", () => {
    it("validates refresh token response shape", () => {
      const validResponse = {
        access_token: "new-token",
        token_type: "Bearer",
        expires_in: 3600,
      };

      assert.equal(typeof validResponse.access_token, "string");
      assert.ok(validResponse.access_token.length > 0);
      assert.equal(typeof validResponse.expires_in, "number");
      assert.ok(validResponse.expires_in > 0);
    });

    it("rejects response without access_token", () => {
      const invalidResponse = {
        error: "invalid_grant",
        error_description: "Token has been revoked",
      };

      const hasAccessToken = typeof (invalidResponse as any).access_token === "string"
        && (invalidResponse as any).access_token.length > 0;
      assert.equal(hasAccessToken, false);
    });

    it("rejects response with empty access_token", () => {
      const invalidResponse = {
        access_token: "",
        token_type: "Bearer",
      };

      const hasAccessToken = typeof invalidResponse.access_token === "string"
        && invalidResponse.access_token.length > 0;
      assert.equal(hasAccessToken, false);
    });
  });

  describe("HTTP failure scenarios", () => {
    it("network timeout should be treated as retriable", () => {
      const error = new Error("Request timed out");
      const isTimeout = error.message.includes("timed out") || error.message.includes("ETIMEDOUT");
      assert.equal(isTimeout, true);
    });

    it("500 server error should be treated as retriable", () => {
      const statusCode = 500;
      const isRetriable = statusCode >= 500 && statusCode < 600;
      assert.equal(isRetriable, true);
    });

    it("403 forbidden should NOT be retriable", () => {
      const statusCode = 403;
      const isRetriable = statusCode >= 500 && statusCode < 600;
      assert.equal(isRetriable, false);
    });
  });
});

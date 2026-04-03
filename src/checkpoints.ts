/**
 * Git-based checkpoint manager for pipeline sessions.
 *
 * Creates lightweight git tags as checkpoints at key pipeline stages,
 * allowing users to roll back to any previous save point.
 *
 * Tag format: `checkpoint/<sessionId>/<timestamp>[-<label>]`
 *
 * @module checkpoints
 */

import { execFileSync } from "child_process";

/** Represents a single checkpoint (git tag). */
export interface Checkpoint {
  /** Full tag name. */
  tag: string;
  /** The session/pipeline ID this checkpoint belongs to. */
  sessionId: string;
  /** Unix timestamp (ms) when the checkpoint was created. */
  timestamp: number;
  /** Optional human-readable label (e.g. "after-plan", "after-implement"). */
  label?: string;
  /** Git SHA the tag points to. */
  sha: string;
}

const TAG_PREFIX = "checkpoint";

/**
 * Git-based checkpoint manager.
 *
 * All operations are synchronous (using execFileSync) since they are
 * called from within pipeline stage transitions which are already sync.
 */
export class CheckpointManager {
  /**
   * Create a checkpoint at the current HEAD of the given working directory.
   *
   * @param workdir  The git repo / worktree path.
   * @param sessionId  Pipeline or session ID.
   * @param label  Optional descriptive label (e.g. "after-plan").
   * @returns The created Checkpoint, or `undefined` on failure.
   */
  createCheckpoint(workdir: string, sessionId: string, label?: string): Checkpoint | undefined {
    try {
      const sha = execFileSync("git", ["-C", workdir, "rev-parse", "HEAD"], {
        timeout: 5_000,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();

      if (!sha) return undefined;

      const timestamp = Date.now();
      const labelSuffix = label ? `-${sanitizeLabel(label)}` : "";
      const tag = `${TAG_PREFIX}/${sessionId}/${timestamp}${labelSuffix}`;

      execFileSync("git", ["-C", workdir, "tag", tag, sha], {
        timeout: 5_000,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });

      return { tag, sessionId, timestamp, label, sha };
    } catch (err) {
      console.warn(
        `[checkpoints] Failed to create checkpoint: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }

  /**
   * List all checkpoints for a given session, sorted by timestamp ascending.
   *
   * @param workdir  The git repo / worktree path.
   * @param sessionId  Pipeline or session ID to filter by.
   * @returns Array of Checkpoint objects.
   */
  listCheckpoints(workdir: string, sessionId: string): Checkpoint[] {
    try {
      const pattern = `${TAG_PREFIX}/${sessionId}/*`;
      const output = execFileSync(
        "git",
        ["-C", workdir, "tag", "--list", pattern],
        {
          timeout: 5_000,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        },
      ).trim();

      if (!output) return [];

      const tags = output.split("\n").filter(Boolean);
      const checkpoints: Checkpoint[] = [];

      for (const tag of tags) {
        const parsed = parseTag(tag, workdir);
        if (parsed) checkpoints.push(parsed);
      }

      return checkpoints.sort((a, b) => a.timestamp - b.timestamp);
    } catch (err) {
      console.warn(
        `[checkpoints] Failed to list checkpoints: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /**
   * Restore the working directory to a checkpoint via `git reset --hard`.
   *
   * @param workdir  The git repo / worktree path.
   * @param tag  The checkpoint tag name to restore to.
   * @returns `true` if successful, `false` otherwise.
   */
  restoreCheckpoint(workdir: string, tag: string): boolean {
    try {
      // Verify the tag exists
      execFileSync("git", ["-C", workdir, "rev-parse", "--verify", `refs/tags/${tag}`], {
        timeout: 5_000,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });

      execFileSync("git", ["-C", workdir, "reset", "--hard", tag], {
        timeout: 15_000,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });

      return true;
    } catch (err) {
      console.warn(
        `[checkpoints] Failed to restore checkpoint ${tag}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Delete a single checkpoint tag.
   *
   * @param workdir  The git repo / worktree path.
   * @param tag  The tag name to delete.
   * @returns `true` if deleted, `false` otherwise.
   */
  deleteCheckpoint(workdir: string, tag: string): boolean {
    try {
      execFileSync("git", ["-C", workdir, "tag", "-d", tag], {
        timeout: 5_000,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      return true;
    } catch (err) {
      console.warn(
        `[checkpoints] Failed to delete checkpoint ${tag}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Delete all checkpoints for a session.
   *
   * @param workdir  The git repo / worktree path.
   * @param sessionId  Pipeline or session ID.
   * @returns Number of checkpoints deleted.
   */
  deleteAllCheckpoints(workdir: string, sessionId: string): number {
    const checkpoints = this.listCheckpoints(workdir, sessionId);
    let deleted = 0;
    for (const cp of checkpoints) {
      if (this.deleteCheckpoint(workdir, cp.tag)) deleted++;
    }
    return deleted;
  }
}

// -- Internal helpers --

/**
 * Sanitize a label for use in a git tag name.
 * Only allows alphanumeric, hyphens, and dots.
 */
function sanitizeLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "checkpoint";
}

/**
 * Parse a checkpoint tag name back into a Checkpoint object.
 *
 * Tag format: `checkpoint/<sessionId>/<timestamp>[-<label>]`
 */
function parseTag(tag: string, workdir: string): Checkpoint | undefined {
  const parts = tag.split("/");
  if (parts.length !== 3 || parts[0] !== TAG_PREFIX) return undefined;

  const sessionId = parts[1];
  const rest = parts[2];

  // Parse timestamp and optional label from the last segment
  const dashIndex = rest.indexOf("-");
  let timestampStr: string;
  let label: string | undefined;

  if (dashIndex > 0) {
    timestampStr = rest.slice(0, dashIndex);
    label = rest.slice(dashIndex + 1);
  } else {
    timestampStr = rest;
  }

  const timestamp = parseInt(timestampStr, 10);
  if (isNaN(timestamp)) return undefined;

  // Resolve the SHA for this tag
  let sha: string;
  try {
    sha = execFileSync("git", ["-C", workdir, "rev-parse", tag], {
      timeout: 5_000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return undefined;
  }

  return { tag, sessionId, timestamp, label, sha };
}

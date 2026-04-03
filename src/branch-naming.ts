/**
 * Smart branch naming — infer a descriptive branch name from plan output.
 *
 * After the Codex plan stage completes, we parse the plan to extract a short
 * kebab-case description and prefix it with `feat/` or `fix/` depending on
 * the plan content.
 *
 * @module branch-naming
 */

import { execFileSync } from "child_process";

/** Keywords that indicate a fix/bugfix (case-insensitive). */
const FIX_KEYWORDS = [
  "fix",
  "bug",
  "patch",
  "repair",
  "resolve",
  "hotfix",
  "correct",
  "broken",
  "crash",
  "error",
  "issue",
  "regression",
];

/**
 * Infer a descriptive branch name from plan output.
 *
 * Extracts the first actionable line, converts to kebab-case, limits to 50 chars,
 * and prefixes with `feat/` or `fix/` based on plan keywords.
 *
 * @returns A branch name like `feat/add-user-auth` or `fix/null-pointer-in-parser`,
 *          or `undefined` if the plan cannot be meaningfully parsed.
 */
export function inferBranchName(planOutput: string): string | undefined {
  if (!planOutput || !planOutput.trim()) return undefined;

  const description = extractDescription(planOutput);
  if (!description) return undefined;

  const prefix = detectPrefix(planOutput);
  const kebab = toKebabCase(description);

  if (!kebab || kebab.length < 3) return undefined;

  // Limit the description part to 50 chars total (including prefix)
  const maxDescLen = 50 - prefix.length;
  const trimmed = trimToWordBoundary(kebab, maxDescLen);

  if (!trimmed || trimmed.length < 3) return undefined;

  return `${prefix}${trimmed}`;
}

/**
 * Extract a short descriptive phrase from the plan output.
 *
 * Strategy:
 * 1. Look for an explicit "Plan:" or "Summary:" header line
 * 2. Look for the first line that describes an action (starts with a verb)
 * 3. Fall back to the first non-empty, non-header line
 */
function extractDescription(planOutput: string): string | undefined {
  const lines = planOutput
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) return undefined;

  // Strategy 1: Look for explicit headers
  const headerPrefixes = [
    /^(?:plan|summary|objective|goal|task|description)\s*[:：]\s*/i,
    /^#+\s*(?:plan|summary|objective|goal|task)\s*/i,
  ];

  for (const line of lines) {
    for (const re of headerPrefixes) {
      const match = line.match(re);
      if (match) {
        const rest = line.slice(match[0].length).trim();
        if (rest.length >= 5) return rest;
      }
    }
  }

  // Strategy 2: First line that looks like an actionable description
  // Skip common non-descriptive prefixes (numbered lists, bullets, etc.)
  const actionLineRe = /^(?:\d+[.)]\s*|[-*]\s*)?(.{10,})/;
  for (const line of lines.slice(0, 10)) {
    // Skip lines that are just headers/markers
    if (/^#{1,4}\s/.test(line)) continue;
    if (/^[-=]{3,}$/.test(line)) continue;
    if (/^```/.test(line)) continue;

    const m = line.match(actionLineRe);
    if (m) return m[1];
  }

  // Strategy 3: Fall back to the first meaningful line
  const first = lines.find((l) => l.length >= 5 && !/^[-=]{3,}$/.test(l) && !/^```/.test(l));
  return first || undefined;
}

/**
 * Detect whether the plan is about a fix or a feature.
 * Returns `"fix/"` or `"feat/"`.
 */
function detectPrefix(planOutput: string): string {
  const lower = planOutput.toLowerCase();

  // Count fix-related keywords
  let fixScore = 0;
  for (const kw of FIX_KEYWORDS) {
    // Use word boundary matching
    const re = new RegExp(`\\b${kw}\\b`, "gi");
    const matches = lower.match(re);
    if (matches) fixScore += matches.length;
  }

  // If fix keywords appear prominently, treat as fix
  return fixScore >= 2 ? "fix/" : "feat/";
}

/**
 * Convert a phrase to kebab-case.
 *
 * - Lowercases
 * - Replaces non-alphanumeric chars with hyphens
 * - Collapses consecutive hyphens
 * - Strips leading/trailing hyphens
 * - Picks the first 2-4 "words" for conciseness
 */
function toKebabCase(phrase: string): string {
  // Remove common filler words for conciseness
  const stopWords = new Set([
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
    "of", "with", "by", "from", "is", "are", "was", "were", "be", "been",
    "being", "have", "has", "had", "do", "does", "did", "will", "would",
    "could", "should", "may", "might", "shall", "can", "this", "that",
    "these", "those", "it", "its", "we", "they", "them", "our", "their",
    "all", "each", "every", "any", "some", "no", "not",
  ]);

  const raw = phrase
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const words = raw
    .split(/[\s-]+/)
    .filter((w) => w.length > 0 && !stopWords.has(w));

  // Take first 4 meaningful words
  const selected = words.slice(0, 4);
  if (selected.length === 0) return "";

  return selected
    .join("-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Trim a kebab-case string to a maximum length at a word (hyphen) boundary.
 */
function trimToWordBoundary(kebab: string, maxLen: number): string {
  if (kebab.length <= maxLen) return kebab;

  const truncated = kebab.slice(0, maxLen);
  const lastHyphen = truncated.lastIndexOf("-");
  if (lastHyphen > 3) {
    return truncated.slice(0, lastHyphen);
  }
  return truncated;
}

/**
 * Rename a git branch in a worktree directory.
 *
 * @returns The new branch name on success, or `undefined` on failure.
 */
export function renameBranch(
  worktreePath: string,
  oldBranch: string,
  newBranch: string,
): boolean {
  try {
    execFileSync("git", ["-C", worktreePath, "branch", "-m", oldBranch, newBranch], {
      timeout: 10_000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch (err) {
    console.warn(
      `[branch-naming] Failed to rename branch ${oldBranch} → ${newBranch}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}

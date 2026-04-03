const express = require("express");
const Database = require("better-sqlite3");
const path = require("path");
const os = require("os");
const fs = require("fs");

const app = express();
const PORT = parseInt(process.env.PORT) || 8095;
const DB_PATH = path.join(os.homedir(), ".openclaw", "code-agent.db");

// ── Database helper ───────────────────────────────────────────────────────

function getDb() {
  if (!fs.existsSync(DB_PATH)) {
    return null;
  }
  try {
    const db = new Database(DB_PATH, { readonly: true });
    db.pragma("journal_mode = WAL");
    return db;
  } catch (err) {
    console.error("Failed to open database:", err.message);
    return null;
  }
}

function withDb(fn) {
  const db = getDb();
  if (!db) return null;
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

// ── API endpoints ─────────────────────────────────────────────────────────

app.get("/api/projects", (_req, res) => {
  const data = withDb((db) =>
    db.prepare("SELECT * FROM projects ORDER BY last_accessed_at DESC").all()
  );
  res.json(data || []);
});

app.get("/api/worktrees", (req, res) => {
  const status = req.query.status;
  const data = withDb((db) => {
    if (status) {
      return db
        .prepare(
          `SELECT w.*, p.name as project_name, p.path as project_path
           FROM worktrees w LEFT JOIN projects p ON w.project_id = p.id
           WHERE w.status = ? ORDER BY w.last_accessed_at DESC`
        )
        .all(status);
    }
    return db
      .prepare(
        `SELECT w.*, p.name as project_name, p.path as project_path
         FROM worktrees w LEFT JOIN projects p ON w.project_id = p.id
         ORDER BY w.last_accessed_at DESC`
      )
      .all();
  });
  res.json(data || []);
});

app.get("/api/sessions", (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const status = req.query.status;
  const data = withDb((db) => {
    if (status && status !== "all") {
      return db
        .prepare(
          "SELECT * FROM sessions WHERE status = ? ORDER BY created_at DESC LIMIT ?"
        )
        .all(status, limit);
    }
    return db
      .prepare("SELECT * FROM sessions ORDER BY created_at DESC LIMIT ?")
      .all(limit);
  });
  res.json(data || []);
});

app.get("/api/pipelines", (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  const data = withDb((db) => {
    const pipelines = db
      .prepare(
        "SELECT * FROM pipeline_runs ORDER BY started_at DESC LIMIT ?"
      )
      .all(limit);

    const stageStmt = db.prepare(
      "SELECT * FROM pipeline_stages WHERE pipeline_id = ? ORDER BY iteration, id"
    );
    // Compute total cost per pipeline from sessions
    const costStmt = db.prepare(
      "SELECT COALESCE(SUM(cost_usd), 0) as total FROM sessions WHERE pipeline_id = ?"
    );

    return pipelines.map((p) => ({
      ...p,
      stages: stageStmt.all(p.id),
      total_cost_usd:
        costStmt.get(p.id)?.total || 0,
    }));
  });
  res.json(data || []);
});

app.get("/api/sessions/:id/checkpoints", (req, res) => {
  const sessionId = req.params.id;
  try {
    const { execFileSync } = require("child_process");

    // Find the workdir for this session from the pipeline state or DB
    let workdir;
    const data = withDb((db) => {
      // Try pipeline_runs first
      const pipeline = db
        .prepare("SELECT workdir FROM pipeline_runs WHERE id = ?")
        .get(sessionId);
      if (pipeline) return pipeline.workdir;

      // Try sessions
      const session = db
        .prepare("SELECT workdir FROM sessions WHERE id = ?")
        .get(sessionId);
      return session ? session.workdir : null;
    });

    workdir = data;

    if (!workdir) {
      return res.json([]);
    }

    // List checkpoint tags for this session
    const pattern = `checkpoint/${sessionId}/*`;
    let output;
    try {
      output = execFileSync("git", ["-C", workdir, "tag", "--list", pattern], {
        timeout: 5000,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
    } catch {
      return res.json([]);
    }

    if (!output) return res.json([]);

    const checkpoints = output
      .split("\n")
      .filter(Boolean)
      .map((tag) => {
        const parts = tag.split("/");
        if (parts.length !== 3) return null;
        const rest = parts[2];
        const dashIdx = rest.indexOf("-");
        const timestamp = parseInt(dashIdx > 0 ? rest.slice(0, dashIdx) : rest, 10);
        const label = dashIdx > 0 ? rest.slice(dashIdx + 1) : undefined;

        let sha;
        try {
          sha = execFileSync("git", ["-C", workdir, "rev-parse", tag], {
            timeout: 5000,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          }).trim();
        } catch {
          sha = "unknown";
        }

        return { tag, sessionId, timestamp, label, sha };
      })
      .filter(Boolean)
      .sort((a, b) => a.timestamp - b.timestamp);

    res.json(checkpoints);
  } catch (err) {
    console.error("Checkpoint list error:", err.message);
    res.json([]);
  }
});

app.get("/api/stats", (_req, res) => {
  const data = withDb((db) => {
    const totalSessions = db
      .prepare("SELECT COUNT(*) as count FROM sessions")
      .get().count;
    const totalPipelines = db
      .prepare("SELECT COUNT(*) as count FROM pipeline_runs")
      .get().count;
    const activePipelines = db
      .prepare(
        "SELECT COUNT(*) as count FROM pipeline_runs WHERE status IN ('starting', 'running', 'plan', 'implement', 'review', 'fix')"
      )
      .get().count;
    const totalCostUsd = db
      .prepare("SELECT COALESCE(SUM(cost_usd), 0) as total FROM sessions")
      .get().total;
    const activeWorktrees = db
      .prepare(
        "SELECT COUNT(*) as count FROM worktrees WHERE status = 'active'"
      )
      .get().count;

    const sessionsByStatus = {};
    db.prepare(
      "SELECT status, COUNT(*) as count FROM sessions GROUP BY status"
    )
      .all()
      .forEach((r) => (sessionsByStatus[r.status] = r.count));

    const pipelinesByStatus = {};
    db.prepare(
      "SELECT status, COUNT(*) as count FROM pipeline_runs GROUP BY status"
    )
      .all()
      .forEach((r) => (pipelinesByStatus[r.status] = r.count));

    return {
      totalSessions,
      totalPipelines,
      activePipelines,
      totalCostUsd,
      activeWorktrees,
      sessionsByStatus,
      pipelinesByStatus,
    };
  });
  res.json(
    data || {
      totalSessions: 0,
      totalPipelines: 0,
      activePipelines: 0,
      totalCostUsd: 0,
      activeWorktrees: 0,
      sessionsByStatus: {},
      pipelinesByStatus: {},
    }
  );
});

// ── Serve HTML dashboard ──────────────────────────────────────────────────

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ── Start ─────────────────────────────────────────────────────────────────

app.listen(PORT, "0.0.0.0", () => {
  console.log(`OpenClaw Agent Dashboard running at http://0.0.0.0:${PORT}`);
  console.log(`Database path: ${DB_PATH}`);
  console.log(`Database exists: ${fs.existsSync(DB_PATH)}`);
});

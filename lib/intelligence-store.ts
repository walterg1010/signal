import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getStore, openStore } from "./store.ts";
import type {
  AnalysisResult,
  AnalysisRun,
  RequestIntelligence,
  ReviewDecision,
} from "./analysis-types.ts";

const LEASE_MS = 75_000;
const MAX_RUNNING = 2;
const MAX_RUNS_PER_HOUR = 20;
const STORE_VERSION = 2;

export class StaleReviewError extends Error {
  constructor() {
    super("This suggestion has changed. Reload the analysis before reviewing it.");
    this.name = "StaleReviewError";
  }
}

type BeginOptions = {
  model: string;
  promptVersion: string;
  candidateCount: number;
  force?: boolean;
};

type BeginResult = {
  kind: "started" | "running" | "cached" | "busy";
  analysis: AnalysisRun | null;
};

type ReviewInput = {
  analysisId: string;
  relatedRequestId: string;
  decision: "accepted" | "rejected";
};

type StoredRun = Omit<AnalysisRun, "result"> & { resultJson: string | null };

type StoredReview = {
  firstId: string;
  secondId: string;
  decision: ReviewDecision["decision"];
  relationship: ReviewDecision["relationship"];
  analysisId: string;
  reviewedAt: string;
};

// The clock can be supplied by tests; production always uses wall-clock time.
export function openIntelligenceStore(filename: string, options: { now?: () => number } = {}) {
  if (filename === ":memory:") {
    throw new Error("Intelligence storage requires a file-backed database.");
  }
  openStore(filename).close();
  const db = new DatabaseSync(filename, { timeout: 5000 });
  const now = options.now ?? Date.now;
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS analysis_runs (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL REFERENCES feature_requests(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed')),
      model TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      started_at TEXT NOT NULL,
      started_ms INTEGER NOT NULL,
      lease_until_ms INTEGER NOT NULL,
      finished_at TEXT,
      duration_ms INTEGER CHECK(duration_ms IS NULL OR duration_ms >= 0),
      candidate_count INTEGER NOT NULL CHECK(candidate_count >= 0),
      error TEXT,
      result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json))
    ) STRICT;
    CREATE INDEX IF NOT EXISTS analysis_runs_request_time
      ON analysis_runs(request_id, started_ms DESC);
    CREATE INDEX IF NOT EXISTS analysis_runs_time ON analysis_runs(started_ms);
    CREATE UNIQUE INDEX IF NOT EXISTS analysis_runs_one_active
      ON analysis_runs(request_id) WHERE status = 'running';
    CREATE TABLE IF NOT EXISTS request_review_decisions (
      first_id TEXT NOT NULL REFERENCES feature_requests(id) ON DELETE CASCADE,
      second_id TEXT NOT NULL REFERENCES feature_requests(id) ON DELETE CASCADE,
      decision TEXT NOT NULL CHECK(decision IN ('accepted', 'rejected')),
      relationship TEXT NOT NULL CHECK(relationship IN ('duplicate', 'related')),
      analysis_id TEXT NOT NULL REFERENCES analysis_runs(id),
      reviewed_at TEXT NOT NULL,
      reviewer_id TEXT NOT NULL,
      PRIMARY KEY(first_id, second_id),
      CHECK(first_id < second_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS request_review_events (
      id TEXT PRIMARY KEY,
      first_id TEXT NOT NULL REFERENCES feature_requests(id) ON DELETE CASCADE,
      second_id TEXT NOT NULL REFERENCES feature_requests(id) ON DELETE CASCADE,
      decision TEXT NOT NULL CHECK(decision IN ('accepted', 'rejected')),
      relationship TEXT NOT NULL CHECK(relationship IN ('duplicate', 'related')),
      analysis_id TEXT NOT NULL REFERENCES analysis_runs(id),
      reviewed_at TEXT NOT NULL,
      reviewer_id TEXT NOT NULL,
      CHECK(first_id < second_id)
    ) STRICT;
  `);

  const runColumns = `
    SELECT id, request_id AS requestId, status, model,
      prompt_version AS promptVersion, started_at AS startedAt,
      finished_at AS finishedAt, duration_ms AS durationMs,
      candidate_count AS candidateCount, error, result_json AS resultJson
    FROM analysis_runs
  `;
  const latestStatement = db.prepare(`${runColumns}
    WHERE request_id = ? ORDER BY started_ms DESC, rowid DESC LIMIT 1`);
  const byIdStatement = db.prepare(`${runColumns} WHERE id = ?`);
  const requestExists = db.prepare("SELECT 1 FROM feature_requests WHERE id = ?");
  const expireStatement = db.prepare(`
    UPDATE analysis_runs SET status = 'failed', finished_at = ?,
      duration_ms = max(0, ? - started_ms),
      error = 'The previous analysis was interrupted. Please try again.'
    WHERE status = 'running' AND lease_until_ms <= ?
  `);
  const reviewColumns = `
    SELECT first_id AS firstId, second_id AS secondId, decision, relationship,
      analysis_id AS analysisId, reviewed_at AS reviewedAt
    FROM request_review_decisions
  `;
  const reviewsStatement = db.prepare(`${reviewColumns}
    WHERE first_id = ? OR second_id = ? ORDER BY reviewed_at, first_id, second_id`);
  const pairStatement = db.prepare(`${reviewColumns} WHERE first_id = ? AND second_id = ?`);

  function presentRun(row: StoredRun): AnalysisRun {
    const { resultJson, ...run } = row;
    return { ...run, result: resultJson === null ? null : JSON.parse(resultJson) as AnalysisResult };
  }

  function latest(requestId: string): AnalysisRun | null {
    const row = latestStatement.get(requestId) as StoredRun | undefined;
    return row ? presentRun(row) : null;
  }

  function expire(time = now()) {
    expireStatement.run(new Date(time).toISOString(), time, time);
  }

  function read(requestId: string): RequestIntelligence {
    const rows = reviewsStatement.all(requestId, requestId) as StoredReview[];
    return {
      analysis: latest(requestId),
      reviews: rows.map(row => ({
        relatedRequestId: row.firstId === requestId ? row.secondId : row.firstId,
        decision: row.decision,
        relationship: row.relationship,
        analysisId: row.analysisId,
        reviewedAt: row.reviewedAt,
      })),
    };
  }

  function transaction<T>(operation: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  return {
    begin(requestId: string, input: BeginOptions): BeginResult {
      if (!Number.isSafeInteger(input.candidateCount) || input.candidateCount < 0) {
        throw new Error("Candidate count must be a nonnegative integer.");
      }
      return transaction(() => {
        const time = now();
        expire(time);
        if (!requestExists.get(requestId)) throw new Error("Request not found.");
        const current = latest(requestId);
        if (current?.status === "running") return { kind: "running", analysis: current };
        if (current?.status === "completed" && !input.force) return { kind: "cached", analysis: current };
        const active = db.prepare("SELECT COUNT(*) AS total FROM analysis_runs WHERE status = 'running'")
          .get() as { total: number };
        const recent = db.prepare("SELECT COUNT(*) AS total FROM analysis_runs WHERE started_ms > ?")
          .get(time - 3_600_000) as { total: number };
        if (active.total >= MAX_RUNNING || recent.total >= MAX_RUNS_PER_HOUR) {
          return { kind: "busy", analysis: current };
        }
        const id = randomUUID();
        db.prepare(`INSERT INTO analysis_runs
          (id, request_id, status, model, prompt_version, started_at, started_ms,
            lease_until_ms, candidate_count)
          VALUES (?, ?, 'running', ?, ?, ?, ?, ?, ?)`)
          .run(id, requestId, input.model, input.promptVersion, new Date(time).toISOString(),
            time, time + LEASE_MS, input.candidateCount);
        return { kind: "started", analysis: presentRun(byIdStatement.get(id) as StoredRun) };
      });
    },

    finish(runId: string, result: AnalysisResult, durationMs: number): boolean {
      const time = now();
      expire(time);
      const update = db.prepare(`UPDATE analysis_runs SET status = 'completed',
        finished_at = ?, duration_ms = ?, result_json = ?, error = NULL
        WHERE id = ? AND status = 'running' AND lease_until_ms > ?`)
        .run(new Date(time).toISOString(), Math.max(0, Math.floor(durationMs)), JSON.stringify(result), runId, time);
      return Number(update.changes) === 1;
    },

    fail(runId: string, error: string, durationMs: number): boolean {
      const time = now();
      expire(time);
      const update = db.prepare(`UPDATE analysis_runs SET status = 'failed',
        finished_at = ?, duration_ms = ?, error = ?
        WHERE id = ? AND status = 'running' AND lease_until_ms > ?`)
        .run(new Date(time).toISOString(), Math.max(0, Math.floor(durationMs)), error.slice(0, 500), runId, time);
      return Number(update.changes) === 1;
    },

    get(requestId: string): RequestIntelligence {
      expire();
      return read(requestId);
    },

    overview(): Record<string, RequestIntelligence> {
      expire();
      const ids = db.prepare(`SELECT request_id AS id FROM analysis_runs
        UNION SELECT first_id AS id FROM request_review_decisions
        UNION SELECT second_id AS id FROM request_review_decisions`).all() as { id: string }[];
      return Object.fromEntries(ids.map(({ id }) => [id, read(id)]));
    },

    review(requestId: string, input: ReviewInput, reviewerId: string): RequestIntelligence | null {
      return transaction(() => {
        expire();
        if (!requestExists.get(requestId)) return null;
        const current = latest(requestId);
        const suggestion = current?.result?.suggestions.find(item => item.requestId === input.relatedRequestId);
        if (current?.status !== "completed" || current.id !== input.analysisId
            || !suggestion || requestId === input.relatedRequestId
            || !requestExists.get(input.relatedRequestId)) {
          throw new StaleReviewError();
        }
        const [firstId, secondId] = [requestId, input.relatedRequestId].sort();
        const previous = pairStatement.get(firstId, secondId) as StoredReview | undefined;
        // Preserve the original provenance for a repeated identical decision.
        // A newly reviewed relationship classification is a meaningful change.
        if (previous?.decision === input.decision && previous.relationship === suggestion.relationship) {
          return read(requestId);
        }
        const reviewedAt = new Date(now()).toISOString();
        db.prepare(`INSERT INTO request_review_decisions
          (first_id, second_id, decision, relationship, analysis_id, reviewed_at, reviewer_id)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(first_id, second_id) DO UPDATE SET
            decision = excluded.decision, relationship = excluded.relationship,
            analysis_id = excluded.analysis_id, reviewed_at = excluded.reviewed_at,
            reviewer_id = excluded.reviewer_id`)
          .run(firstId, secondId, input.decision, suggestion.relationship, current.id, reviewedAt, reviewerId);
        db.prepare(`INSERT INTO request_review_events
          (id, first_id, second_id, decision, relationship, analysis_id, reviewed_at, reviewer_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(randomUUID(), firstId, secondId, input.decision, suggestion.relationship,
            current.id, reviewedAt, reviewerId);
        return read(requestId);
      });
    },

    dismissLink(
      requestId: string,
      relatedRequestId: string,
      analysisId: string,
      reviewerId: string,
    ): RequestIntelligence | null {
      return transaction(() => {
        expire();
        if (!requestExists.get(requestId)) return null;
        const [firstId, secondId] = [requestId, relatedRequestId].sort();
        const previous = pairStatement.get(firstId, secondId) as StoredReview | undefined;
        // A human-approved link remains reversible even when newer analysis
        // omits it. Guard the pair's reviewed provenance, not the latest run.
        if (!previous || previous.analysisId !== analysisId) throw new StaleReviewError();
        if (previous.decision === "rejected") return read(requestId);
        const reviewedAt = new Date(now()).toISOString();
        db.prepare(`UPDATE request_review_decisions
          SET decision = 'rejected', reviewed_at = ?, reviewer_id = ?
          WHERE first_id = ? AND second_id = ?`)
          .run(reviewedAt, reviewerId, firstId, secondId);
        db.prepare(`INSERT INTO request_review_events
          (id, first_id, second_id, decision, relationship, analysis_id, reviewed_at, reviewer_id)
          VALUES (?, ?, ?, 'rejected', ?, ?, ?, ?)`)
          .run(randomUUID(), firstId, secondId, previous.relationship,
            previous.analysisId, reviewedAt, reviewerId);
        return read(requestId);
      });
    },

    close() { db.close(); },
  };
}

type IntelligenceStore = ReturnType<typeof openIntelligenceStore>;
const state = globalThis as typeof globalThis & {
  signalIntelligenceStore?: { path: string; store: IntelligenceStore; version: number };
};

export function getIntelligenceStore(): IntelligenceStore {
  getStore();
  const path = resolve(/* turbopackIgnore: true */ process.env.SIGNAL_DB_PATH || "data/signal.db");
  if (state.signalIntelligenceStore?.path !== path || state.signalIntelligenceStore.version !== STORE_VERSION) {
    state.signalIntelligenceStore?.store.close();
    state.signalIntelligenceStore = { path, store: openIntelligenceStore(path), version: STORE_VERSION };
  }
  return state.signalIntelligenceStore.store;
}

export function closeIntelligenceStore() {
  state.signalIntelligenceStore?.store.close();
  delete state.signalIntelligenceStore;
}

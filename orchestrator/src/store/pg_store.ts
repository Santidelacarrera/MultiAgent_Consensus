import { Pool } from 'pg';
import { DebateRecord, StoredEvent } from '../types';
import { ConvergenceMetric, DebateStore } from './store';

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS debates (
  id          TEXT PRIMARY KEY,
  pr_id       TEXT NOT NULL,
  provider    TEXT NOT NULL,
  repo        TEXT NOT NULL,
  pr_number   INTEGER NOT NULL,
  head_sha    TEXT NOT NULL,
  title       TEXT NOT NULL,
  status      TEXT NOT NULL,
  decision    TEXT,
  reason      TEXT,
  rounds      INTEGER NOT NULL DEFAULT 0,
  convergence DOUBLE PRECISION,
  result      JSONB,
  created_at  TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS debates_pr_idx ON debates (pr_id, head_sha);
CREATE INDEX IF NOT EXISTS debates_repo_idx ON debates (repo, pr_number);
CREATE TABLE IF NOT EXISTS minutes (
  debate_id  TEXT PRIMARY KEY REFERENCES debates(id) ON DELETE CASCADE,
  markdown   TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS debate_events (
  id         SERIAL PRIMARY KEY,
  debate_id  TEXT NOT NULL REFERENCES debates(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  payload    JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS debate_events_idx ON debate_events (debate_id, id);
CREATE TABLE IF NOT EXISTS convergence_metrics (
  debate_id   TEXT NOT NULL REFERENCES debates(id) ON DELETE CASCADE,
  round       INTEGER NOT NULL,
  convergence DOUBLE PRECISION NOT NULL,
  approvals   INTEGER NOT NULL,
  rejections  INTEGER NOT NULL,
  outcome     TEXT NOT NULL,
  PRIMARY KEY (debate_id, round)
);
`;

interface DebateRow {
  id: string;
  pr_id: string;
  provider: string;
  repo: string;
  pr_number: number;
  head_sha: string;
  title: string;
  status: string;
  decision: string | null;
  reason: string | null;
  rounds: number;
  convergence: number | null;
  result: unknown;
  minutes?: string | null;
  created_at: Date | string;
  finished_at: Date | string | null;
}

const iso = (d: Date | string | null): string | null => (d === null ? null : new Date(d).toISOString());

const SELECT = `SELECT d.*, m.markdown AS minutes FROM debates d LEFT JOIN minutes m ON m.debate_id = d.id`;

function toRecord(r: DebateRow): DebateRecord {
  return {
    id: r.id,
    prId: r.pr_id,
    provider: r.provider,
    repo: r.repo,
    prNumber: r.pr_number,
    headSha: r.head_sha,
    title: r.title,
    status: r.status as DebateRecord['status'],
    decision: r.decision as DebateRecord['decision'],
    reason: r.reason,
    rounds: r.rounds,
    convergence: r.convergence,
    result: (typeof r.result === 'string' ? JSON.parse(r.result) : r.result) as DebateRecord['result'],
    minutes: r.minutes ?? null,
    createdAt: iso(r.created_at)!,
    finishedAt: iso(r.finished_at),
  };
}

/** Persistencia en PostgreSQL: debates, minutas, log de eventos y métricas de convergencia. */
export class PgStore implements DebateStore {
  constructor(private readonly pool: Pool) {}

  static fromUrl(url: string): PgStore {
    return new PgStore(new Pool({ connectionString: url, max: 10 }));
  }

  async init(): Promise<void> {
    for (const stmt of SCHEMA_SQL.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) {
      await this.pool.query(stmt);
    }
  }

  async saveDebate(rec: DebateRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO debates (id, pr_id, provider, repo, pr_number, head_sha, title, status, decision, reason, rounds, convergence, result, created_at, finished_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, decision = EXCLUDED.decision, reason = EXCLUDED.reason,
         rounds = EXCLUDED.rounds, convergence = EXCLUDED.convergence, result = EXCLUDED.result, title = EXCLUDED.title, finished_at = EXCLUDED.finished_at`,
      [
        rec.id, rec.prId, rec.provider, rec.repo, rec.prNumber, rec.headSha, rec.title, rec.status, rec.decision, rec.reason,
        rec.rounds, rec.convergence, rec.result ? JSON.stringify(rec.result) : null, rec.createdAt, rec.finishedAt,
      ],
    );
    if (rec.minutes !== null) {
      await this.pool.query(
        `INSERT INTO minutes (debate_id, markdown, updated_at) VALUES ($1,$2,$3)
         ON CONFLICT (debate_id) DO UPDATE SET markdown = EXCLUDED.markdown, updated_at = EXCLUDED.updated_at`,
        [rec.id, rec.minutes, new Date().toISOString()],
      );
    }
  }

  async getDebate(id: string): Promise<DebateRecord | null> {
    const { rows } = await this.pool.query(`${SELECT} WHERE d.id = $1`, [id]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findByPrAndSha(prId: string, headSha: string): Promise<DebateRecord | null> {
    const { rows } = await this.pool.query(`${SELECT} WHERE d.pr_id = $1 AND d.head_sha = $2 ORDER BY d.created_at DESC LIMIT 1`, [prId, headSha]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async listByPr(prId: string, limit = 50): Promise<DebateRecord[]> {
    const { rows } = await this.pool.query(`${SELECT} WHERE d.pr_id = $1 ORDER BY d.created_at DESC LIMIT $2`, [prId, limit]);
    return rows.map(toRecord);
  }

  async listRecent(limit = 50): Promise<DebateRecord[]> {
    const { rows } = await this.pool.query(`${SELECT} ORDER BY d.created_at DESC LIMIT $1`, [limit]);
    return rows.map(toRecord);
  }

  async appendEvent(debateId: string, type: string, payload: unknown, at: string): Promise<void> {
    await this.pool.query(`INSERT INTO debate_events (debate_id, type, payload, created_at) VALUES ($1,$2,$3,$4)`, [
      debateId, type, JSON.stringify(payload), at,
    ]);
  }

  async listEvents(debateId: string): Promise<StoredEvent[]> {
    const { rows } = await this.pool.query(`SELECT id, debate_id, type, payload, created_at FROM debate_events WHERE debate_id = $1 ORDER BY id`, [debateId]);
    return rows.map((r: { id: number; debate_id: string; type: string; payload: unknown; created_at: Date | string }) => ({
      id: Number(r.id),
      debateId: r.debate_id,
      type: r.type,
      payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload,
      createdAt: iso(r.created_at)!,
    }));
  }

  async saveMetric(m: ConvergenceMetric): Promise<void> {
    await this.pool.query(
      `INSERT INTO convergence_metrics (debate_id, round, convergence, approvals, rejections, outcome) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (debate_id, round) DO UPDATE SET convergence = EXCLUDED.convergence, approvals = EXCLUDED.approvals, rejections = EXCLUDED.rejections, outcome = EXCLUDED.outcome`,
      [m.debateId, m.round, m.convergence, m.approvals, m.rejections, m.outcome],
    );
  }

  async listMetrics(debateId: string): Promise<ConvergenceMetric[]> {
    const { rows } = await this.pool.query(`SELECT * FROM convergence_metrics WHERE debate_id = $1 ORDER BY round`, [debateId]);
    return rows.map((r: { debate_id: string; round: number; convergence: number; approvals: number; rejections: number; outcome: string }) => ({
      debateId: r.debate_id,
      round: r.round,
      convergence: Number(r.convergence),
      approvals: r.approvals,
      rejections: r.rejections,
      outcome: r.outcome,
    }));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

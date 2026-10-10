-- Esquema inicial (idéntico al que PgStore.init() aplica de forma idempotente).
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

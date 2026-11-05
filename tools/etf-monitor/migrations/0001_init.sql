-- Independent monitor storage. Never bind this database to Xiaoyu production data.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS monitor_values (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS price_bars (
  symbol TEXT NOT NULL CHECK (symbol IN ('QQQM', 'SPYM')),
  date TEXT NOT NULL,
  close REAL NOT NULL CHECK (close > 0),
  adjusted_close REAL NOT NULL CHECK (adjusted_close > 0),
  PRIMARY KEY (symbol, date)
);

CREATE TABLE IF NOT EXISTS valuation_snapshots (
  symbol TEXT NOT NULL CHECK (symbol IN ('QQQM', 'SPYM')),
  date TEXT NOT NULL,
  pe REAL NOT NULL CHECK (pe > 0),
  source TEXT NOT NULL,
  method TEXT NOT NULL,
  proxy TEXT NOT NULL,
  PRIMARY KEY (symbol, date, source, method, proxy)
);

CREATE TABLE IF NOT EXISTS task_runs (
  key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL CHECK (attempts BETWEEN 1 AND 3),
  completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
  lease_until INTEGER NOT NULL,
  owner TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('daily', 'signal', 'health', 'test')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'accepted', 'failed', 'ambiguous', 'expired')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  next_attempt_at INTEGER NOT NULL,
  lease_until INTEGER NOT NULL DEFAULT 0,
  current_attempt TEXT,
  provider_code INTEGER
);
CREATE INDEX IF NOT EXISTS notifications_pending ON notifications(status, next_attempt_at, created_at);

-- A reservation is charged before HTTP, including failed calls, test calls and
-- crashes. This conservatively consumes quota if a worker dies before sending.
CREATE TABLE IF NOT EXISTS send_attempts (
  id TEXT PRIMARY KEY,
  notification_id TEXT NOT NULL REFERENCES notifications(id),
  beijing_date TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  outcome TEXT NOT NULL CHECK (outcome IN ('reserved', 'accepted', 'rejected', 'permanent', 'ambiguous')),
  provider_code INTEGER
);
CREATE INDEX IF NOT EXISTS send_attempts_daily ON send_attempts(beijing_date, kind);

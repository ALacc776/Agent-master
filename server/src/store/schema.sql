CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  is_git INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  brief TEXT NOT NULL DEFAULT '',
  project_id INTEGER REFERENCES projects(id),
  model TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  auto_start INTEGER NOT NULL DEFAULT 0,
  depends_on INTEGER,
  position REAL NOT NULL DEFAULT 0,
  session_id TEXT,
  worktree TEXT,
  branch TEXT,
  base_branch TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0,
  turns INTEGER NOT NULL DEFAULT 0,
  model_reason TEXT,
  on_done TEXT NOT NULL DEFAULT 'merge',
  outcome TEXT,
  status_line TEXT NOT NULL DEFAULT '',
  files_touched TEXT NOT NULL DEFAULT '[]',
  flags TEXT NOT NULL DEFAULT '[]',
  summary TEXT,
  diff_stat TEXT,
  review_verdict TEXT,
  created_by TEXT NOT NULL DEFAULT 'user',
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  last_event_at INTEGER
);

CREATE TABLE IF NOT EXISTS inbox (
  id INTEGER PRIMARY KEY,
  task_id INTEGER,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  suggested_answer TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  answer TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  tool TEXT,
  pattern TEXT NOT NULL,
  decision TEXT,
  answer TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS preferences (
  id INTEGER PRIMARY KEY,
  text TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  text TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_task ON events(task_id, id);

CREATE TABLE IF NOT EXISTS master_messages (
  id INTEGER PRIMARY KEY,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS spend (
  day TEXT NOT NULL,
  task_id INTEGER,
  usd REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(kind UNINDEXED, task_id UNINDEXED, ts UNINDEXED, text);

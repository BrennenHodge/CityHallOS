-- City Hall OS platform schema (Cloudflare D1).
--   npx wrangler d1 execute cityhallos --remote --file schema.sql

CREATE TABLE IF NOT EXISTS cities (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  settings TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  city TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'General',
  source_url TEXT,
  authority TEXT NOT NULL DEFAULT 'official-city',
  visibility TEXT NOT NULL DEFAULT 'public',
  -- verified_current | official_unverified | historical | secondary | unverified
  verification TEXT NOT NULL DEFAULT 'official_unverified',
  as_of TEXT,
  file_key TEXT,
  file_name TEXT,
  mime TEXT,
  bytes INTEGER NOT NULL DEFAULT 0,
  chars INTEGER NOT NULL DEFAULT 0,
  chunks INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'processing',
  error TEXT,
  notes TEXT,
  added_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS documents_city ON documents (city, category);

-- Full text of every chunk, searchable with BM25.
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  title, heading, text,
  doc_id UNINDEXED, city UNINDEXED, visibility UNINDEXED, ord UNINDEXED,
  tokenize = 'porter unicode61'
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  city TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'web',
  page_url TEXT,
  status TEXT NOT NULL DEFAULT 'answered',
  messages INTEGER NOT NULL DEFAULT 0,
  first_question TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS conversations_city ON conversations (city, last_at);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  convo_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  sources TEXT,
  flag TEXT,
  model TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS messages_convo ON messages (convo_id, id);

CREATE TABLE IF NOT EXISTS citations (
  city TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  convo_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS citations_city ON citations (city, created_at);

CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  city TEXT NOT NULL,
  category TEXT NOT NULL,
  department TEXT NOT NULL,
  description TEXT NOT NULL,
  location TEXT,
  name TEXT,
  contact TEXT,
  photo_key TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  priority TEXT NOT NULL DEFAULT 'normal',
  assignee TEXT,
  convo_id TEXT,
  summary TEXT,
  sample INTEGER NOT NULL DEFAULT 0,
  history TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS requests_city ON requests (city, status);

-- City Hall OS platform database (Cloudflare D1): the control plane.
-- It holds which cities exist and who can sign in to which city, with what role.
-- Each city's own records (knowledge base, conversations, requests, audit log) live in that city's
-- data store, a separate SQLite database per city. See src/store.js and ARCHITECTURE.md.
--
--   npx wrangler d1 execute cityhallos --remote --file schema.sql

CREATE TABLE IF NOT EXISTS cities (
  id TEXT PRIMARY KEY,                 -- permanent, e.g. 'ms-wiggins'. Names the city's data store and its file prefix.
  slug TEXT NOT NULL UNIQUE,           -- public handle in URLs and the embed code, e.g. 'wiggins'
  name TEXT NOT NULL,                  -- official name, e.g. 'City of Wiggins'
  state TEXT NOT NULL,                 -- two-letter code
  county TEXT,
  timezone TEXT NOT NULL DEFAULT 'America/Chicago',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('onboarding', 'active', 'suspended', 'archived')),
  settings TEXT NOT NULL DEFAULT '{}', -- assistant name, greeting, contact details, branding
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- One account per person. A person can work for more than one city.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT,                  -- null until the person sets a password from their setup link
  status TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'disabled')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_login_at TEXT
);

-- What a person can do in a city. Roles are defined in src/auth.js.
CREATE TABLE IF NOT EXISTS memberships (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  city_id TEXT NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'department', 'viewer')),
  department_id TEXT,                  -- required for the department role; a department in the city's store
  staff_id TEXT,                       -- the person's entry in the city's staff directory
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, city_id)
);
CREATE INDEX IF NOT EXISTS memberships_city ON memberships (city_id);

-- Signed-in browsers. The id is a SHA-256 hash of the cookie value, so a database leak can't be replayed.
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE, -- null for a City Hall OS operator session
  operator INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);

-- One-time links for setting a password (new accounts and resets). Hashed like sessions.
CREATE TABLE IF NOT EXISTS auth_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL DEFAULT 'setup',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

-- Platform-level events that aren't about one city: sign-ins, cities added.
CREATE TABLE IF NOT EXISTS platform_audit (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  actor_name TEXT NOT NULL,
  action TEXT NOT NULL,
  city_id TEXT,
  summary TEXT NOT NULL,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS platform_audit_at ON platform_audit (id);

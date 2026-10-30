-- 2026-10-30: move to one database per city.
-- The platform database keeps only the city registry, staff accounts and sessions. Each city's records move
-- into its own store (POST /api/platform/cities/wiggins/import-legacy), then 0003 drops the old shared tables.
-- Safe to run while the previous version is live: it still reads cities.slug, name and settings.

ALTER TABLE cities RENAME TO cities_v1;

CREATE TABLE cities (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  state TEXT NOT NULL,
  county TEXT,
  timezone TEXT NOT NULL DEFAULT 'America/Chicago',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('onboarding', 'active', 'suspended', 'archived')),
  settings TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO cities (id, slug, name, state, county, timezone, status, settings, created_at, updated_at)
SELECT 'ms-wiggins', slug, 'City of Wiggins', 'MS', 'Stone County', 'America/Chicago', 'active',
  '{"shortName": "Wiggins", "assistantName": "Ask Wiggins", "tagline": "AI City Clerk · Answers from official city documents", "greeting": "Welcome to City Hall OS for Wiggins, Mississippi. I can help you find city information, understand permit procedures, locate forms and documents, and report issues to the right department. What can I help you with?", "brandColor": "#1f5c46", "phone": "601-928-7221", "address": "117 First Street North, Wiggins, MS 39577", "hours": "", "website": "https://www.cityofwiggins.gov", "publicSite": "https://wiggins.cityhallos.com", "policeNonEmergency": "601-928-5444", "profileNotes": "For permit, zoning and inspection questions, residents should start with City Hall at 601-928-7221. Staff contact names, phone numbers and emails printed on older Planning & Building forms may be out of date.", "disambiguation": "You are NOT the town of Wiggins, Colorado.", "synonyms": {"mayor": ["berry"]}, "requestPrefix": "WIG", "suggestions": ["How do I apply for a building permit?", "How do I pay my water bill?", "Where can I find the city ordinances?", "When is municipal court held?"]}',
  replace(created_at, ' ', 'T') || '.000Z', replace(created_at, ' ', 'T') || '.000Z'
FROM cities_v1 WHERE slug = 'wiggins';

DROP TABLE cities_v1;

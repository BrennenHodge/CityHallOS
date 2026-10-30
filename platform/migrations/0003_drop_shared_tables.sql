-- 2026-10-30: run after every city's records have been imported into its own store.
DROP TABLE IF EXISTS chunks_fts;
DROP TABLE IF EXISTS citations;
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS conversations;
DROP TABLE IF EXISTS requests;
DROP TABLE IF EXISTS documents;

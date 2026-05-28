-- ============================================================
-- Mobile Notes App — SQLite (React Native / Flutter)
-- Covers: INTEGER PRIMARY KEY, WITHOUT ROWID, STRICT tables,
-- BLOB, CHECK enum simulation, FTS5 virtual table, rtree,
-- SQLite type affinity, self-ref parent_note_id.
-- ============================================================

-- Enable foreign key enforcement (must be set per connection)
PRAGMA foreign_keys = ON;

-- ── Users (sync identity) ─────────────────────────────────────
CREATE TABLE users (
  id          TEXT NOT NULL PRIMARY KEY,  -- UUID string
  email       TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  avatar_url  TEXT,
  settings    TEXT NOT NULL DEFAULT '{}',  -- JSON string (SQLite has no JSONB)
  created_at  TEXT NOT NULL,               -- ISO-8601 datetime string
  updated_at  TEXT NOT NULL
);

-- ── Notebooks ─────────────────────────────────────────────────
CREATE TABLE notebooks (
  id          INTEGER PRIMARY KEY,         -- rowid alias = autoincrement
  user_id     TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT    NOT NULL,
  description TEXT,
  color       TEXT,                        -- hex color string
  icon        TEXT,                        -- emoji or icon name
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_default  INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),  -- boolean
  is_shared   INTEGER NOT NULL DEFAULT 0 CHECK (is_shared IN (0, 1)),
  deleted_at  TEXT,                        -- soft delete
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
);

-- ── Notes (self-referential for nested notes) ─────────────────
CREATE TABLE notes (
  id              INTEGER PRIMARY KEY,
  user_id         TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notebook_id     INTEGER REFERENCES notebooks(id) ON DELETE SET NULL,
  parent_note_id  INTEGER REFERENCES notes(id) ON DELETE SET NULL,  -- nullable self-ref
  title           TEXT    NOT NULL DEFAULT '',
  content         TEXT    NOT NULL DEFAULT '',
  content_type    TEXT    NOT NULL DEFAULT 'markdown'
                  CHECK (content_type IN ('markdown', 'plain', 'rich', 'drawing', 'voice')),
  type            TEXT    NOT NULL DEFAULT 'note'
                  CHECK (type IN ('note', 'task', 'drawing', 'voice', 'checklist')),
  is_pinned       INTEGER NOT NULL DEFAULT 0 CHECK (is_pinned IN (0, 1)),
  is_starred      INTEGER NOT NULL DEFAULT 0 CHECK (is_starred IN (0, 1)),
  is_archived     INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0, 1)),
  is_locked       INTEGER NOT NULL DEFAULT 0 CHECK (is_locked IN (0, 1)),
  word_count      INTEGER NOT NULL DEFAULT 0,
  char_count      INTEGER NOT NULL DEFAULT 0,
  latitude        REAL,      -- for geo-tagged notes
  longitude       REAL,
  reminder_at     TEXT,      -- ISO-8601
  reminder_done   INTEGER NOT NULL DEFAULT 0 CHECK (reminder_done IN (0, 1)),
  deleted_at      TEXT,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL
);

-- ── Tags ──────────────────────────────────────────────────────
CREATE TABLE tags (
  id       INTEGER PRIMARY KEY,
  user_id  TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name     TEXT    NOT NULL,
  color    TEXT,
  UNIQUE (user_id, name)
);

CREATE TABLE note_tags (
  note_id  INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  tag_id   INTEGER NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
  PRIMARY KEY (note_id, tag_id)
);

-- ── Attachments ───────────────────────────────────────────────
CREATE TABLE attachments (
  id          INTEGER PRIMARY KEY,
  note_id     INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  filename    TEXT    NOT NULL,
  mime_type   TEXT    NOT NULL,
  size_bytes  INTEGER NOT NULL,
  data        BLOB,             -- small inline attachments (thumbnails, icons)
  url         TEXT,             -- large files stored externally
  width       INTEGER,
  height      INTEGER,
  duration_ms INTEGER,
  created_at  TEXT    NOT NULL
);

-- ── Sync changes (event log — WITHOUT ROWID for performance) ──
CREATE TABLE sync_changes (
  change_id     TEXT    NOT NULL,  -- UUID
  user_id       TEXT    NOT NULL,
  table_name    TEXT    NOT NULL CHECK (table_name IN ('notes','notebooks','tags','note_tags','attachments')),
  record_id     TEXT    NOT NULL,
  operation     TEXT    NOT NULL CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE')),
  payload       TEXT    NOT NULL,  -- JSON snapshot
  client_id     TEXT,
  synced_at     TEXT,
  created_at    TEXT    NOT NULL,
  PRIMARY KEY (change_id, user_id)
) WITHOUT ROWID;

-- ── App settings (STRICT table — SQLite 3.37+) ────────────────
-- STRICT tables enforce column types strictly.
CREATE TABLE app_settings (
  key         TEXT    NOT NULL PRIMARY KEY,
  value       TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
) STRICT;

-- ── Full-text search virtual table ────────────────────────────
-- Content table FTS — keeps in sync with notes table.
CREATE VIRTUAL TABLE notes_fts USING fts5(
  title,
  content,
  content='notes',
  content_rowid='id',
  tokenize='porter unicode61'
);

-- FTS update triggers
CREATE TRIGGER notes_fts_insert AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
END;

CREATE TRIGGER notes_fts_delete AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
END;

CREATE TRIGGER notes_fts_update AFTER UPDATE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
  INSERT INTO notes_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
END;

-- ── Geo-tagged notes spatial index (rtree) ───────────────────
-- rtree for bounding-box spatial queries on note locations.
CREATE VIRTUAL TABLE notes_rtree USING rtree(
  id,         -- rowid matches notes.id
  min_lon, max_lon,
  min_lat, max_lat
);

-- ── Indexes ───────────────────────────────────────────────────
CREATE INDEX idx_notes_user_updated   ON notes (user_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_notes_notebook       ON notes (notebook_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_notes_starred        ON notes (user_id, is_starred) WHERE is_starred = 1;
CREATE INDEX idx_notes_reminder       ON notes (user_id, reminder_at) WHERE reminder_at IS NOT NULL AND reminder_done = 0;
CREATE INDEX idx_attachments_note     ON attachments (note_id);
CREATE INDEX idx_sync_changes_unsynced ON sync_changes (user_id, created_at) WHERE synced_at IS NULL;

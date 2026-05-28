-- ============================================================
-- IoT Time-Series Edge Database — SQLite
-- Covers: WITHOUT ROWID STRICT, composite PK time-series,
-- BLOB for raw packets, rtree for bounding-box device queries,
-- FTS5 for log search, type affinity (REAL, INTEGER, BLOB),
-- CHECK constraints, multiple WITHOUT ROWID tables.
-- ============================================================

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;   -- Write-Ahead Logging for concurrent readers
PRAGMA synchronous = NORMAL;

-- ── Devices ───────────────────────────────────────────────────
CREATE TABLE devices (
  id              INTEGER PRIMARY KEY,
  device_uuid     TEXT    NOT NULL UNIQUE,  -- globally unique hardware ID
  name            TEXT    NOT NULL,
  model           TEXT    NOT NULL,
  firmware_version TEXT,
  serial_number   TEXT    UNIQUE,
  mac_address     TEXT    UNIQUE,
  ip_address      TEXT,
  latitude        REAL,
  longitude       REAL,
  altitude_m      REAL,
  location_name   TEXT,
  status          TEXT    NOT NULL DEFAULT 'offline'
                  CHECK (status IN ('online', 'offline', 'maintenance', 'decommissioned')),
  last_seen_at    TEXT,   -- ISO-8601
  commissioned_at TEXT    NOT NULL,
  decommissioned_at TEXT,
  metadata        TEXT    NOT NULL DEFAULT '{}',  -- JSON
  created_at      TEXT    NOT NULL
) STRICT;

-- ── Sensors ───────────────────────────────────────────────────
CREATE TABLE sensors (
  id          INTEGER PRIMARY KEY,
  device_id   INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  type        TEXT    NOT NULL CHECK (type IN (
    'temperature', 'humidity', 'pressure', 'co2', 'pm25', 'pm10',
    'voc', 'o3', 'no2', 'noise', 'light', 'motion', 'door',
    'current', 'voltage', 'power', 'energy', 'flow', 'level', 'custom'
  )),
  unit        TEXT    NOT NULL,   -- 'celsius', 'percent', 'ppm', 'lux', etc.
  min_value   REAL,
  max_value   REAL,
  precision   INTEGER NOT NULL DEFAULT 2,
  is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at  TEXT    NOT NULL
) STRICT;

-- ── Calibrations ─────────────────────────────────────────────
CREATE TABLE calibrations (
  id          INTEGER PRIMARY KEY,
  sensor_id   INTEGER NOT NULL REFERENCES sensors(id) ON DELETE CASCADE,
  offset_val  REAL    NOT NULL DEFAULT 0.0,
  scale       REAL    NOT NULL DEFAULT 1.0,
  reference   TEXT,    -- reference standard used
  calibrated_by TEXT,
  calibrated_at TEXT NOT NULL,
  expires_at  TEXT,
  notes       TEXT
) STRICT;

-- ── Readings (high-volume, WITHOUT ROWID for performance) ─────
-- Composite PK on (device_id, sensor_id, recorded_at) — no rowid needed.
-- STRICT enforces column types at write time.
CREATE TABLE readings (
  device_id   INTEGER NOT NULL,
  sensor_id   INTEGER NOT NULL,
  recorded_at TEXT    NOT NULL,  -- ISO-8601 with microseconds: '2024-01-15T12:34:56.789000Z'
  value       REAL    NOT NULL,
  raw_value   REAL,              -- pre-calibration value
  quality     INTEGER NOT NULL DEFAULT 100 CHECK (quality BETWEEN 0 AND 100),
  flags       INTEGER NOT NULL DEFAULT 0,  -- bitmask: 1=estimated, 2=interpolated, 4=out_of_range
  PRIMARY KEY (device_id, sensor_id, recorded_at)
) WITHOUT ROWID STRICT;

-- ── Aggregated rollups (WITHOUT ROWID) ────────────────────────
CREATE TABLE readings_hourly (
  device_id   INTEGER NOT NULL,
  sensor_id   INTEGER NOT NULL,
  hour        TEXT    NOT NULL,  -- '2024-01-15T12:00:00Z' truncated to hour
  count       INTEGER NOT NULL,
  sum_val     REAL    NOT NULL,
  min_val     REAL    NOT NULL,
  max_val     REAL    NOT NULL,
  avg_val     REAL    NOT NULL,
  PRIMARY KEY (device_id, sensor_id, hour)
) WITHOUT ROWID STRICT;

CREATE TABLE readings_daily (
  device_id   INTEGER NOT NULL,
  sensor_id   INTEGER NOT NULL,
  day         TEXT    NOT NULL,  -- 'YYYY-MM-DD'
  count       INTEGER NOT NULL,
  sum_val     REAL    NOT NULL,
  min_val     REAL    NOT NULL,
  max_val     REAL    NOT NULL,
  avg_val     REAL    NOT NULL,
  PRIMARY KEY (device_id, sensor_id, day)
) WITHOUT ROWID STRICT;

-- ── Alert rules ───────────────────────────────────────────────
CREATE TABLE alert_rules (
  id              INTEGER PRIMARY KEY,
  sensor_id       INTEGER NOT NULL REFERENCES sensors(id) ON DELETE CASCADE,
  name            TEXT    NOT NULL,
  condition       TEXT    NOT NULL CHECK (condition IN ('>', '>=', '<', '<=', '=', '!=')),
  threshold       REAL    NOT NULL,
  consecutive_count INTEGER NOT NULL DEFAULT 1 CHECK (consecutive_count >= 1),
  severity        TEXT    NOT NULL DEFAULT 'warning'
                  CHECK (severity IN ('info', 'warning', 'critical', 'emergency')),
  notify_channels TEXT    NOT NULL DEFAULT '[]',  -- JSON array: ['email','sms','webhook']
  is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL
) STRICT;

-- ── Alerts ────────────────────────────────────────────────────
CREATE TABLE alerts (
  id              INTEGER PRIMARY KEY,
  rule_id         INTEGER NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
  device_id       INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  sensor_id       INTEGER NOT NULL REFERENCES sensors(id) ON DELETE CASCADE,
  severity        TEXT    NOT NULL CHECK (severity IN ('info', 'warning', 'critical', 'emergency')),
  triggered_value REAL    NOT NULL,
  triggered_at    TEXT    NOT NULL,
  resolved_at     TEXT,
  acknowledged_by TEXT,
  acknowledged_at TEXT,
  notes           TEXT,
  created_at      TEXT    NOT NULL
) STRICT;

-- ── Raw packet log (BLOB storage for binary protocol data) ────
CREATE TABLE raw_packets (
  id          INTEGER PRIMARY KEY,
  device_id   INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  received_at TEXT    NOT NULL,
  protocol    TEXT    NOT NULL CHECK (protocol IN ('mqtt', 'coap', 'http', 'modbus', 'custom')),
  topic       TEXT,
  payload     BLOB    NOT NULL,   -- raw binary packet
  payload_size INTEGER NOT NULL,
  parsed      INTEGER NOT NULL DEFAULT 0 CHECK (parsed IN (0, 1)),
  parse_error TEXT,
  created_at  TEXT    NOT NULL
) STRICT;

-- ── Device spatial index (rtree) ─────────────────────────────
CREATE VIRTUAL TABLE devices_rtree USING rtree(
  id,
  min_lon, max_lon,
  min_lat, max_lat
);

-- Populate rtree when devices are inserted/updated
CREATE TRIGGER devices_rtree_insert AFTER INSERT ON devices
WHEN new.latitude IS NOT NULL AND new.longitude IS NOT NULL BEGIN
  INSERT OR REPLACE INTO devices_rtree(id, min_lon, max_lon, min_lat, max_lat)
  VALUES (new.id, new.longitude, new.longitude, new.latitude, new.latitude);
END;

CREATE TRIGGER devices_rtree_update AFTER UPDATE ON devices
WHEN new.latitude IS NOT NULL AND new.longitude IS NOT NULL BEGIN
  INSERT OR REPLACE INTO devices_rtree(id, min_lon, max_lon, min_lat, max_lat)
  VALUES (new.id, new.longitude, new.longitude, new.latitude, new.latitude);
END;

-- ── Alert log FTS (search alert notes and device names) ───────
CREATE VIRTUAL TABLE alerts_fts USING fts5(
  notes,
  content='alerts',
  content_rowid='id'
);

-- ── Indexes ───────────────────────────────────────────────────
CREATE INDEX idx_readings_sensor_time  ON readings (sensor_id, recorded_at DESC);  -- without rowid still supports secondary indexes
CREATE INDEX idx_alerts_device_open    ON alerts (device_id, triggered_at DESC) WHERE resolved_at IS NULL;
CREATE INDEX idx_alerts_rule           ON alerts (rule_id, triggered_at DESC);
CREATE INDEX idx_raw_packets_unparsed  ON raw_packets (device_id, received_at) WHERE parsed = 0;

-- TimescaleDB initialisation script
-- Runs once on first container boot (docker-entrypoint-initdb.d)
-- Signal columns are NOT pre-defined here; they are added lazily at write time
-- by the file-uploader using ALTER TABLE ... ADD COLUMN IF NOT EXISTS.

CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;

-- ─────────────────────────────────────────────────────────────
-- Helper function: create a season hypertable with the base schema
-- Call this for every new season.  The file-uploader also calls
-- CREATE TABLE IF NOT EXISTS + create_hypertable at runtime when
-- a new season is first written to.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION create_season_table(season_name TEXT)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I (
            time         TIMESTAMPTZ NOT NULL,
            message_name TEXT,
            can_id       INTEGER
            -- signal columns are added at write time via:
            --   ALTER TABLE %I ADD COLUMN IF NOT EXISTS "<signal>" DOUBLE PRECISION;
        )', season_name, season_name);

    -- Idempotent: only creates hypertable if table is not already one
    BEGIN
        PERFORM create_hypertable(season_name, 'time',
            chunk_time_interval => INTERVAL '1 day',
            if_not_exists => TRUE);
    EXCEPTION WHEN OTHERS THEN
        -- Already a hypertable or other non-fatal error
        RAISE NOTICE 'create_hypertable for % skipped: %', season_name, SQLERRM;
    END;

    -- Unique dedup index: re-uploading the same file is idempotent
    -- INSERT ... ON CONFLICT (time, message_name) DO NOTHING skips duplicates
    EXECUTE format('
        CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I (time, message_name)',
        season_name || '_dedup_idx', season_name);

    -- Compression: segment by message to keep similar signals together
    EXECUTE format('
        ALTER TABLE %I SET (
            timescaledb.compress,
            timescaledb.compress_segmentby = ''message_name'',
            timescaledb.compress_orderby   = ''time DESC''
        )', season_name);

    -- Auto-compress chunks older than 2 days
    BEGIN
        PERFORM add_compression_policy(season_name, INTERVAL '2 days',
            if_not_exists => TRUE);
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'add_compression_policy for % skipped: %', season_name, SQLERRM;
    END;

    -- Fast time-range lookups
    EXECUTE format('
        CREATE INDEX IF NOT EXISTS %I ON %I (time DESC)',
        season_name || '_time_idx', season_name);
END;
$$;

-- ─────────────────────────────────────────────────────────────
-- Season tables (no signal columns — added lazily at ingest time)
-- ─────────────────────────────────────────────────────────────
SELECT create_season_table('wfr25');
SELECT create_season_table('wfr26');

-- ─────────────────────────────────────────────────────────────
-- Monitoring table for telemetry health metrics
-- Used by health-monitor to write container / service metrics.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS monitoring (
    time        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    measurement TEXT        NOT NULL,
    container   TEXT,
    service     TEXT,
    field       TEXT        NOT NULL,
    value_float DOUBLE PRECISION,
    value_text  TEXT
);

SELECT create_hypertable('monitoring', 'time',
    chunk_time_interval => INTERVAL '7 days',
    if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS monitoring_time_idx    ON monitoring (time DESC);
CREATE INDEX IF NOT EXISTS monitoring_meas_idx    ON monitoring (measurement, time DESC);
CREATE INDEX IF NOT EXISTS monitoring_contain_idx ON monitoring (container, time DESC);

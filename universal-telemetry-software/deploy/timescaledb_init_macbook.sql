-- TimescaleDB initialisation script for macbook local dev
-- Runs once on first container boot (docker-entrypoint-initdb.d)
-- Signal columns are NOT pre-defined here; they are added lazily at write time.

CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;

-- ─────────────────────────────────────────────────────────────
-- Helper function: create a season hypertable with the base schema
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION create_season_table(season_name TEXT)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I (
            time         TIMESTAMPTZ NOT NULL,
            message_name TEXT,
            can_id       INTEGER
        )', season_name, season_name);

    BEGIN
        PERFORM create_hypertable(season_name, 'time',
            chunk_time_interval => INTERVAL '1 day',
            if_not_exists => TRUE);
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'create_hypertable for % skipped: %', season_name, SQLERRM;
    END;

    -- Only apply compression/hygiene if table IS a hypertable
    IF EXISTS (
        SELECT 1 FROM timescaledb_information.hypertables
        WHERE hypertable_name = season_name
    ) THEN
        EXECUTE format('
            CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I (time, message_name)',
            season_name || '_dedup_idx', season_name);

        EXECUTE format('
            ALTER TABLE %I SET (
                timescaledb.compress,
                timescaledb.compress_segmentby = ''message_name'',
                timescaledb.compress_orderby   = ''time DESC''
            )', season_name);

        BEGIN
            PERFORM add_compression_policy(season_name, INTERVAL '2 days',
                if_not_exists => TRUE);
        EXCEPTION WHEN OTHERS THEN
            RAISE NOTICE 'add_compression_policy for % skipped: %', season_name, SQLERRM;
        END;

        EXECUTE format('
            CREATE INDEX IF NOT EXISTS %I ON %I (time DESC)',
            season_name || '_time_idx', season_name);
    END IF;
END;
$$;

-- ─────────────────────────────────────────────────────────────
-- Season table — WFR26test (no preloaded data)
-- ─────────────────────────────────────────────────────────────
SELECT create_season_table('wfr26base');

-- ─────────────────────────────────────────────────────────────
-- Monitoring table
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

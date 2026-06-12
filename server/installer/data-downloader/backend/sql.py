"""
sql.py — Sensor (signal column) discovery and season table auto-detection from TimescaleDB.

Season table discovery: queries timescaledb_information.hypertables (TimescaleDB-specific),
falling back to information_schema for tables with the expected telemetry schema
(columns: time, message_name). Tables are filtered by naming convention: an alphabetic
prefix followed by 2–4 digits (e.g. wfr25, wfr26, wfr2026).

Sensor discovery: returns every DOUBLE PRECISION column in the table — the set of CAN
signal columns added lazily by the file-uploader.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import List, Optional, Tuple

import psycopg2

logger = logging.getLogger(__name__)
UTC = timezone.utc

# Tables whose names match this pattern are treated as season tables.
# Alpha prefix + 2-4 digits + optional alphanumeric/underscore suffix.
# Examples: wfr25→2025, wfr26→2026, wfr26test→2026, wfr26_test→2026, wfr2026→2026
_SEASON_PATTERN = re.compile(r'^[a-zA-Z]{2,}(\d{2,4})([a-zA-Z_][a-zA-Z0-9_]*)?$')


def discover_season_tables(postgres_dsn: str) -> List[Tuple[str, int]]:
    """
    Discover season tables from TimescaleDB.

    Returns a list of (table_name, year) tuples sorted newest-first.
    Uses timescaledb_information.hypertables when available, falls back
    to information_schema for tables with the telemetry schema.
    """
    candidates = _fetch_candidate_tables(postgres_dsn)
    results: List[Tuple[str, int]] = []
    for table in candidates:
        m = _SEASON_PATTERN.match(table)
        if not m:
            continue
        digits = m.group(1)
        year = int(digits) if len(digits) == 4 else 2000 + int(digits)
        results.append((table, year))
    results.sort(key=lambda x: x[1], reverse=True)
    return results


def _fetch_candidate_tables(postgres_dsn: str) -> List[str]:
    _HYPERTABLE_SQL = """
        SELECT hypertable_name
        FROM timescaledb_information.hypertables
        WHERE hypertable_schema = 'public'
        ORDER BY hypertable_name
    """
    _FALLBACK_SQL = """
        SELECT t.table_name
        FROM information_schema.tables t
        WHERE t.table_schema = 'public'
          AND t.table_type = 'BASE TABLE'
          AND EXISTS (
              SELECT 1 FROM information_schema.columns c
              WHERE c.table_schema = 'public'
                AND c.table_name = t.table_name
                AND c.column_name = 'time'
          )
          AND EXISTS (
              SELECT 1 FROM information_schema.columns c
              WHERE c.table_schema = 'public'
                AND c.table_name = t.table_name
                AND c.column_name = 'message_name'
          )
        ORDER BY t.table_name
    """
    try:
        with psycopg2.connect(postgres_dsn) as conn:
            with conn.cursor() as cur:
                try:
                    cur.execute(_HYPERTABLE_SQL)
                    return [row[0] for row in cur.fetchall()]
                except psycopg2.Error:
                    conn.rollback()
                    logger.info("timescaledb_information not available, falling back to information_schema")
                    cur.execute(_FALLBACK_SQL)
                    return [row[0] for row in cur.fetchall()]
    except Exception:
        logger.exception("Failed to discover season tables from TimescaleDB")
        return []


@dataclass(frozen=True)
class SensorQueryConfig:
    postgres_dsn: str
    table: str                    # lowercase Postgres table name
    window_days: int = 7
    lookback_days: int = 30
    fallback_start: Optional[datetime] = None
    fallback_end: Optional[datetime] = None


def fetch_unique_sensors(config: SensorQueryConfig) -> List[str]:
    """
    Return sorted list of signal column names (DOUBLE PRECISION columns)
    in the given table.

    We first look for columns that have data in the recent lookback
    window.  If none found, we fall back to listing ALL signal columns
    so the UI is never empty just because no uploads were done recently.
    """
    end = datetime.now(UTC)
    start = end - timedelta(days=config.lookback_days)

    sensors = _discover_with_data(config, start, end)

    if not sensors and config.fallback_start and config.fallback_end:
        logger.info(
            "No sensors in recent window for %s; trying fallback range %s → %s",
            config.table, config.fallback_start, config.fallback_end,
        )
        sensors = _discover_with_data(config, config.fallback_start, config.fallback_end)

    if not sensors:
        # Last resort: just return all DOUBLE PRECISION columns regardless of data
        sensors = _list_all_signal_columns(config)

    return sorted(sensors)


def _discover_with_data(
    config: SensorQueryConfig,
    start: datetime,
    end: datetime,
) -> List[str]:
    """
    Return signal columns that have at least one non-null value in [start, end].
    We chunk the range by window_days to avoid full-table scans on large datasets.
    """
    # First get all signal column names
    all_cols = _list_all_signal_columns(config)
    if not all_cols:
        return []

    found: set[str] = set()
    chunk_td = timedelta(days=config.window_days)
    cursor = start
    try:
        with psycopg2.connect(config.postgres_dsn) as conn:
            while cursor < end and len(found) < len(all_cols):
                chunk_end = min(cursor + chunk_td, end)
                # Check each column with a lightweight existence query
                for col in all_cols:
                    if col in found:
                        continue
                    sql = f"""
                        SELECT 1 FROM {config.table}
                        WHERE time >= %(start)s
                          AND time < %(end)s
                          AND "{col}" IS NOT NULL
                        LIMIT 1
                    """
                    with conn.cursor() as cur:
                        cur.execute(sql, {"start": cursor, "end": chunk_end})
                        if cur.fetchone():
                            found.add(col)
                cursor = chunk_end
    except Exception:
        logger.exception("Error discovering sensors for table %s", config.table)

    return list(found)


def _list_all_signal_columns(config: SensorQueryConfig) -> List[str]:
    """
    Return all DOUBLE PRECISION columns in the table from information_schema.
    These are exactly the CAN signal columns added by the file-uploader.
    """
    sql = """
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name   = %(table)s
          AND data_type    = 'double precision'
        ORDER BY column_name
    """
    try:
        with psycopg2.connect(config.postgres_dsn) as conn:
            with conn.cursor() as cur:
                cur.execute(sql, {"table": config.table})
                return [row[0] for row in cur.fetchall()]
    except Exception:
        logger.exception("Error listing columns for table %s", config.table)
        return []

"""
sql.py — Sensor (signal column) discovery from TimescaleDB.

Replaces slicks.discovery.discover_sensors() with a direct Postgres query
against information_schema.columns.

We return every DOUBLE PRECISION column in the table, which is exactly
the set of CAN signal columns added by the file-uploader.
Optionally we verify that at least one non-null value exists in a recent
window to filter out columns that were added but never populated.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import List, Optional

import psycopg2

logger = logging.getLogger(__name__)
UTC = timezone.utc


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

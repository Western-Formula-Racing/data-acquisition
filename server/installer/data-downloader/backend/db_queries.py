"""
db_queries.py — Signal time-series queries against TimescaleDB.

Replaces influx_queries.py.  All queries are plain SQL via psycopg2.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

import psycopg2
import psycopg2.extras

from backend.config import Settings


def _normalize(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def fetch_signal_series(
    settings: Settings,
    signal: str,
    start: datetime,
    end: datetime,
    limit: Optional[int],
    table: Optional[str] = None,
) -> dict:
    """
    Fetch a single signal time-series from TimescaleDB.

    The signal name becomes a quoted column reference.
    Null values are excluded (wide schema — only the frame that carries
    this signal has a non-null value).
    """
    start_dt = _normalize(start)
    end_dt = _normalize(end)
    if start_dt >= end_dt:
        raise ValueError("start must be before end")

    target_table = (table or settings.default_table).lower()

    # Clamp limit
    if limit is not None:
        limit = max(10, min(limit, 20_000))

    sql = f"""
        SELECT time, "{signal}"
        FROM {target_table}
        WHERE time >= %(start)s
          AND time <= %(end)s
          AND "{signal}" IS NOT NULL
        ORDER BY time
        {f'LIMIT {limit}' if limit else ''}
    """

    with psycopg2.connect(settings.postgres_dsn) as conn:
        with conn.cursor() as cur:
            cur.execute(sql, {"start": start_dt, "end": end_dt})
            rows = cur.fetchall()

    points = [
        {"time": ts.astimezone(timezone.utc).isoformat(), "value": float(val)}
        for ts, val in rows
    ]

    return {
        "signal": signal,
        "start": start_dt.isoformat(),
        "end": end_dt.isoformat(),
        "limit": limit,
        "table": target_table,
        "row_count": len(points),
        "points": points,
        "sql": " ".join(sql.split()),
    }

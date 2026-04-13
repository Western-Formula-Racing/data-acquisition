"""
server_scanner.py — Detect "runs" (active driving sessions) in TimescaleDB.

Replaces the slicks-based scan_data_availability() implementation with
plain SQL that TimescaleDB handles efficiently via time_bucket().

Algorithm:
  1. Bucket the time range into hourly bins, counting non-null rows per bucket.
  2. Cluster adjacent non-empty buckets into contiguous windows ("runs").
     Adjacent buckets are merged if the gap between them is <= gap_threshold.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from hashlib import md5
from typing import List, Optional, Tuple

import psycopg2
import psycopg2.extras
from zoneinfo import ZoneInfo

logger = logging.getLogger(__name__)
UTC = timezone.utc


@dataclass(frozen=True)
class ScannerConfig:
    postgres_dsn: str
    table: str          # lowercase Postgres table name, e.g. "wfr26"
    year: int = 2025
    bin_size: str = "hour"        # "hour" or "day"
    include_counts: bool = True
    initial_chunk_days: int = 31
    timezone_name: str = "America/Toronto"
    # Runs with a gap smaller than this are merged into one
    gap_threshold_hours: int = 2

    @property
    def tz(self) -> ZoneInfo:
        return ZoneInfo(self.timezone_name)

    @property
    def start(self) -> datetime:
        return datetime(self.year - 1, 8, 1, tzinfo=UTC)

    @property
    def end(self) -> datetime:
        return datetime(self.year + 1, 1, 1, tzinfo=UTC)


def _build_key(start_utc: datetime, end_utc: datetime) -> str:
    raw = f"{start_utc.isoformat()}_{end_utc.isoformat()}"
    return md5(raw.encode()).hexdigest()[:10]


def _fetch_active_buckets(
    config: ScannerConfig,
    chunk_start: datetime,
    chunk_end: datetime,
) -> List[Tuple[datetime, int]]:
    """
    Return (bucket_start, row_count) for all non-empty time buckets
    within [chunk_start, chunk_end].
    """
    bin_interval = "1 hour" if config.bin_size == "hour" else "1 day"
    sql = f"""
        SELECT
            time_bucket(INTERVAL '{bin_interval}', time) AS bucket,
            COUNT(*) AS row_count
        FROM {config.table}
        WHERE time >= %(start)s
          AND time < %(end)s
        GROUP BY bucket
        HAVING COUNT(*) > 0
        ORDER BY bucket
    """
    with psycopg2.connect(config.postgres_dsn) as conn:
        with conn.cursor() as cur:
            cur.execute(sql, {"start": chunk_start, "end": chunk_end})
            return [(row[0].replace(tzinfo=UTC), int(row[1])) for row in cur.fetchall()]


def _cluster_buckets(
    buckets: List[Tuple[datetime, int]],
    bin_td: timedelta,
    gap_threshold: timedelta,
    tz: ZoneInfo,
    include_counts: bool,
) -> List[dict]:
    """
    Merge adjacent/close buckets into runs.
    """
    if not buckets:
        return []

    runs: List[dict] = []
    run_start, run_end, run_count = buckets[0][0], buckets[0][0] + bin_td, buckets[0][1]

    for bucket_start, count in buckets[1:]:
        bucket_end = bucket_start + bin_td
        if bucket_start - run_end <= gap_threshold:
            # Extend current run
            run_end = bucket_end
            run_count += count
        else:
            # Finalise and start a new run
            runs.append(_make_run(run_start, run_end, run_count, tz, include_counts))
            run_start, run_end, run_count = bucket_start, bucket_end, count

    runs.append(_make_run(run_start, run_end, run_count, tz, include_counts))
    return runs


def _make_run(
    start_utc: datetime,
    end_utc: datetime,
    row_count: int,
    tz: ZoneInfo,
    include_counts: bool,
) -> dict:
    start_local = start_utc.astimezone(tz)
    end_local = end_utc.astimezone(tz)
    entry = {
        "key": _build_key(start_utc, end_utc),
        "start_utc": start_utc.isoformat(),
        "end_utc": end_utc.isoformat(),
        "start_local": start_local.isoformat(),
        "end_local": end_local.isoformat(),
        "timezone": str(tz),
        "bins": 1,
    }
    if include_counts:
        entry["row_count"] = row_count
    return entry


def scan_runs(config: ScannerConfig) -> List[dict]:
    """
    Scan the full season range in chunks and return a list of run dicts.
    Each run represents a contiguous period with data.
    """
    bin_td = timedelta(hours=1) if config.bin_size == "hour" else timedelta(days=1)
    gap_threshold = timedelta(hours=config.gap_threshold_hours)
    chunk_td = timedelta(days=config.initial_chunk_days)

    all_buckets: List[Tuple[datetime, int]] = []
    cursor = config.start

    while cursor < config.end:
        chunk_end = min(cursor + chunk_td, config.end)
        try:
            buckets = _fetch_active_buckets(config, cursor, chunk_end)
            all_buckets.extend(buckets)
            logger.debug("Chunk %s→%s: %d non-empty buckets", cursor, chunk_end, len(buckets))
        except Exception:
            logger.exception("Failed to scan chunk %s→%s for table %s", cursor, chunk_end, config.table)
        cursor = chunk_end

    return _cluster_buckets(all_buckets, bin_td, gap_threshold, config.tz, config.include_counts)

from __future__ import annotations

from datetime import datetime, timezone

from influxdb_client_3 import InfluxDBClient3

from backend.config import Settings
from backend.table_utils import quote_literal, quote_table


def _normalize(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def fetch_signal_series(
    settings: Settings,
    signal: str,
    start: datetime,
    end: datetime,
    limit: int | None,
    database: str | None = None,
    table: str | None = None,
    schema: str = "wide",
) -> dict:
    """
    Fetch a single signal time-series from InfluxDB.

    Args:
        schema: "wide" (one field per signal, default for WFR26+) or
                "narrow" (legacy EAV with signalName tag, for WFR25).
    """
    start_dt = _normalize(start)
    end_dt = _normalize(end)
    if start_dt >= end_dt:
        raise ValueError("start must be before end")
    limit_clause = ""
    if limit is not None:
        limit = max(10, min(limit, 20000))
        limit_clause = f" LIMIT {limit}"

    target_table = table if table else settings.influx_table
    table_ref = quote_table(f"{settings.influx_schema}.{target_table}")

    if schema == "wide":
        # Wide format: signal is a column name, query directly
        sql = f"""
            SELECT time, "{signal}"
            FROM {table_ref}
            WHERE time >= TIMESTAMP '{start_dt.isoformat()}'
              AND time <= TIMESTAMP '{end_dt.isoformat()}'
            ORDER BY time{limit_clause}
        """
        value_col = signal
    else:
        # Narrow (legacy EAV) format
        signal_literal = quote_literal(signal)
        sql = f"""
            SELECT time, "sensorReading"
            FROM {table_ref}
            WHERE "signalName" = {signal_literal}
              AND time >= TIMESTAMP '{start_dt.isoformat()}'
              AND time <= TIMESTAMP '{end_dt.isoformat()}'
            ORDER BY time{limit_clause}
        """
        value_col = "sensorReading"

    # Use provided database or fallback to default setting
    target_db = database if database else settings.influx_database

    with InfluxDBClient3(host=settings.influx_host, token=settings.influx_token, database=target_db) as client:
        tbl = client.query(sql)
        points = []
        for idx in range(tbl.num_rows):
            ts_scalar = tbl.column("time")[idx]
            value_scalar = tbl.column(value_col)[idx]
            ts = _timestamp_scalar_to_datetime(ts_scalar)
            value = value_scalar.as_py()
            if value is not None:
                points.append(
                    {
                        "time": ts.isoformat(),
                        "value": float(value),
                    }
                )

    return {
        "signal": signal,
        "start": start_dt.isoformat(),
        "end": end_dt.isoformat(),
        "limit": limit,
        "database": target_db,
        "schema": schema,
        "row_count": len(points),
        "points": points,
        "sql": " ".join(line.strip() for line in sql.strip().splitlines()),
    }


def _timestamp_scalar_to_datetime(scalar) -> datetime:
    """Convert PyArrow TimestampScalar to timezone-aware datetime."""
    try:
        ts = scalar.as_py()
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        else:
            ts = ts.astimezone(timezone.utc)
        return ts
    except ValueError:
        # Fallback for nanosecond precision timestamps that can't fit in datetime micros
        ts_ns = getattr(scalar, "value", None)
        if ts_ns is None:
            raise
        ts = datetime.fromtimestamp(ts_ns / 1_000_000_000, tz=timezone.utc)
        return ts

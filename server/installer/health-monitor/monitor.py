#!/usr/bin/env python3
"""
Health monitor: collects Docker container and application metrics,
writes them to the TimescaleDB 'monitoring' table every N seconds.
"""
from __future__ import annotations

import os
import sys
import time
import logging
from datetime import datetime, timezone

import docker
import requests
import psycopg2
import psycopg2.extras

# Config from environment
INTERVAL_SECONDS = int(os.getenv("HEALTH_MONITOR_INTERVAL_SECONDS", "60"))
POSTGRES_DSN = os.getenv(
    "POSTGRES_DSN",
    "postgresql://wfr:wfr_password@timescaledb:5432/wfr",
)
CONTAINER_TIMESCALEDB = os.getenv("HEALTH_MONITOR_TIMESCALEDB_CONTAINER", "timescaledb")
CONTAINER_SCANNER = os.getenv("HEALTH_MONITOR_SCANNER_CONTAINER", "data-downloader-scanner")
SCANNER_API_URL = os.getenv(
    "HEALTH_MONITOR_SCANNER_API_URL",
    "http://data-downloader-api:8000",
)
TIMESCALEDB_VOLUME_SUFFIX = os.getenv("HEALTH_MONITOR_TSDB_VOLUME_SUFFIX", "timescaledb-data")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger(__name__)


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ---------------------------------------------------------------------------
# Metric collection
# ---------------------------------------------------------------------------

def collect_timescaledb_metrics(client: docker.DockerClient) -> dict:
    out = {
        "up": False,
        "restart_count": None,
        "disk_usage_bytes": None,
        "write_latency_seconds": None,
        "write_error": None,
    }
    try:
        container = client.containers.get(CONTAINER_TIMESCALEDB)
        out["up"] = container.attrs["State"]["Running"]
        out["restart_count"] = container.attrs.get("RestartCount", 0)
    except docker.errors.NotFound:
        logger.warning("Container %s not found", CONTAINER_TIMESCALEDB)
        return out
    except Exception as e:
        logger.exception("Error inspecting %s: %s", CONTAINER_TIMESCALEDB, e)
        out["write_error"] = str(e)
        return out

    # Disk usage: find the TimescaleDB volume
    try:
        df = client.api.df()
        for vol in df.get("Volumes") or []:
            name = vol.get("Name") or ""
            if TIMESCALEDB_VOLUME_SUFFIX in name:
                usage = (vol.get("UsageData") or {}).get("Size")
                if usage is not None:
                    out["disk_usage_bytes"] = usage
                break
    except Exception as e:
        logger.debug("Could not get volume disk usage: %s", e)

    # Write latency: time a single INSERT + SELECT
    if out["up"] and POSTGRES_DSN:
        try:
            start = time.perf_counter()
            with psycopg2.connect(POSTGRES_DSN) as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        "INSERT INTO monitoring (time, measurement, field, value_float) "
                        "VALUES (%s, %s, %s, %s)",
                        (_now(), "monitor.ping", "check", 1.0),
                    )
                conn.commit()
            out["write_latency_seconds"] = round(time.perf_counter() - start, 4)
        except Exception as e:
            out["write_error"] = str(e)[:500]
            logger.debug("TimescaleDB latency check failed: %s", e)

    return out


def collect_scanner_metrics(client: docker.DockerClient) -> dict:
    out = {
        "up": False,
        "last_scan_duration_seconds": None,
        "last_successful_job_timestamp": None,
        "error_count": None,
        "api_error": None,
    }
    try:
        container = client.containers.get(CONTAINER_SCANNER)
        out["up"] = container.attrs["State"]["Running"]
    except docker.errors.NotFound:
        logger.warning("Container %s not found", CONTAINER_SCANNER)
        return out
    except Exception as e:
        logger.exception("Error inspecting %s: %s", CONTAINER_SCANNER, e)
        out["api_error"] = str(e)
        return out

    try:
        r = requests.get(
            f"{SCANNER_API_URL.rstrip('/')}/api/scanner-status",
            timeout=10,
        )
        r.raise_for_status()
        data = r.json()
        out["last_scan_duration_seconds"] = data.get("last_scan_duration_seconds")
        out["last_successful_job_timestamp"] = data.get("last_successful_job_timestamp")
        out["error_count"] = data.get("error_count")
    except requests.RequestException as e:
        out["api_error"] = str(e)[:500]
        logger.debug("Scanner API request failed: %s", e)
    except (ValueError, KeyError) as e:
        out["api_error"] = str(e)[:500]

    return out


# ---------------------------------------------------------------------------
# Metric writing
# ---------------------------------------------------------------------------

def _write_points(rows: list[tuple]) -> None:
    """
    Write a list of (time, measurement, container, service, field, value_float, value_text)
    tuples to monitoring table.
    """
    sql = """
        INSERT INTO monitoring
            (time, measurement, container, service, field, value_float, value_text)
        VALUES %s
    """
    with psycopg2.connect(POSTGRES_DSN) as conn:
        psycopg2.extras.execute_values(conn.cursor(), sql, rows)
        conn.commit()


def write_health_to_db(tsdb_metrics: dict, scanner_metrics: dict) -> None:
    now = _now()
    rows = []

    # TimescaleDB container metrics
    rows.append((now, "monitor.container", CONTAINER_TIMESCALEDB, None, "up",
                 float(tsdb_metrics["up"]), None))
    if tsdb_metrics["restart_count"] is not None:
        rows.append((now, "monitor.container", CONTAINER_TIMESCALEDB, None,
                     "restart_count", float(tsdb_metrics["restart_count"]), None))
    if tsdb_metrics["disk_usage_bytes"] is not None:
        rows.append((now, "monitor.container", CONTAINER_TIMESCALEDB, None,
                     "disk_usage_bytes", float(tsdb_metrics["disk_usage_bytes"]), None))
    if tsdb_metrics["write_latency_seconds"] is not None:
        rows.append((now, "monitor.container", CONTAINER_TIMESCALEDB, None,
                     "write_latency_seconds", tsdb_metrics["write_latency_seconds"], None))
    if tsdb_metrics.get("write_error"):
        rows.append((now, "monitor.container", CONTAINER_TIMESCALEDB, None,
                     "write_error", None, tsdb_metrics["write_error"][:500]))

    # Scanner container metrics
    rows.append((now, "monitor.container", CONTAINER_SCANNER, None, "up",
                 float(scanner_metrics["up"]), None))
    if scanner_metrics.get("api_error"):
        rows.append((now, "monitor.container", CONTAINER_SCANNER, None,
                     "api_error", None, scanner_metrics["api_error"]))

    # Scanner service metrics
    rows.append((now, "monitor.service", None, CONTAINER_SCANNER, "up",
                 float(scanner_metrics["up"]), None))
    if scanner_metrics.get("last_scan_duration_seconds") is not None:
        rows.append((now, "monitor.service", None, CONTAINER_SCANNER,
                     "last_scan_duration_seconds",
                     scanner_metrics["last_scan_duration_seconds"], None))
    if scanner_metrics.get("last_successful_job_timestamp"):
        rows.append((now, "monitor.service", None, CONTAINER_SCANNER,
                     "last_successful_job_timestamp", None,
                     scanner_metrics["last_successful_job_timestamp"]))
    if scanner_metrics.get("error_count") is not None:
        rows.append((now, "monitor.service", None, CONTAINER_SCANNER,
                     "error_count", float(scanner_metrics["error_count"]), None))

    try:
        _write_points(rows)
        logger.info(
            "Wrote %d health points for %s and %s",
            len(rows), CONTAINER_TIMESCALEDB, CONTAINER_SCANNER,
        )
    except Exception as e:
        logger.exception("Failed to write health metrics: %s", e)


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

def main() -> None:
    logger.info(
        "Health monitor started (interval=%ss, dsn=%s)",
        INTERVAL_SECONDS,
        POSTGRES_DSN,
    )
    docker_client = docker.from_env()

    while True:
        try:
            tsdb_metrics = collect_timescaledb_metrics(docker_client)
            scanner_metrics = collect_scanner_metrics(docker_client)
            write_health_to_db(tsdb_metrics, scanner_metrics)
        except Exception:
            logger.exception("Health collection cycle failed")
        time.sleep(INTERVAL_SECONDS)


if __name__ == "__main__":
    main()

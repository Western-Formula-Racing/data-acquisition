"""
Cloud Sync — Local InfluxDB3  →  Cloud InfluxDB3

Runs as a background process on the base station.  Every SYNC_INTERVAL seconds
it checks for internet connectivity and, if available, queries the local
InfluxDB3 for data that has not yet been synced at pushes it to the cloud
instance.

Progress is tracked via a simple state file so syncs are incremental.

Usage:
  # As a background process (started by main.py):
  python -m src.cloud_sync

  # Manual one-off sync:
  python src/cloud_sync.py --last-hours 24
  python src/cloud_sync.py --since 2026-03-01T00:00:00Z
  python src/cloud_sync.py --dry-run
"""

import argparse
import asyncio
import json
import logging
import os
import socket
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from influxdb_client import InfluxDBClient, WriteOptions

from src.config import (
    LOCAL_INFLUX_URL,
    LOCAL_INFLUX_TOKEN,
    LOCAL_INFLUX_ORG,
    LOCAL_INFLUX_BUCKET,
    INFLUX_TABLE,
)
from src import utils

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger("CloudSync")

# ── Cloud InfluxDB3 ──────────────────────────────────────────────────────────
CLOUD_INFLUX_URL    = os.getenv("CLOUD_INFLUX_URL", "https://influxdb3.westernformularacing.org")
CLOUD_INFLUX_TOKEN  = os.getenv("CLOUD_INFLUX_TOKEN", "")
CLOUD_INFLUX_ORG    = os.getenv("CLOUD_INFLUX_ORG", "WFR")
CLOUD_INFLUX_BUCKET = os.getenv("CLOUD_INFLUX_BUCKET", "WFR26")

# ── Sync behaviour ───────────────────────────────────────────────────────────
SYNC_INTERVAL       = int(os.getenv("SYNC_INTERVAL_SECONDS", "60"))
SYNC_BATCH_SIZE     = int(os.getenv("SYNC_BATCH_SIZE", "10000"))
STATE_FILE          = Path(os.getenv("SYNC_STATE_FILE", "/tmp/influx_cloud_sync_state.json"))

shutdown_event = asyncio.Event()


# ── Connectivity ──────────────────────────────────────────────────────────────

def check_cloud_reachable(
    host: str = "influxdb3.westernformularacing.org",
    port: int = 443,
    timeout: float = 5.0,
) -> bool:
    """Return True if we can TCP-connect to the cloud InfluxDB host."""
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except (OSError, socket.timeout):
        return False


# ── State persistence ─────────────────────────────────────────────────────────

def load_last_sync_time() -> datetime:
    if STATE_FILE.exists():
        try:
            with open(STATE_FILE) as f:
                state = json.load(f)
                ts = state.get("last_sync_time")
                if ts:
                    return datetime.fromisoformat(ts)
        except Exception as e:
            logger.warning(f"Could not load state: {e}")
    # First run — sync the last 24 h by default
    return datetime.now(timezone.utc) - timedelta(hours=24)


def save_last_sync_time(dt: datetime):
    try:
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(STATE_FILE, "w") as f:
            json.dump({"last_sync_time": dt.isoformat()}, f)
    except Exception as e:
        logger.error(f"Could not save state: {e}")


# ── Core sync ─────────────────────────────────────────────────────────────────

def sync_once(since: datetime | None = None, dry_run: bool = False) -> bool:
    """
    Query local InfluxDB for data written after *since* and push it to the
    cloud instance.  Returns True on success.
    """
    if since is None:
        since = load_last_sync_time()

    sync_start = datetime.now(timezone.utc)
    logger.info(f"Sync window: {since.isoformat()} → now")

    # ── 1. Check cloud reachability ────────────────────────────────────────
    if not dry_run:
        if not check_cloud_reachable():
            logger.info("Cloud unreachable — skipping sync.")
            return False
        logger.info("✓ Cloud InfluxDB reachable")

    # ── 2. Read from local ─────────────────────────────────────────────────
    import influxdb_client_3
    import pandas as pd
    
    local = influxdb_client_3.InfluxDBClient3(
        host=LOCAL_INFLUX_URL,
        token=LOCAL_INFLUX_TOKEN or "",
        org=LOCAL_INFLUX_ORG,
        database=LOCAL_INFLUX_BUCKET,
    )

    since_rfc = since.strftime("%Y-%m-%d %H:%M:%S")

    # InfluxDB 3 requires SQL to query
    sql = f"SELECT * FROM \"{INFLUX_TABLE}\" WHERE time >= '{since_rfc}'"

    logger.info(f"Querying local bucket '{LOCAL_INFLUX_BUCKET}' with SQL …")
    try:
        table_pa = local.query(sql)
    except Exception as e:
        logger.error(f"Local query failed: {e}")
        local.close()
        return False

    # Load sidecars for corrections
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    sync_states_dir = os.path.join(base_dir, "sync_states")
    
    sidecars = []
    if os.path.exists(sync_states_dir):
        for f in os.listdir(sync_states_dir):
            if f.startswith("correction_") and f.endswith(".json"):
                try:
                    with open(os.path.join(sync_states_dir, f)) as jf:
                        sidecars.append(json.load(jf))
                except Exception as e:
                    logger.warning(f"Could not read sidecar {f}: {e}")

    # Sort so we can bound them
    sidecars.sort(key=lambda x: x.get("base_timeline_start", 0))

    if table_pa.num_rows == 0:
        logger.info("Found 0 points to sync.")
        save_last_sync_time(sync_start)
        local.close()
        return True

    df = table_pa.to_pandas()
    total = len(df)
    logger.info(f"Found {total} points to sync")

    if dry_run:
        logger.info(f"[DRY RUN] Would push {total} points to cloud")
        local.close()
        return True

    if "time" in df.columns:
        # Apply time correction sidecars in a vectorized way
        ts_sec = df['time'].astype('int64') / 1e9
        for i, sc in enumerate(sidecars):
            start = sc.get("base_timeline_start", 0) - 3600
            end_cap = start + 43200
            
            next_start = float('inf')
            if i + 1 < len(sidecars):
                next_start = sidecars[i+1].get("base_timeline_start", 0) - 3600
                
            end = min(end_cap, next_start)
            correction = sc.get("correction_seconds", 0.0)
            
            if correction != 0.0:
                mask = (ts_sec >= start) & (ts_sec < end)
                if mask.any():
                    df.loc[mask, 'time'] += pd.Timedelta(seconds=correction)

        # Set index to time for the Cloud Writer
        df.set_index('time', inplace=True)

    # ── 3. Write to cloud ──────────────────────────────────────────────────
    if not CLOUD_INFLUX_TOKEN:
        logger.error("CLOUD_INFLUX_TOKEN not set — cannot write to cloud.")
        local.close()
        return False

    cloud = InfluxDBClient(
        url=CLOUD_INFLUX_URL,
        token=CLOUD_INFLUX_TOKEN,
        org=CLOUD_INFLUX_ORG,
    )
    
    # We use batching. Write options configured correctly
    cloud_write = cloud.write_api(
        write_options=WriteOptions(
            batch_size=SYNC_BATCH_SIZE,
            flush_interval=5_000,
            retry_interval=5_000,
        )
    )

    try:
        cloud_write.write(
            bucket=CLOUD_INFLUX_BUCKET,
            org=CLOUD_INFLUX_ORG,
            record=df,
            data_frame_measurement_name=INFLUX_TABLE,
            data_frame_tag_columns=["signalName", "messageName", "canId"]
        )
        logger.info(f"✓ Synced {total} points to cloud")
        written = total
    except Exception as e:
        logger.error(f"Cloud write error: {e}")
        written = 0

    cloud_write.close()
    cloud.close()
    local.close()

    if written == total:
        save_last_sync_time(sync_start)
        return True
    else:
        logger.warning(f"Failed sync: wrote {written}/{total}")
        return False


# ── Background loop ──────────────────────────────────────────────────────────

async def sync_loop():
    """Periodically tries to sync local → cloud."""
    logger.info(
        f"Cloud sync loop started  (interval={SYNC_INTERVAL}s, "
        f"table={INFLUX_TABLE}, cloud_bucket={CLOUD_INFLUX_BUCKET})"
    )
    while not shutdown_event.is_set():
        try:
            # Run the blocking sync in a thread so we don't hold the loop
            await asyncio.get_running_loop().run_in_executor(None, sync_once)
        except Exception as e:
            logger.error(f"sync_once raised: {e}")

        # Wait, but wake up early if shutdown is requested
        try:
            await asyncio.wait_for(shutdown_event.wait(), timeout=SYNC_INTERVAL)
            break  # shutdown was set
        except asyncio.TimeoutError:
            pass  # interval elapsed — loop again


async def run_cloud_sync():
    """Entry point when run as a managed process from main.py."""
    loop = asyncio.get_running_loop()
    utils.register_shutdown_signals(loop, shutdown_event, "Cloud sync")
    await sync_loop()


# ── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Sync local InfluxDB → cloud")
    parser.add_argument("--since", type=str, help="ISO timestamp to sync from")
    parser.add_argument("--last-hours", type=int, help="Sync last N hours")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--check-only", action="store_true", help="Only test connectivity")
    parser.add_argument("--daemon", action="store_true", help="Run as background sync loop")
    args = parser.parse_args()

    if args.check_only:
        ok = check_cloud_reachable()
        print("✓ Cloud reachable" if ok else "✗ Cloud unreachable")
        sys.exit(0 if ok else 1)

    if args.daemon:
        asyncio.run(run_cloud_sync())
        return

    since = None
    if args.since:
        since = datetime.fromisoformat(args.since.replace("Z", "+00:00"))
    elif args.last_hours:
        since = datetime.now(timezone.utc) - timedelta(hours=args.last_hours)

    ok = sync_once(since=since, dry_run=args.dry_run)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()

"""
Redis → TimescaleDB Bridge

Subscribes to the Redis `can_messages` channel (same data the WebSocket bridge
forwards to Pecan) and writes every decoded CAN signal into TimescaleDB.
Grafana reads from the server stack's TimescaleDB instance, so data is
always accessible even without internet on the base station.

Wide format: one row per CAN message, all signals as columns.
Table name is derived from the season (e.g. wfr26_base) via POSTGRES_DSN.

Architecture (Option A): RPi base station writes directly to the server stack's
TimescaleDB over the network. No local TimescaleDB on the RPi.
"""

import asyncio
import json
import logging
import os
import time
import threading
from datetime import datetime, timezone
from typing import List, Optional, Set, Tuple

import psycopg2
import psycopg2.extras
import psycopg2.pool
import redis.asyncio as redis
import cantools

from src.config import (
    REDIS_URL,
    REDIS_CAN_CHANNEL as REDIS_CHANNEL,
    POSTGRES_DSN,
    TIMESCALE_TABLE,
)
from src import redis_utils, utils

logger = logging.getLogger("TimescaleBridge")

# ── Batching ───────────────────────────────────────────────────────────────────
BATCH_SIZE     = int(os.getenv("TIMESCALE_BATCH_SIZE", "5000"))
FLUSH_INTERVAL = int(os.getenv("TIMESCALE_FLUSH_INTERVAL_MS", "1000"))

shutdown_event = asyncio.Event()


# ── Bridge ─────────────────────────────────────────────────────────────────────

class TimescaleBridge:
    """
    Subscribes to Redis CAN messages and writes wide-format CAN data to TimescaleDB.

    Reuses the CANTimescaleStreamer pattern from file-uploader/helper.py:
    - psycopg2 execute_values() for batch inserts
    - ALTER TABLE ADD COLUMN IF NOT EXISTS for dynamic signal columns (cached)
    - INSERT ... ON CONFLICT (time, message_name) DO UPDATE for deduplication
    """

    def __init__(self):
        self.dsn = POSTGRES_DSN
        self.table = TIMESCALE_TABLE.lower()  # Postgres names are lowercase

        # Load DBC for CAN decoding
        resolved_dbc = os.getenv("DBC_FILE_PATH", "/app/example.dbc")
        self.db = cantools.database.load_file(resolved_dbc)
        logger.info(f"📁 Loaded DBC file: {resolved_dbc}")

        # Postgres connection pool (ThreadedConnectionPool for concurrent writes)
        self._pool = psycopg2.pool.ThreadedConnectionPool(1, 10, self.dsn)

        # Cache of signal columns already ensured in Postgres this session.
        # Avoids ALTER TABLE round-trips for signals already seen.
        self._known_signals: Set[str] = set()
        self._signals_lock = threading.Lock()

        # Batching
        self._batch: List[Tuple[datetime, str, int, dict]] = []
        self._last_flush = time.time()
        self._batch_lock = threading.Lock()

        # Stats
        self.msgs_processed = 0
        self.rows_written   = 0
        self.errors         = 0
        self._last_stats    = time.time()

        logger.info(
            f"TimescaleBridge → {self.dsn}  table={self.table}  "
            f"batch={BATCH_SIZE}  flush={FLUSH_INTERVAL}ms"
        )

    # ── Connection management ──────────────────────────────────────────────

    class _Conn:
        """Context manager for a pooled connection."""
        def __init__(self, pool):
            self._pool = pool
            self._conn = None
        def __enter__(self):
            self._conn = self._pool.getconn()
            self._conn.autocommit = False
            return self._conn
        def __exit__(self, *args):
            self._pool.putconn(self._conn)

    def _get_conn(self):
        return self._Conn(self._pool)

    def close(self):
        try:
            # Flush remaining batch
            self._flush_batch()
            self._pool.closeall()
        except Exception as e:
            logger.warning(f"⚠️ Error closing DB pool: {e}")

    # ── Schema management — expandable columns ────────────────────────────

    def _ensure_signal_columns(self, signal_names: Set[str]) -> None:
        """
        Add any signal columns that don't exist yet.
        Uses IF NOT EXISTS so it's safe to call concurrently/repeatedly.
        Only issues ALTER TABLE for columns not in self._known_signals.
        """
        with self._signals_lock:
            new_signals = signal_names - self._known_signals
            if not new_signals:
                return

            with self._get_conn() as conn:
                with conn.cursor() as cur:
                    for sig in sorted(new_signals):
                        cur.execute(
                            f'ALTER TABLE {self.table} '
                            f'ADD COLUMN IF NOT EXISTS "{sig}" DOUBLE PRECISION'
                        )
                conn.commit()
            self._known_signals.update(new_signals)

    # ── Batch writing ──────────────────────────────────────────────────────

    def _flush_batch(self) -> int:
        """Write the current batch to TimescaleDB. Returns row count written."""
        with self._batch_lock:
            if not self._batch:
                return 0
            rows = self._batch
            self._batch = []
            self._last_flush = time.time()

        if not rows:
            return 0

        # Collect all signal names in this batch
        batch_signals: Set[str] = set()
        for _, _, _, signals in rows:
            batch_signals.update(signals.keys())

        # Lazily add any new columns
        self._ensure_signal_columns(batch_signals)

        # Build INSERT with only columns present in this batch
        fixed_cols = ["time", "message_name", "can_id"]
        sig_cols = sorted(batch_signals)
        all_cols = fixed_cols + sig_cols

        col_sql = ", ".join(f'"{c}"' for c in all_cols)

        if sig_cols:
            update_sql = ", ".join(f'"{s}" = EXCLUDED."{s}"' for s in sig_cols)
            update_sql += ', "can_id" = EXCLUDED."can_id"'
        else:
            update_sql = '"can_id" = EXCLUDED."can_id"'

        insert_sql = (
            f'INSERT INTO {self.table} ({col_sql}) VALUES %s '
            f'ON CONFLICT (time, message_name) DO UPDATE SET {update_sql}'
        )

        # Deduplicate within batch: keep last row for (time, message_name)
        seen: dict = {}
        for ts, msg_name, can_id, signals in rows:
            seen[(ts, msg_name)] = (ts, msg_name, can_id, signals)
        deduped = list(seen.values())

        # Build value tuples
        values = []
        for ts, msg_name, can_id, signals in deduped:
            row_tuple = (ts, msg_name, can_id) + tuple(
                signals.get(s) for s in sig_cols
            )
            values.append(row_tuple)

        try:
            with self._get_conn() as conn:
                with conn.cursor() as cur:
                    psycopg2.extras.execute_values(
                        cur, insert_sql, values, page_size=BATCH_SIZE
                    )
                conn.commit()
            n = len(deduped)
            self.rows_written += n
            return n
        except Exception as e:
            self.errors += 1
            logger.error(f"_flush_batch error: {e}")
            # Put rows back on failure (best-effort)
            with self._batch_lock:
                self._batch = rows + self._batch
            raise

    # ── Process one Redis message ──────────────────────────────────────────

    def process_message(self, raw: str) -> int:
        """
        Parse the JSON array from Redis, decode each frame, add to batch.
        Returns number of frames queued (not rows written).
        """
        count = 0
        try:
            messages = json.loads(raw)
            if not isinstance(messages, list):
                messages = [messages]

            for msg in messages:
                can_id     = msg.get("canId")
                data_bytes = bytes(msg.get("data", []))
                ts_ms      = msg.get("time", int(time.time() * 1000))

                if can_id is None or len(data_bytes) != 8:
                    continue

                try:
                    can_id = int(can_id)
                except (TypeError, ValueError):
                    continue

                # Convert ms timestamp to datetime with UTC timezone
                ts = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc)

                # Decode CAN frame
                try:
                    message = self.db.get_message_by_frame_id(can_id)
                    signals = message.decode(data_bytes, decode_choices=False)
                except Exception:
                    continue

                if not signals:
                    continue

                with self._batch_lock:
                    self._batch.append((ts, message.name, can_id, dict(signals)))
                    count += 1

                # Flush if batch is full
                if len(self._batch) >= BATCH_SIZE:
                    self._flush_batch()

        except json.JSONDecodeError as e:
            logger.error(f"Bad JSON from Redis: {e}")
        except Exception as e:
            self.errors += 1
            logger.error(f"process_message error: {e}")
        return count

    # ── Periodic flush ─────────────────────────────────────────────────────

    def _periodic_flush(self):
        """Flush batch if FLUSH_INTERVAL has elapsed. Called from the async loop."""
        # Decide under lock, flush outside lock to avoid re-entrant lock deadlock
        # (_flush_batch acquires _batch_lock internally).
        should_flush = False
        with self._batch_lock:
            elapsed = (time.time() - self._last_flush) * 1000
            should_flush = bool(self._batch) and elapsed >= FLUSH_INTERVAL

        if should_flush:
            try:
                self._flush_batch()
            except Exception:
                pass  # Already logged in _flush_batch

    # ── Main loop ──────────────────────────────────────────────────────────

    async def run(self):
        """Subscribe to Redis and write to TimescaleDB continuously."""
        try:
            r = redis.from_url(REDIS_URL)
            pubsub = r.pubsub()
            await pubsub.subscribe(REDIS_CHANNEL)
            logger.info(f"Subscribed to Redis channel: {REDIS_CHANNEL}")

            async for message in pubsub.listen():
                if shutdown_event.is_set():
                    break

                if message["type"] != "message":
                    continue

                data = redis_utils.decode_message(message["data"])
                n = self.process_message(data)
                self.msgs_processed += n

                # Periodic flush on time interval
                self._periodic_flush()

                # Periodic stats log + Redis status key
                now = time.time()
                if now - self._last_stats >= 10:
                    logger.info(
                        f"[TimescaleBridge] {self.msgs_processed} CAN msgs → "
                        f"{self.rows_written} rows written, {self.errors} errors"
                    )
                    await r.set("timescale:status", json.dumps({
                        "ok": True,
                        "rows": self.rows_written,
                        "errors": self.errors,
                        "ts": now,
                    }))
                    self._last_stats = now

        except Exception as e:
            logger.error(f"TimescaleBridge fatal: {e}")
            try:
                r_err = redis.from_url(REDIS_URL)
                await r_err.set("timescale:status", json.dumps({
                    "ok": False,
                    "error": str(e),
                    "ts": time.time(),
                }))
            except Exception:
                pass
        finally:
            logger.info("TimescaleBridge stopping …")
            self.close()

# ── Entry point ────────────────────────────────────────────────────────────────

async def run_timescale_bridge():
    """Standalone entry point for the bridge."""
    loop = asyncio.get_running_loop()
    utils.register_shutdown_signals(loop, shutdown_event, "TimescaleBridge")
    logger.info("Starting Redis → TimescaleDB Bridge …")
    bridge = TimescaleBridge()
    await bridge.run()


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    )
    try:
        asyncio.run(run_timescale_bridge())
    except KeyboardInterrupt:
        logger.info("Interrupted, exiting.")

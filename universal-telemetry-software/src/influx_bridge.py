"""
Redis → Local InfluxDB3 Bridge

Subscribes to the Redis `can_messages` channel (same data the WebSocket bridge
forwards to Pecan) and writes every decoded CAN signal into the local InfluxDB3
instance.  Grafana reads from this local instance during test days, so data is
always accessible even without internet.

Measurement / table name is controlled by INFLUX_TABLE (e.g. WFR26_base).
Data is written in wide format: one point per CAN message, all signals as fields.
"""

import asyncio
import json
import os
import time
import logging
import pyarrow as pa
import pyarrow.parquet as pq

import redis.asyncio as redis
import slicks

from src.config import (
    REDIS_URL,
    REDIS_CAN_CHANNEL as REDIS_CHANNEL,
    LOCAL_INFLUX_URL as INFLUX_URL,
    LOCAL_INFLUX_TOKEN as INFLUX_TOKEN,
    LOCAL_INFLUX_ORG as INFLUX_ORG,
    LOCAL_INFLUX_BUCKET as INFLUX_BUCKET,
    INFLUX_TABLE,
)
from src import redis_utils, utils

logger = logging.getLogger("InfluxBridge")

# ── Batching ───────────────────────────────────────────────────────────────────
BATCH_SIZE     = int(os.getenv("INFLUX_BATCH_SIZE", "5000"))
FLUSH_INTERVAL = int(os.getenv("INFLUX_FLUSH_INTERVAL_MS", "1000"))

shutdown_event = asyncio.Event()


# ── Bridge ─────────────────────────────────────────────────────────────────────

class InfluxBridge:
    """Subscribes to Redis CAN messages and writes wide-format data to InfluxDB."""

    def __init__(self):
        self.writer = slicks.WideWriter(
            url=INFLUX_URL,
            token=INFLUX_TOKEN,
            bucket=INFLUX_BUCKET,
            measurement=INFLUX_TABLE,
            org=INFLUX_ORG,
            batch_size=BATCH_SIZE,
            flush_interval_ms=FLUSH_INTERVAL,
        )
        logger.info(
            f"InfluxBridge → {INFLUX_URL}  bucket={INFLUX_BUCKET}  "
            f"table={INFLUX_TABLE}  batch={BATCH_SIZE}"
        )

        # Stats
        self.msgs_processed = 0
        self.points_written  = 0
        self.errors          = 0
        self._last_stats     = time.time()

        # Parquet buffering for unsynced data
        self.pq_schema = pa.schema([
            ("ts_ns", pa.int64()),
            ("can_id", pa.int64()),
            ("data_bytes", pa.binary())
        ])
        session_id = os.getenv("BOOT_SESSION_ID", "default")
        self.pq_filename = f"unsynced_buffer_{session_id}.parquet"
        self.pq_writer = None
        self.unsynced_buffer = []
        self.last_unsynced_ts_ns = None
        if os.path.exists(self.pq_filename):
            try:
                os.remove(self.pq_filename)
                logger.info(f"Cleaned up old {self.pq_filename} on startup")
            except OSError:
                pass

    # ── Parquet Buffering ──────────────────────────────────────────────────

    def _flush_unsynced_to_parquet(self):
        if not self.unsynced_buffer:
            return
        
        table = pa.Table.from_arrays([
            pa.array([m["ts_ns"] for m in self.unsynced_buffer]),
            pa.array([m["can_id"] for m in self.unsynced_buffer]),
            pa.array([m["data_bytes"] for m in self.unsynced_buffer])
        ], schema=self.pq_schema)
        
        if self.pq_writer is None:
            self.pq_writer = pq.ParquetWriter(self.pq_filename, self.pq_schema)
            
        self.pq_writer.write_table(table)
        self.unsynced_buffer.clear()

    def _flush_parquet_to_influx(self, current_ts_ns: int) -> int:
        self._flush_unsynced_to_parquet()
        if self.pq_writer is not None:
            self.pq_writer.close()
            self.pq_writer = None
            
        if not os.path.exists(self.pq_filename):
            self.last_unsynced_ts_ns = None
            return 0

        offset_ns = 0
        if self.last_unsynced_ts_ns is not None:
            offset_ns = current_ts_ns - self.last_unsynced_ts_ns
            if offset_ns < 0:
                logger.warning(f"Calculated negative time offset: {offset_ns}ns. Using 0.")
                offset_ns = 0

        logger.info(f"Replaying Parquet buffer with offset_ns={offset_ns}")

        count = 0
        try:
            parquet_file = pq.ParquetFile(self.pq_filename)
            for batch in parquet_file.iter_batches():
                d = batch.to_pydict()
                for ts, cid, data in zip(d["ts_ns"], d["can_id"], d["data_bytes"]):
                    true_ts_ns = ts + offset_ns
                    self.writer.decode_and_queue(cid, data, true_ts_ns)
                    count += 1
                    
            logger.info(f"Successfully replayed {count} unsynced points to Influx writer.")
        except Exception as e:
            logger.error(f"Error replaying Parquet buffer: {e}")
        finally:
            try:
                os.remove(self.pq_filename)
            except OSError:
                pass
            self.last_unsynced_ts_ns = None
            
        if count > 10000:
            time.sleep(0.1)
            
        return count

    # ── Process one Redis message ──────────────────────────────────────────

    def process_message(self, raw: str) -> int:
        """Parse the JSON array from Redis, decode each frame, return points queued."""
        count = 0
        try:
            messages = json.loads(raw)
            if not isinstance(messages, list):
                messages = [messages]

            for msg in messages:
                can_id     = msg.get("canId")
                data_bytes = bytes(msg.get("data", []))
                ts_ms      = msg.get("time", int(time.time() * 1000))

                if can_id is not None and len(data_bytes) == 8:
                    ts_ns = int(ts_ms * 1_000_000)
                    
                    if ts_ms < 1742601600000:
                        self.unsynced_buffer.append({
                            "ts_ns": ts_ns,
                            "can_id": can_id,
                            "data_bytes": data_bytes
                        })
                        self.last_unsynced_ts_ns = ts_ns
                        if len(self.unsynced_buffer) >= BATCH_SIZE:
                            self._flush_unsynced_to_parquet()
                    else:
                        if self.last_unsynced_ts_ns is not None:
                            points_replayed = self._flush_parquet_to_influx(ts_ns)
                            count += points_replayed
                            self.msgs_processed += points_replayed
                        
                        count += self.writer.decode_and_queue(can_id, data_bytes, ts_ns)
                        self.msgs_processed += 1
        except json.JSONDecodeError as e:
            logger.error(f"Bad JSON from Redis: {e}")
        except Exception as e:
            self.errors += 1
            logger.error(f"process_message error: {e}")
        return count

    # ── Main loop ──────────────────────────────────────────────────────────

    async def run(self):
        """Subscribe to Redis and write to InfluxDB continuously."""
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
                self.points_written += n

                # Periodic stats log + Redis status key
                now = time.time()
                if now - self._last_stats >= 10:
                    logger.info(
                        f"[InfluxBridge] {self.msgs_processed} CAN msgs → "
                        f"{self.points_written} points written, {self.errors} errors"
                    )
                    await r.set("influx:status", json.dumps({
                        "ok": True,
                        "points": self.points_written,
                        "errors": self.errors,
                        "ts": now,
                    }))
                    self._last_stats = now

        except Exception as e:
            logger.error(f"InfluxBridge fatal: {e}")
            try:
                r_err = redis.from_url(REDIS_URL)
                await r_err.set("influx:status", json.dumps({
                    "ok": False,
                    "error": str(e),
                    "ts": time.time(),
                }))
            except Exception:
                pass
        finally:
            logger.info("InfluxBridge stopping …")
            self.close()

    def close(self):
        self._flush_unsynced_to_parquet()
        if self.pq_writer is not None:
            self.pq_writer.close()
            self.pq_writer = None
        self.writer.close()


# ── Entry point ────────────────────────────────────────────────────────────────

async def run_influx_bridge():
    """Standalone entry point for the bridge."""
    loop = asyncio.get_running_loop()
    utils.register_shutdown_signals(loop, shutdown_event, "InfluxBridge")
    logger.info("Starting Redis → InfluxDB Bridge …")
    bridge = InfluxBridge()
    await bridge.run()


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    )
    try:
        asyncio.run(run_influx_bridge())
    except KeyboardInterrupt:
        logger.info("Interrupted, exiting.")

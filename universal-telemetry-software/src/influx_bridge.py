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
                    ts_ns = ts_ms * 1_000_000
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

                # Periodic stats log
                now = time.time()
                if now - self._last_stats >= 10:
                    logger.info(
                        f"[InfluxBridge] {self.msgs_processed} CAN msgs → "
                        f"{self.points_written} points written, {self.errors} errors"
                    )
                    self._last_stats = now

        except Exception as e:
            logger.error(f"InfluxBridge fatal: {e}")
        finally:
            logger.info("InfluxBridge stopping …")
            self.writer.close()

    def close(self):
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

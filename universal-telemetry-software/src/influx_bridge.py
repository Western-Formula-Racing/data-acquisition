"""
Redis → Local InfluxDB3 Bridge

Subscribes to the Redis `can_messages` channel (same data the WebSocket bridge
forwards to Pecan) and writes every decoded CAN signal into the local InfluxDB3
instance.  Grafana reads from this local instance during test days, so data is
always accessible even without internet.

Measurement / table name is controlled by INFLUX_TABLE (e.g. WFR26_base).
"""

import asyncio
import json
import os
import signal
import time
import logging
from pathlib import Path

import cantools
import redis.asyncio as redis
from influxdb_client import InfluxDBClient, WriteOptions

logger = logging.getLogger("InfluxBridge")

# ── Redis ──────────────────────────────────────────────────────────────────────
REDIS_URL       = os.getenv("REDIS_URL", "redis://localhost:6379/0")
REDIS_CHANNEL   = "can_messages"

# ── Local InfluxDB3 ───────────────────────────────────────────────────────────
INFLUX_URL      = os.getenv("LOCAL_INFLUX_URL", "http://localhost:8181")
INFLUX_TOKEN    = os.getenv("LOCAL_INFLUX_TOKEN", "")
INFLUX_ORG      = os.getenv("LOCAL_INFLUX_ORG", "WFR")
INFLUX_BUCKET   = os.getenv("LOCAL_INFLUX_BUCKET", "WFR26")
INFLUX_TABLE    = os.getenv("INFLUX_TABLE", "WFR26_base")

# ── DBC ────────────────────────────────────────────────────────────────────────
DBC_FILE_PATH   = os.getenv("DBC_FILE_PATH", "/app/example.dbc")

# ── Batching ───────────────────────────────────────────────────────────────────
BATCH_SIZE      = int(os.getenv("INFLUX_BATCH_SIZE", "5000"))
FLUSH_INTERVAL  = int(os.getenv("INFLUX_FLUSH_INTERVAL_MS", "1000"))

shutdown_event  = asyncio.Event()


# ── Helpers ────────────────────────────────────────────────────────────────────

def _resolve_dbc_path() -> Path:
    """Resolve the DBC path from environment or common locations."""
    env_path = Path(DBC_FILE_PATH)
    if env_path.exists():
        return env_path

    candidates = [
        Path("/app/example.dbc"),
        Path("/installer/example.dbc"),
        Path(__file__).parent.parent / "example.dbc",
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate

    raise FileNotFoundError(
        f"Could not find DBC file at '{DBC_FILE_PATH}'. "
        "Set DBC_FILE_PATH or place example.dbc in /app/"
    )


def _escape_tag(val: str) -> str:
    """Escape special characters for InfluxDB line protocol tag values."""
    return val.replace(" ", r"\ ").replace(",", r"\,").replace("=", r"\=")


def _to_line_protocol(measurement: str, tags: dict, fields: dict, ts_ns: int) -> str:
    """Format a single point as InfluxDB line protocol."""
    tag_str = ",".join(f"{_escape_tag(k)}={_escape_tag(str(v))}" for k, v in tags.items())
    field_str = ",".join(
        f"{_escape_tag(k)}={v}" if isinstance(v, (int, float))
        else f'{_escape_tag(k)}="{v}"'
        for k, v in fields.items()
    )
    return f"{measurement},{tag_str} {field_str} {ts_ns}"


# ── Bridge ─────────────────────────────────────────────────────────────────────

class InfluxBridge:
    """Subscribes to Redis CAN messages and writes decoded data to InfluxDB."""

    def __init__(self):
        # DBC
        dbc_path = _resolve_dbc_path()
        self.db = cantools.database.load_file(str(dbc_path))
        logger.info(f"Loaded DBC: {dbc_path} ({len(self.db.messages)} messages)")

        # InfluxDB writer
        self.client = InfluxDBClient(
            url=INFLUX_URL,
            token=INFLUX_TOKEN if INFLUX_TOKEN else None,
            org=INFLUX_ORG,
        )
        self.write_api = self.client.write_api(
            write_options=WriteOptions(
                batch_size=BATCH_SIZE,
                flush_interval=FLUSH_INTERVAL,
                jitter_interval=500,
                retry_interval=5_000,
            )
        )
        logger.info(
            f"InfluxDB writer → {INFLUX_URL}  bucket={INFLUX_BUCKET}  "
            f"table={INFLUX_TABLE}  batch={BATCH_SIZE}"
        )

        # Stats
        self.msgs_processed = 0
        self.points_written  = 0
        self.errors          = 0
        self._last_stats     = time.time()

    # ── Decode ─────────────────────────────────────────────────────────────

    def decode_can(self, can_id: int, data: bytes, ts_ms: int) -> list[str]:
        """Decode a CAN frame into line-protocol strings (one per signal)."""
        lines: list[str] = []
        try:
            message = self.db.get_message_by_frame_id(can_id)
            decoded = message.decode(data)
            ts_ns = ts_ms * 1_000_000  # ms → ns

            for sig_name, raw_val in decoded.items():
                # Handle NamedSignalValue (enums from cantools)
                if hasattr(raw_val, "value") and hasattr(raw_val, "name"):
                    try:
                        val = float(raw_val.value)
                    except (ValueError, TypeError):
                        continue
                elif isinstance(raw_val, (int, float)):
                    val = float(raw_val)
                else:
                    continue

                tags = {
                    "signalName":  sig_name,
                    "messageName": message.name,
                    "canId":       str(can_id),
                }
                fields = {"sensorReading": val}
                lines.append(_to_line_protocol(INFLUX_TABLE, tags, fields, ts_ns))

        except KeyError:
            pass  # CAN ID not in DBC — ignore
        except Exception as e:
            self.errors += 1
            if self.errors <= 10:
                logger.warning(f"Decode error CAN 0x{can_id:03X}: {e}")
        return lines

    # ── Process one Redis message ──────────────────────────────────────────

    def process_message(self, raw: str) -> list[str]:
        """Parse the JSON array from Redis, decode each frame, return lines."""
        lines: list[str] = []
        try:
            messages = json.loads(raw)
            if not isinstance(messages, list):
                messages = [messages]

            for msg in messages:
                can_id    = msg.get("canId")
                data_bytes = bytes(msg.get("data", []))
                ts_ms     = msg.get("time", int(time.time() * 1000))

                if can_id is not None and len(data_bytes) == 8:
                    lines.extend(self.decode_can(can_id, data_bytes, ts_ms))
                    self.msgs_processed += 1
        except json.JSONDecodeError as e:
            logger.error(f"Bad JSON from Redis: {e}")
        except Exception as e:
            logger.error(f"process_message error: {e}")
        return lines

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

                data = message["data"]
                if isinstance(data, bytes):
                    data = data.decode("utf-8")

                lines = self.process_message(data)
                if lines:
                    try:
                        self.write_api.write(
                            bucket=INFLUX_BUCKET,
                            org=INFLUX_ORG,
                            record=lines,
                        )
                        self.points_written += len(lines)
                    except Exception as e:
                        logger.error(f"InfluxDB write error: {e}")

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
            self.write_api.close()
            self.client.close()

    def close(self):
        self.write_api.close()
        self.client.close()


# ── Entry point ────────────────────────────────────────────────────────────────

async def run_influx_bridge():
    """Standalone entry point for the bridge."""
    loop = asyncio.get_running_loop()

    def _shutdown():
        logger.info("Shutting down InfluxBridge …")
        shutdown_event.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, _shutdown)

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

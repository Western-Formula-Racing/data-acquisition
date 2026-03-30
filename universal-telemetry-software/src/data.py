import asyncio
import socket
import struct
import time
import os
import json
import logging
import can
import redis.asyncio as aioredis
from collections import deque

from src.config import (
    REMOTE_IP, UDP_PORT, TCP_PORT,
    REDIS_URL, REDIS_CAN_CHANNEL, REDIS_UPLINK_CHANNEL, ENABLE_UPLINK,
)
from src import redis_utils, utils

BATCH_SIZE = 20
BATCH_TIMEOUT = 0.05  # 50ms
BUFFER_DURATION = 60  # 1 minute ring buffer
MISSING_CHECK_INTERVAL = 10.0
UPLINK_MAGIC = b'\xCA\xFE'

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

class CANMessage:
    def __init__(self, timestamp, can_id, data):
        self.timestamp = timestamp
        self.can_id = can_id
        self.data = data

    def pack(self):
        # timestamp (double), can_id (uint32), data (8 bytes)
        return struct.pack("!dI8s", self.timestamp, self.can_id, self.data)

    @classmethod
    def unpack(cls, binary_data):
        timestamp, can_id, data = struct.unpack("!dI8s", binary_data)
        return cls(timestamp, can_id, data)

ECU_TIMESTAMP_ID = 1999  # VCU_Timestamp — ECU broadcasts RTC epoch ms at 1 Hz

# If RPi system clock is already past this date, trust it without waiting for ECU sync.
# This covers RPis that have NTP or were manually set via the status page (/set-time).
# Update each season if clocks are known to be unreliable.
# NOTE: 2026-03-22 is today's date at time of writing.
_SYSTEM_CLOCK_TRUST_EPOCH = 1742601600.0  # 2026-03-22 00:00:00 UTC

class TelemetryNode:
    def __init__(self, can_event=None, telemetry_event=None):
        self.buffer = deque()
        self.seq_num = 0
        self.received_messages = {} # seq_num -> message_batch
        self.role = os.getenv("ROLE", "auto")
        self.has_can = False
        self.can_event = can_event  # multiprocessing.Event signalled on each CAN RX
        self.telemetry_event = telemetry_event  # heartbeat for LED status
        self.redis_client = redis_utils.get_sync_client(REDIS_URL)
        # ECU clock sync — offset between ECU RTC and local monotonic clock
        self._clock_offset: float | None = None   # epoch_sec - monotonic at last sync
        self._last_ecu_sync: float = 0.0          # monotonic time of last valid ECU 1999
        self._sync_source: str = "none"           # "ecu_rtc" | "system_clock" | "override"
        self._base_to_car_offset: float | None = None # Offset between base station time and car's 1970 time
        self._last_raw_car_time: float | None = None  # Raw timestamp of last message
        self._car_internal_jump: float | None = None  # Cumulative jump from 1970 to 2026+ internal car time

    def publish(self, channel, data):
        redis_utils.safe_publish(self.redis_client, channel, data, logger)

    def _handle_ecu_timestamp(self, data: bytes) -> None:
        """Extract epoch_ms from ECU VCU_Timestamp message and update clock offset."""
        if len(data) < 8:
            return
        epoch_ms = struct.unpack_from("<q", data)[0]  # int64 little-endian
        if epoch_ms <= 0:
            return
        mono = time.monotonic()
        self._clock_offset = epoch_ms / 1000.0 - mono
        self._last_ecu_sync = mono
        self._sync_source = "ecu_rtc"
        logger.info(f"ECU time sync: epoch={epoch_ms/1000:.3f}  offset={self._clock_offset:+.3f}s")

    def _try_auto_sync(self) -> None:
        """Check fallback time sources when no ECU sync has arrived yet.

        Priority:
          1. ECU RTC (handled by _handle_ecu_timestamp, always wins)
          2. RPi system clock past _SYSTEM_CLOCK_TRUST_EPOCH — covers NTP-synced RPis
             and RPis whose clock was manually set via POST /set-time on the status page.
        """
        if self._clock_offset is not None:
            return  # already synced

        sys_time = time.time()

        if sys_time > _SYSTEM_CLOCK_TRUST_EPOCH:
            self._clock_offset = sys_time - time.monotonic()
            self._sync_source = "system_clock"
            logger.info(
                f"System clock past 2026-03-22 ({sys_time:.0f}), trusting RPi clock. "
                "Update _SYSTEM_CLOCK_TRUST_EPOCH if RPi clock is known bad."
            )

    def _corrected_time(self) -> float:
        """Return current time using the best available clock source."""
        if self._clock_offset is not None:
            return time.monotonic() + self._clock_offset
        return time.time()

    @property
    def _ecu_synced(self) -> bool:
        return self._clock_offset is not None

    def detect_role(self):
        if self.role != "auto":
            logger.info(f"Role explicitly set to: {self.role}")
            return self.role
        
        try:
            # Try to see if can0 exists
            with can.interface.Bus(channel='can0', bustype='socketcan') as bus:
                logger.info("Detected CAN bus (can0). Setting role to CAR.")
                self.has_can = True
                return "car"
        except Exception:
            logger.info("No CAN bus detected. Setting role to BASE.")
            return "base"

    async def run_car(self):
        logger.info("Starting Car Mode...")
        queue = asyncio.Queue()

        # CAN Reader Task
        async def can_reader():
            use_simulation = os.getenv("SIMULATE", "false").lower() == "true"
            bus = None

            if not use_simulation:
                try:
                    bus = can.interface.Bus(channel='can0', bustype='socketcan')
                    logger.info("CAN Reader started on can0")
                except Exception as e:
                    logger.critical(f"FATAL: CAN Bus initialization failed ({e}). "
                                    f"Ensure 'can0' is UP or set SIMULATE=true.")
                    raise RuntimeError(f"CAN Bus initialization failed: {e}") from e

            if use_simulation:
                logger.warning("="*60)
                logger.warning("  ███  SIMULATION MODE ACTIVE  ███")
                logger.warning("  Generating fake CAN frames — NOT reading real hardware!")
                logger.warning("="*60)
                import random

                # Standard IDs from example.dbc: 192 (VCU), 256 (MC), 512 (BMS), 768 (Wheels)
                # Extended IDs from example.dbc (actual 29-bit arbitration IDs, no EFF bit):
                #   403105268 = 0x1806E5F4  Charger_Command  (DBC ID 2550588916)
                #   419385573 = 0x18FF50E5  Charger_Status   (DBC ID 2566869221)
                sim_ids = [192, 256, 512, 768, 403105268, 419385573]

                while True:
                    await asyncio.sleep(0.01)  # ~100 Hz
                    can_id = random.choice(sim_ids)
                    data = bytes([random.randint(0, 255) for _ in range(8)])
                    if self.can_event is not None:
                        self.can_event.set()
                    telemetry_msg = CANMessage(self._corrected_time(), can_id, data)
                    await queue.put(telemetry_msg)
                return  # unreachable, but makes intent clear

            # ── Real CAN read loop ────────────────────────────────────────
            loop = asyncio.get_running_loop()
            consecutive_errors = 0
            MAX_CONSECUTIVE_ERRORS = 50  # give up after sustained failures

            while True:
                try:
                    msg = await loop.run_in_executor(None, lambda: bus.recv(0.1))
                    consecutive_errors = 0  # reset on any successful call
                    if msg:
                        # Skip error/remote frames (generated when can0 is up but bus disconnected)
                        if msg.is_error_frame or msg.is_remote_frame:
                            logger.debug(f"Filtered CAN noise/error frame: ID={msg.arbitration_id}")
                            continue
                        if self.can_event is not None:
                            self.can_event.set()
                        if msg.arbitration_id == ECU_TIMESTAMP_ID:
                            self._handle_ecu_timestamp(bytes(msg.data))
                        if not self._ecu_synced:
                            self._try_auto_sync()
                        telemetry_msg = CANMessage(self._corrected_time(), msg.arbitration_id, msg.data)
                        await queue.put(telemetry_msg)
                except Exception as e:
                    consecutive_errors += 1
                    logger.error(f"CAN recv() error #{consecutive_errors}: {e}")
                    if consecutive_errors >= MAX_CONSECUTIVE_ERRORS:
                        logger.error(
                            f"CAN recv() failed {MAX_CONSECUTIVE_ERRORS} times in a row. "
                            "CAN interface is likely dead. Stopping CAN reader "
                            "(restart container to retry). NOT entering simulation."
                        )
                        return
                    await asyncio.sleep(1.0)  # backoff before retry

        # UDP Sender Task
        async def udp_sender():
            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            try:
                # Set Type of Service (ToS) to IPTOS_LOWDELAY (0x10) for high priority
                sock.setsockopt(socket.IPPROTO_IP, socket.IP_TOS, 0x10)
            except Exception:
                pass # Might not be supported on all platforms/containers

            batch = []
            last_send = time.time()
            
            while True:
                try:
                    msg = await asyncio.wait_for(queue.get(), timeout=BATCH_TIMEOUT)
                    batch.append(msg)
                except asyncio.TimeoutError:
                    pass

                if batch and (len(batch) >= BATCH_SIZE or (time.time() - last_send) >= BATCH_TIMEOUT):
                    self.seq_num += 1
                    # Pack: Seq (uint64), Count (uint16), then messages
                    payload = struct.pack("!QH", self.seq_num, len(batch))
                    for m in batch:
                        payload += m.pack()
                    
                    try:
                        sock.sendto(payload, (REMOTE_IP, UDP_PORT))
                    except (PermissionError, OSError) as e:
                        # This can happen if iptables is blocking the packet
                        logger.debug(f"UDP send failed: {e}")

                    # Publish locally to Redis so the WebSocket bridge
                    # can serve data to PECAN without a base station.
                    msgs_to_publish = [{
                        "time": int(m.timestamp * 1000),
                        "canId": m.can_id,
                        "data": list(m.data)
                    } for m in batch]
                    self.publish(REDIS_CAN_CHANNEL, json.dumps(msgs_to_publish))

                    # Store in ring buffer (1 min)
                    self.buffer.append((self.seq_num, batch, time.time()))
                    while self.buffer and time.time() - self.buffer[0][2] > BUFFER_DURATION:
                        self.buffer.popleft()

                    batch = []
                    last_send = time.time()

        # Heartbeat Injector Task — fallback when no ECU on bus (e.g. bench testing)
        async def inject_heartbeat():
            while True:
                try:
                    # Only inject if no ECU time sync received in the last 3s
                    if time.monotonic() - self._last_ecu_sync > 3.0:
                        epoch_ms = int(time.time() * 1000)
                        timestamp_bytes = struct.pack("<q", epoch_ms)  # int64 LE, matches ECU format
                        self._handle_ecu_timestamp(timestamp_bytes)   # also updates clock offset
                        self._sync_source = "system_clock"            # override: not a real ECU sync
                        hb_msg = CANMessage(self._corrected_time(), ECU_TIMESTAMP_ID, timestamp_bytes)
                        await queue.put(hb_msg)
                except Exception as e:
                    logger.debug(f"Failed to inject heartbeat: {e}")

                await asyncio.sleep(1.0)

        # TCP Resend Server
        async def handle_resend(reader, writer):
            data = await reader.read(1024)
            try:
                request = json.loads(data.decode())
                missing_seqs = request.get("missing", [])
                logger.info(f"Resend request for {len(missing_seqs)} batches")
                
                # Find missing batches in buffer
                response = []
                buffer_lookup = {item[0]: item[1] for item in self.buffer}
                
                for seq in missing_seqs:
                    if seq in buffer_lookup:
                        # Simple format for resend: [seq, [msgs...]]
                        msgs = [{"t": m.timestamp, "id": m.can_id, "d": m.data.hex()} for m in buffer_lookup[seq]]
                        response.append({"seq": seq, "msgs": msgs})
                
                writer.write(json.dumps(response).encode() + b"\n")
                await writer.drain()
            except Exception as e:
                logger.error(f"Resend error: {e}")
            finally:
                writer.close()
                await writer.wait_closed()

        # Uplink Receiver Task — listen for 0xCAFE uplink packets and write to CAN bus
        async def uplink_receiver():
            if not ENABLE_UPLINK:
                logger.info("Car uplink receiver DISABLED (set ENABLE_UPLINK=true to enable)")
                return

            logger.info("Car uplink receiver ENABLED — listening for 0xCAFE packets")
            uplink_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            uplink_sock.bind(('0.0.0.0', UDP_PORT))
            uplink_sock.setblocking(False)
            loop = asyncio.get_running_loop()

            # Try to open CAN bus for writing
            can_bus = None
            if os.getenv("SIMULATE", "false").lower() != "true":
                try:
                    can_bus = can.interface.Bus(channel='can0', bustype='socketcan')
                    logger.info("Uplink CAN bus opened for writing on can0")
                except Exception as e:
                    logger.warning(f"Uplink: could not open CAN bus for writing ({e}). Messages will be logged only.")

            while True:
                try:
                    data = await loop.sock_recv(uplink_sock, 4096)
                except Exception as e:
                    logger.error(f"Uplink receive error: {e}")
                    await asyncio.sleep(0.1)
                    continue

                # Check for 0xCAFE magic header
                if len(data) < 12 or data[:2] != UPLINK_MAGIC:
                    continue

                seq, count = struct.unpack("!QH", data[2:12])
                offset = 12
                for _ in range(count):
                    if offset + 20 > len(data):
                        break
                    msg = CANMessage.unpack(data[offset:offset + 20])
                    offset += 20

                    # Write to CAN bus
                    if can_bus:
                        try:
                            can_msg = can.Message(
                                arbitration_id=msg.can_id,
                                data=msg.data,
                                is_extended_id=msg.can_id > 0x7FF,
                            )
                            can_bus.send(can_msg)
                            logger.info(f"Uplink CAN write: canId={msg.can_id} seq={seq}")
                        except Exception as e:
                            logger.error(f"Uplink CAN send failed: {e}")
                    else:
                        logger.info(f"Uplink received (sim): canId={msg.can_id} data={list(msg.data)} seq={seq}")

        resend_server = await asyncio.start_server(handle_resend, '0.0.0.0', TCP_PORT)

        # Throughput listener for link diagnostics burst test
        from src.throughput_listener import throughput_listener_task

        tasks = [
            can_reader(),
            udp_sender(),
            resend_server.serve_forever(),
            throughput_listener_task(),
            utils.heartbeat_coro(self.telemetry_event),
            inject_heartbeat(),
        ]
        if ENABLE_UPLINK:
            tasks.append(uplink_receiver())
        await asyncio.gather(*tasks)

    async def run_base(self):
        logger.info("Starting Base Station Mode...")
        expected_seq = None
        missing_seqs = set()
        stats = {"received": 0, "missing": 0, "recovered": 0, "messages": 0}
        
        # UDP Receiver Task
        async def udp_receiver():
            nonlocal expected_seq
            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            sock.bind(('0.0.0.0', UDP_PORT))
            sock.setblocking(False)
            loop = asyncio.get_running_loop()
            
            logger.info(f"Listening for UDP on {UDP_PORT}")
            while True:
                try:
                    data = await loop.sock_recv(sock, 4096)
                except Exception as e:
                    logger.error(f"Receive error: {e}")
                    await asyncio.sleep(0.1)
                    continue

                if len(data) < 10: continue
                
                seq, count = struct.unpack("!QH", data[:10])
                
                if expected_seq is None:
                    expected_seq = seq
                    logger.info(f"Initial sequence: {seq}")

                # Sequence reset detection (e.g. car restarted)
                if expected_seq is not None and seq < expected_seq - 1000:
                    logger.info(f"Sequence reset detected. Expected {expected_seq}, got {seq}. Resetting expected_seq.")
                    expected_seq = seq
                    missing_seqs.clear()
                
                if seq > expected_seq:
                    # Gap detected
                    gap = seq - expected_seq
                    stats["missing"] += gap
                    for s in range(expected_seq, seq):
                        missing_seqs.add(s)
                        # Keep missing list manageable
                        if len(missing_seqs) > 1000:
                            missing_seqs.remove(min(missing_seqs))
                elif seq < expected_seq:
                    # Out of order or duplicate
                    if seq in missing_seqs:
                        missing_seqs.remove(seq)
                        stats["recovered"] += 1
                        stats["received"] += 1
                        stats["messages"] += count
                    else:
                        # Duplicate packet: ignore
                        continue
                        
                if seq >= expected_seq:
                    stats["received"] += 1
                    stats["messages"] += count
                
                expected_seq = max(expected_seq, seq + 1)
                
                # Process messages
                offset = 10
                msgs_to_publish = []
                for _ in range(count):
                    if offset + 20 > len(data): break
                    msg = CANMessage.unpack(data[offset:offset+20])
                    if msg.can_id == ECU_TIMESTAMP_ID:
                        self._handle_ecu_timestamp(bytes(msg.data))
                        
                    msg_time = msg.timestamp
                    base_pi_time = time.time()
                    
                    # 1. Detect Car ECU Time Jump
                    if self._last_raw_car_time is not None:
                        jump = msg_time - self._last_raw_car_time
                        if jump > 315360000: # Jumped > 10 years (1970 to 2026)
                            self._car_internal_jump = jump
                            logger.info(f"Car jump detected! size: {jump}s")
                            # Calculate the true correction between true time and what the continuous timeline says
                            current_offset = self._base_to_car_offset or 0.0
                            correction = msg_time - (self._last_raw_car_time + current_offset)
                            
                            session_id = os.environ.get("BOOT_SESSION_ID", "default")
                            sync_states_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "sync_states")
                            os.makedirs(sync_states_dir, exist_ok=True)
                            
                            sidecar_path = os.path.join(sync_states_dir, f"correction_{session_id}.json")
                            with open(sidecar_path, "w") as f:
                                json.dump({
                                    "boot_session_id": session_id,
                                    "correction_seconds": correction,
                                    "created_at": base_pi_time,
                                    "base_timeline_start": (self._last_raw_car_time + current_offset)
                                }, f)
                                
                    self._last_raw_car_time = msg_time

                    # 2. Reverse the Car's internal jump so the Base Timeline stays perfectly continuous locally
                    effective_msg_time = msg_time
                    if self._car_internal_jump is not None:
                        effective_msg_time -= self._car_internal_jump

                    # 3. Apply Base Pi overrides (if the car started in 1970)
                    if effective_msg_time < 1742601600 and base_pi_time > _SYSTEM_CLOCK_TRUST_EPOCH:
                        if self._base_to_car_offset is None:
                            self._base_to_car_offset = base_pi_time - effective_msg_time
                        msg_time_ms = int((effective_msg_time + self._base_to_car_offset) * 1000)
                    else:
                        msg_time_ms = int(effective_msg_time * 1000)
                        
                    msgs_to_publish.append({
                        "time": msg_time_ms,
                        "canId": msg.can_id,
                        "data": list(msg.data)
                    })
                    offset += 20
                
                if msgs_to_publish:
                    self.publish(REDIS_CAN_CHANNEL, json.dumps(msgs_to_publish))

                # Yield to the event loop so stats_publisher, heartbeat, etc.
                # get a chance to run even when packets arrive back-to-back.
                await asyncio.sleep(0)

        # Missing Packet Reporter Task
        async def missing_reporter():
            while True:
                await asyncio.sleep(MISSING_CHECK_INTERVAL)
                if missing_seqs:
                    # Only request what could still be in the 1-min buffer
                    # This is a guestimate based on seq numbers
                    logger.info(f"Requesting resend for {len(missing_seqs)} batches")
                    try:
                        reader, writer = await asyncio.open_connection(REMOTE_IP, TCP_PORT)
                        request = {"missing": sorted(list(missing_seqs))[-100:]} # Limit request size
                        writer.write(json.dumps(request).encode())
                        await writer.drain()
                        
                        data = await reader.read(65536)
                        if not data: continue
                        
                        resends = json.loads(data.decode())
                        stats["recovered"] += len(resends)
                        for item in resends:
                            seq = item['seq']
                            if seq in missing_seqs:
                                msgs = []
                                for m in item['msgs']:
                                    msg_time = m['t']
                                    base_pi_time = time.time()
                                    
                                    # For missing messages, just use the fallback jump logic 
                                    effective_msg_time = msg_time
                                    if self._car_internal_jump is not None:
                                        effective_msg_time -= self._car_internal_jump
                                        
                                    if effective_msg_time < 1742601600 and base_pi_time > _SYSTEM_CLOCK_TRUST_EPOCH:
                                        if self._base_to_car_offset is None:
                                            self._base_to_car_offset = base_pi_time - effective_msg_time
                                        msg_time_ms = int((effective_msg_time + self._base_to_car_offset) * 1000)
                                    else:
                                        msg_time_ms = int(effective_msg_time * 1000)
                                        
                                    msgs.append({
                                        "time": msg_time_ms,
                                        "canId": m['id'],
                                        "data": list(bytes.fromhex(m['d']))
                                    })
                                self.publish(REDIS_CAN_CHANNEL, json.dumps(msgs))
                                missing_seqs.remove(seq)
                        
                        writer.close()
                        await writer.wait_closed()
                    except Exception as e:
                        logger.error(f"Failed to request resends: {e}")

        # Stats Publisher Task
        async def stats_publisher():
            while True:
                await asyncio.sleep(1)
                influx_raw = self.redis_client.get("influx:status") if self.redis_client else None
                influx_status = None
                if influx_raw:
                    try:
                        influx_status = json.loads(influx_raw)
                    except (json.JSONDecodeError, UnicodeDecodeError):
                        logger.warning(f"influx:status contains invalid JSON: {influx_raw!r}")
                payload = {
                    "type": "system_stats",
                    **stats,
                    "ecu_synced": self._ecu_synced,
                    "ecu_sync_source": self._sync_source,
                    "influx": influx_status,
                }
                self.publish("system_stats", json.dumps(payload))
                stats["received"] = 0
                stats["missing"] = 0
                stats["recovered"] = 0
                stats["messages"] = 0

        # Uplink Relay Task — subscribe to Redis can_uplink and forward to car via UDP
        async def uplink_relay():
            if not ENABLE_UPLINK:
                logger.info("Uplink relay DISABLED (set ENABLE_UPLINK=true to enable)")
                return

            logger.info("Uplink relay ENABLED — subscribing to can_uplink channel")
            uplink_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            uplink_seq = 0

            try:
                r = aioredis.from_url(REDIS_URL)
                pubsub = r.pubsub()
                await pubsub.subscribe(REDIS_UPLINK_CHANNEL)
                logger.info(f"Subscribed to Redis channel: {REDIS_UPLINK_CHANNEL}")

                async for message in pubsub.listen():
                    if message['type'] != 'message':
                        continue

                    try:
                        data = redis_utils.decode_message(message['data'])
                        uplink_msg = json.loads(data)

                        can_id = uplink_msg.get("canId")
                        can_data = uplink_msg.get("data", [])
                        ref = uplink_msg.get("ref", "unknown")

                        if can_id is None or not isinstance(can_id, int) or can_id < 0:
                            logger.warning(f"Uplink relay: invalid canId in ref={ref}")
                            continue
                        if not isinstance(can_data, list) or len(can_data) < 1 or len(can_data) > 8:
                            logger.warning(f"Uplink relay: invalid data in ref={ref}")
                            continue

                        # Pack as uplink UDP packet: 0xCAFE + seq + count(1) + CAN message
                        uplink_seq += 1
                        data_bytes = bytes(can_data) + b'\x00' * (8 - len(can_data))
                        can_msg = CANMessage(time.time(), can_id, data_bytes)

                        payload = UPLINK_MAGIC
                        payload += struct.pack("!QH", uplink_seq, 1)
                        payload += can_msg.pack()

                        try:
                            uplink_sock.sendto(payload, (REMOTE_IP, UDP_PORT))
                            logger.info(f"Uplink relayed to car: canId={can_id} ref={ref} seq={uplink_seq}")
                        except (PermissionError, OSError) as e:
                            logger.error(f"Uplink UDP send failed: {e}")

                    except Exception as e:
                        logger.error(f"Uplink relay error: {e}")

            except Exception as e:
                logger.error(f"Uplink relay Redis error: {e}")
            finally:
                uplink_sock.close()

        tasks = [udp_receiver(), missing_reporter(), stats_publisher(), utils.heartbeat_coro(self.telemetry_event)]
        if ENABLE_UPLINK:
            tasks.append(uplink_relay())
        await asyncio.gather(*tasks)

    async def start(self):
        role = self.detect_role()
        if role == "car":
            await self.run_car()
        else:
            await self.run_base()

if __name__ == "__main__":
    node = TelemetryNode()
    asyncio.run(node.start())

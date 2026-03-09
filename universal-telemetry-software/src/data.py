import asyncio
import socket
import struct
import time
import os
from datetime import datetime, timezone
import json
import logging
import can
import redis
import redis.asyncio as aioredis
from collections import deque

# Configuration
UDP_IP = os.getenv("REMOTE_IP", "192.168.1.100") # IP of the other side
UDP_PORT = int(os.getenv("UDP_PORT", 5005))
TCP_PORT = int(os.getenv("TCP_PORT", 5006))
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
REDIS_CHANNEL = "can_messages"
REDIS_UPLINK_CHANNEL = "can_uplink"
ENABLE_UPLINK = os.getenv("ENABLE_UPLINK", "false").lower() == "true"
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

class TelemetryNode:
    def __init__(self, can_event=None, telemetry_event=None):
        self.buffer = deque()
        self.seq_num = 0
        self.received_messages = {} # seq_num -> message_batch
        self.role = os.getenv("ROLE", "auto")
        self.has_can = False
        self.can_event = can_event  # multiprocessing.Event signalled on each CAN RX
        self.telemetry_event = telemetry_event  # heartbeat for LED status
        try:
            self.redis_client = redis.from_url(REDIS_URL)
            self.redis_client.ping()
            logger.info("Connected to Redis")
        except Exception as e:
            logger.warning(f"Could not connect to Redis: {e}. Data will not be published to Redis.")
            self.redis_client = None

    def publish(self, channel, data):
        if self.redis_client:
            try:
                self.redis_client.publish(channel, data)
            except Exception as e:
                logger.error(f"Redis publish error: {e}")

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
            try:
                # Check for simulation mode
                if os.getenv("SIMULATE", "false").lower() == "true":
                    raise Exception("Simulation requested")

                # Note: Adjust interface as needed for RPi (e.g., mcp2515)
                bus = can.interface.Bus(channel='can0', bustype='socketcan')
                logger.info("CAN Reader started on can0")
                loop = asyncio.get_running_loop()
                while True:
                    msg = await loop.run_in_executor(None, lambda: bus.recv(0.1))
                    if msg:
                        if self.can_event is not None:
                            self.can_event.set()
                        telemetry_msg = CANMessage(msg.timestamp, msg.arbitration_id, msg.data)
                        await queue.put(telemetry_msg)
            except Exception as e:
                logger.warning(f"CAN Interface unavailable ({e}). Starting simulation mode.")
                import random
                
                # Standard IDs from example.dbc: 192 (VCU), 256 (MC), 512 (BMS), 768 (Wheels)
                # Extended IDs from example.dbc (actual 29-bit arbitration IDs, no EFF bit):
                #   403105268 = 0x1806E5F4  Charger_Command  (DBC ID 2550588916)
                #   419385573 = 0x18FF50E5  Charger_Status   (DBC ID 2566869221)
                sim_ids = [192, 256, 512, 768, 403105268, 419385573]
                
                while True:
                    # Generate a fake message every ~10ms (100Hz)
                    await asyncio.sleep(0.01) 
                    
                    can_id = random.choice(sim_ids)
                    data = bytes([random.randint(0, 255) for _ in range(8)])
                    
                    # Create valid-looking data for specific IDs to make graphs look nice
                    if can_id == 192: # VCU
                        # specific byte manipulation if needed, else random is fine for "alive" check
                        pass
                        
                    if self.can_event is not None:
                        self.can_event.set()
                    telemetry_msg = CANMessage(time.time(), can_id, data)
                    await queue.put(telemetry_msg)

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
                        sock.sendto(payload, (UDP_IP, UDP_PORT))
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
                    self.publish(REDIS_CHANNEL, json.dumps(msgs_to_publish))

                    # Store in ring buffer (1 min)
                    self.buffer.append((self.seq_num, batch, time.time()))
                    while self.buffer and time.time() - self.buffer[0][2] > BUFFER_DURATION:
                        self.buffer.popleft()

                    batch = []
                    last_send = time.time()

        # Heartbeat Injector Task
        async def inject_heartbeat():
            while True:
                try:
                    # Inject a heartbeat message (ID 1999) every second
                    # Payload: 8-bytes representing UTC time as YYYYMMDDHHMMSS (uint64, little-endian)
                    utc_int = int(datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S"))
                    timestamp_bytes = struct.pack("<Q", utc_int)
                    hb_msg = CANMessage(time.time(), 1999, timestamp_bytes)
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

        async def heartbeat():
            while True:
                if self.telemetry_event is not None:
                    self.telemetry_event.set()
                await asyncio.sleep(1)

        tasks = [
            can_reader(),
            udp_sender(),
            resend_server.serve_forever(),
            throughput_listener_task(),
            heartbeat(),
            inject_heartbeat(),
        ]
        if ENABLE_UPLINK:
            tasks.append(uplink_receiver())
        await asyncio.gather(*tasks)

    async def run_base(self):
        logger.info("Starting Base Station Mode...")
        expected_seq = None
        missing_seqs = set()
        stats = {"received": 0, "missing": 0, "recovered": 0}
        
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
                
                stats["received"] += 1
                seq, count = struct.unpack("!QH", data[:10])
                
                if expected_seq is None:
                    expected_seq = seq
                    logger.info(f"Initial sequence: {seq}")
                
                if seq > expected_seq:
                    # Gap detected
                    gap = seq - expected_seq
                    stats["missing"] += gap
                    for s in range(expected_seq, seq):
                        missing_seqs.add(s)
                        # Keep missing list manageable
                        if len(missing_seqs) > 1000:
                            missing_seqs.remove(min(missing_seqs))
                
                if seq in missing_seqs:
                    missing_seqs.remove(seq)
                
                expected_seq = max(expected_seq, seq + 1)
                
                # Process messages
                offset = 10
                msgs_to_publish = []
                for _ in range(count):
                    if offset + 20 > len(data): break
                    msg = CANMessage.unpack(data[offset:offset+20])
                    msgs_to_publish.append({
                        "time": int(msg.timestamp * 1000),
                        "canId": msg.can_id,
                        "data": list(msg.data)
                    })
                    offset += 20
                
                if msgs_to_publish:
                    self.publish(REDIS_CHANNEL, json.dumps(msgs_to_publish))

        # Missing Packet Reporter Task
        async def missing_reporter():
            while True:
                await asyncio.sleep(MISSING_CHECK_INTERVAL)
                if missing_seqs:
                    # Only request what could still be in the 1-min buffer
                    # This is a guestimate based on seq numbers
                    logger.info(f"Requesting resend for {len(missing_seqs)} batches")
                    try:
                        reader, writer = await asyncio.open_connection(UDP_IP, TCP_PORT)
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
                                msgs = [{"time": int(m['t']*1000), "canId": m['id'], "data": list(bytes.fromhex(m['d']))} for m in item['msgs']]
                                self.publish(REDIS_CHANNEL, json.dumps(msgs))
                                missing_seqs.remove(seq)
                        
                        writer.close()
                        await writer.wait_closed()
                    except Exception as e:
                        logger.error(f"Failed to request resends: {e}")

        # Stats Publisher Task
        async def stats_publisher():
            while True:
                await asyncio.sleep(1)
                self.publish("system_stats", json.dumps(stats))
                # Reset counters (except we keep accumulating or just send rate? rate is better)
                # Let's send rate per second
                stats["received"] = 0
                stats["missing"] = 0
                stats["recovered"] = 0

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
                        data = message['data']
                        if isinstance(data, bytes):
                            data = data.decode('utf-8')
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
                            uplink_sock.sendto(payload, (UDP_IP, UDP_PORT))
                            logger.info(f"Uplink relayed to car: canId={can_id} ref={ref} seq={uplink_seq}")
                        except (PermissionError, OSError) as e:
                            logger.error(f"Uplink UDP send failed: {e}")

                    except Exception as e:
                        logger.error(f"Uplink relay error: {e}")

            except Exception as e:
                logger.error(f"Uplink relay Redis error: {e}")
            finally:
                uplink_sock.close()

        async def heartbeat():
            while True:
                if self.telemetry_event is not None:
                    self.telemetry_event.set()
                await asyncio.sleep(1)

        tasks = [udp_receiver(), missing_reporter(), stats_publisher(), heartbeat()]
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

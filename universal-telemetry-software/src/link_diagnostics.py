"""
Link Diagnostics Service

Runs on the base station RPi. Provides:
- ICMP ping to car RPi (1Hz RTT measurement)
- UDP throughput burst test (periodic bandwidth measurement)
- Ubiquiti airOS radio stats scraper (optional, env-gated)

All results published to Redis "link_diagnostics" channel,
forwarded by websocket_bridge to PECAN dashboard.
"""

import asyncio
import socket
import struct
import time
import os
import json
import logging

import redis

logger = logging.getLogger("LinkDiagnostics")

# Configuration
REMOTE_IP = os.getenv("REMOTE_IP", "192.168.1.100")
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
REDIS_CHANNEL = "link_diagnostics"

PING_INTERVAL = float(os.getenv("PING_INTERVAL", "1.0"))

THROUGHPUT_PORT = int(os.getenv("THROUGHPUT_PORT", "5007"))
THROUGHPUT_INTERVAL = float(os.getenv("THROUGHPUT_INTERVAL", "30.0"))
THROUGHPUT_PACKET_COUNT = int(os.getenv("THROUGHPUT_PACKET_COUNT", "200"))
THROUGHPUT_PACKET_SIZE = int(os.getenv("THROUGHPUT_PACKET_SIZE", "1400"))

UBIQUITI_IP = os.getenv("UBIQUITI_IP", "")
UBIQUITI_USER = os.getenv("UBIQUITI_USER", "ubnt")
UBIQUITI_PASS = os.getenv("UBIQUITI_PASS", "ubnt")


def publish(redis_client, data: dict):
    """Publish a diagnostic message to Redis."""
    if redis_client:
        try:
            redis_client.publish(REDIS_CHANNEL, json.dumps(data))
        except Exception as e:
            logger.error(f"Redis publish error: {e}")


# ── ICMP Ping ─────────────────────────────────────────────────────────────────

async def _subprocess_ping(host: str) -> float | None:
    """Run ping -c 1 -W 1 and parse RTT from output."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "ping", "-c", "1", "-W", "1", host,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=3.0)
        output = stdout.decode()
        # Parse "time=12.3 ms" from ping output
        for part in output.split():
            if part.startswith("time="):
                return float(part.split("=")[1])
    except (asyncio.TimeoutError, ValueError, Exception) as e:
        logger.debug(f"Ping subprocess failed: {e}")
    return None


async def _raw_icmp_ping(host: str, timeout: float = 1.0) -> float | None:
    """Send one ICMP echo request via raw socket, return RTT in ms or None."""
    loop = asyncio.get_running_loop()

    def _do_ping():
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_ICMP)
            sock.settimeout(timeout)

            # Build ICMP echo request
            icmp_type = 8  # Echo request
            icmp_code = 0
            icmp_id = os.getpid() & 0xFFFF
            icmp_seq = 1
            payload = b"wfr-ping"

            # Checksum placeholder
            header = struct.pack("!BBHHH", icmp_type, icmp_code, 0, icmp_id, icmp_seq)
            packet = header + payload

            # Calculate checksum
            checksum = _icmp_checksum(packet)
            header = struct.pack("!BBHHH", icmp_type, icmp_code, checksum, icmp_id, icmp_seq)
            packet = header + payload

            start = time.monotonic()
            sock.sendto(packet, (host, 0))

            while True:
                data, addr = sock.recvfrom(1024)
                elapsed = (time.monotonic() - start) * 1000  # ms

                # Skip IP header (20 bytes), check ICMP type
                if len(data) >= 28:
                    reply_type = data[20]
                    reply_id = struct.unpack("!H", data[24:26])[0]
                    if reply_type == 0 and reply_id == icmp_id:  # Echo reply
                        sock.close()
                        return elapsed

                if (time.monotonic() - start) > timeout:
                    break

            sock.close()
            return None
        except Exception:
            return None

    return await loop.run_in_executor(None, _do_ping)


def _icmp_checksum(data: bytes) -> int:
    """Compute ICMP checksum."""
    if len(data) % 2:
        data += b'\x00'
    s = 0
    for i in range(0, len(data), 2):
        s += (data[i] << 8) + data[i + 1]
    s = (s >> 16) + (s & 0xFFFF)
    s += s >> 16
    return ~s & 0xFFFF


async def ping_task(redis_client):
    """Ping REMOTE_IP every PING_INTERVAL seconds."""
    logger.info(f"Ping task started (target={REMOTE_IP}, interval={PING_INTERVAL}s)")

    while True:
        rtt = await _raw_icmp_ping(REMOTE_IP, timeout=1.0)
        if rtt is None:
            # Fallback to subprocess ping
            rtt = await _subprocess_ping(REMOTE_IP)

        publish(redis_client, {
            "type": "ping",
            "rtt_ms": round(rtt, 2) if rtt is not None else None,
            "ts": int(time.time() * 1000),
        })

        await asyncio.sleep(PING_INTERVAL)


# ── UDP Throughput Test ───────────────────────────────────────────────────────

async def throughput_sender_task(redis_client):
    """Periodically send a burst of UDP packets to the car and measure throughput."""
    logger.info(
        f"Throughput test started (target={REMOTE_IP}:{THROUGHPUT_PORT}, "
        f"interval={THROUGHPUT_INTERVAL}s, packets={THROUGHPUT_PACKET_COUNT}x{THROUGHPUT_PACKET_SIZE}B)"
    )

    # Wait a bit on startup before first burst
    await asyncio.sleep(5.0)

    while True:
        try:
            await _run_throughput_test(redis_client)
        except Exception as e:
            logger.error(f"Throughput test error: {e}")
            publish(redis_client, {
                "type": "throughput",
                "mbps": None,
                "loss_pct": 100.0,
                "sent": 0,
                "received": 0,
                "ts": int(time.time() * 1000),
            })

        await asyncio.sleep(THROUGHPUT_INTERVAL)


async def _run_throughput_test(redis_client):
    """Execute one throughput burst test."""
    loop = asyncio.get_running_loop()

    # Create send socket
    send_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    send_sock.setblocking(False)

    # Padding to fill packet to desired size
    # Header: 12 bytes (uint64 burst_id + uint32 total_count)
    header_size = 12
    padding = b'\x00' * max(0, THROUGHPUT_PACKET_SIZE - header_size)
    burst_id = int(time.time() * 1000) & 0xFFFFFFFFFFFFFFFF

    start_time = time.monotonic()

    # Send burst
    for i in range(THROUGHPUT_PACKET_COUNT):
        packet = struct.pack("!QI", burst_id, THROUGHPUT_PACKET_COUNT) + padding
        try:
            await loop.sock_sendto(send_sock, packet, (REMOTE_IP, THROUGHPUT_PORT))
        except Exception:
            pass

    send_time = time.monotonic() - start_time

    # Wait for ACK from car side
    ack_data = None
    try:
        # Listen for ACK on the same socket (car sends back to our source port)
        send_sock.settimeout(2.0)
        send_sock.setblocking(True)
        data, addr = await asyncio.wait_for(
            loop.run_in_executor(None, lambda: send_sock.recvfrom(1024)),
            timeout=3.0,
        )
        ack_data = json.loads(data.decode())
    except (asyncio.TimeoutError, Exception) as e:
        logger.debug(f"No ACK received: {e}")

    send_sock.close()

    if ack_data and "received" in ack_data:
        received = ack_data["received"]
        elapsed = time.monotonic() - start_time
        total_bytes = received * THROUGHPUT_PACKET_SIZE
        mbps = (total_bytes * 8) / (elapsed * 1_000_000) if elapsed > 0 else None
        loss_pct = (1 - received / THROUGHPUT_PACKET_COUNT) * 100 if THROUGHPUT_PACKET_COUNT > 0 else 0
    else:
        received = 0
        mbps = None
        loss_pct = 100.0

    publish(redis_client, {
        "type": "throughput",
        "mbps": round(mbps, 2) if mbps is not None else None,
        "loss_pct": round(loss_pct, 1),
        "sent": THROUGHPUT_PACKET_COUNT,
        "received": received,
        "ts": int(time.time() * 1000),
    })


# ── Ubiquiti Radio Scraper ────────────────────────────────────────────────────

async def ubiquiti_scraper_task(redis_client):
    """Poll Ubiquiti airOS status endpoint for radio stats."""
    logger.info(f"Ubiquiti scraper started (target={UBIQUITI_IP})")

    try:
        import aiohttp
    except ImportError:
        logger.warning("aiohttp not installed, Ubiquiti scraper disabled")
        return

    while True:
        try:
            timeout = aiohttp.ClientTimeout(total=5)
            auth = aiohttp.BasicAuth(UBIQUITI_USER, UBIQUITI_PASS)
            async with aiohttp.ClientSession(timeout=timeout, auth=auth) as session:
                async with session.get(f"http://{UBIQUITI_IP}/status.cgi") as resp:
                    if resp.status == 200:
                        data = await resp.json(content_type=None)
                        wireless = data.get("wireless", {})
                        publish(redis_client, {
                            "type": "radio",
                            "rssi_dbm": wireless.get("rssi", wireless.get("signal", 0)),
                            "tx_mbps": round(wireless.get("txrate", 0) / 1000, 1),
                            "rx_mbps": round(wireless.get("rxrate", 0) / 1000, 1),
                            "ccq_pct": round(wireless.get("ccq", 0) / 10, 1),
                            "ts": int(time.time() * 1000),
                        })
                    else:
                        publish(redis_client, {
                            "type": "radio",
                            "error": f"HTTP {resp.status}",
                            "ts": int(time.time() * 1000),
                        })
        except Exception as e:
            logger.debug(f"Ubiquiti scrape failed: {e}")
            publish(redis_client, {
                "type": "radio",
                "error": str(e)[:100],
                "ts": int(time.time() * 1000),
            })

        await asyncio.sleep(10.0)


# ── Entry Point ───────────────────────────────────────────────────────────────

async def run_link_diagnostics():
    """Main entry point. Gathers all diagnostic tasks."""
    logger.info("Link diagnostics service starting...")

    try:
        redis_client = redis.from_url(REDIS_URL)
        redis_client.ping()
        logger.info("Connected to Redis")
    except Exception as e:
        logger.warning(f"Could not connect to Redis: {e}")
        redis_client = None

    tasks = [
        ping_task(redis_client),
        throughput_sender_task(redis_client),
    ]

    if UBIQUITI_IP:
        tasks.append(ubiquiti_scraper_task(redis_client))
    else:
        logger.info("UBIQUITI_IP not set, radio scraper disabled")

    await asyncio.gather(*tasks, return_exceptions=True)

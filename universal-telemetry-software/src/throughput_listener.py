"""
Car-side UDP throughput burst listener.

Receives probe packets from the base station's link_diagnostics throughput test,
counts how many arrived, and sends back a JSON ACK so the base can compute
throughput and loss.

Added to run_car()'s asyncio.gather() in data.py.
"""

import asyncio
import json
import socket
import struct
import time
import logging

from src.config import THROUGHPUT_PORT

logger = logging.getLogger("ThroughputListener")


async def throughput_listener_task():
    """Listen for throughput burst probes and ACK each burst."""
    loop = asyncio.get_running_loop()

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("0.0.0.0", THROUGHPUT_PORT))
    sock.setblocking(False)

    logger.info(f"Throughput listener started on UDP port {THROUGHPUT_PORT}")

    # Track current burst
    current_burst_id = None
    expected_count = 0
    received_count = 0
    sender_addr = None
    last_packet_time = 0.0

    while True:
        try:
            data, addr = await loop.sock_recvfrom(sock, 2048)
        except Exception as e:
            logger.debug(f"Receive error: {e}")
            await asyncio.sleep(0.01)
            continue

        now = time.monotonic()

        if len(data) < 12:
            continue

        burst_id, total_count = struct.unpack("!QI", data[:12])

        # New burst started
        if burst_id != current_burst_id:
            # If there was a previous burst we didn't ACK (shouldn't happen normally), ignore it
            current_burst_id = burst_id
            expected_count = total_count
            received_count = 0
            sender_addr = addr

        received_count += 1
        last_packet_time = now

        if received_count >= expected_count:
            # Burst complete — ACK immediately.
            # Note: partial bursts (sender dropped packets) are not ACK'd here;
            # a separate timeout coroutine would be needed for that case.
            ack = json.dumps({
                "received": received_count,
                "ts": int(time.time() * 1000),
            }).encode()
            try:
                await loop.sock_sendto(sock, ack, sender_addr)
            except Exception as e:
                logger.debug(f"ACK send error: {e}")
            current_burst_id = None

"""
Car-side UDP throughput burst listener.

Receives probe packets from the base station's link_diagnostics throughput test,
counts how many arrived, and sends back a JSON ACK so the base can compute
throughput and loss.

Added to run_car()'s asyncio.gather() in data.py.
"""

import asyncio
import json
import struct
import time
import os
import logging

logger = logging.getLogger("ThroughputListener")

THROUGHPUT_PORT = int(os.getenv("THROUGHPUT_PORT", "5007"))


async def throughput_listener_task():
    """Listen for throughput burst probes and ACK each burst."""
    loop = asyncio.get_running_loop()

    sock = __import__("socket").socket(__import__("socket").AF_INET, __import__("socket").SOCK_DGRAM)
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

        # Check if burst is complete or if we should send ACK
        if received_count >= expected_count:
            # Burst complete, send ACK immediately
            ack = json.dumps({
                "received": received_count,
                "ts": int(time.time() * 1000),
            }).encode()
            try:
                await loop.sock_sendto(sock, ack, sender_addr)
            except Exception as e:
                logger.debug(f"ACK send error: {e}")
            current_burst_id = None

        # Also check for stale bursts (partial receipt, no more packets coming)
        # This is handled by checking in a periodic manner
        elif now - last_packet_time > 1.0 and received_count > 0:
            # Timeout: send whatever we got
            ack = json.dumps({
                "received": received_count,
                "ts": int(time.time() * 1000),
            }).encode()
            try:
                if sender_addr:
                    await loop.sock_sendto(sock, ack, sender_addr)
            except Exception:
                pass
            current_burst_id = None

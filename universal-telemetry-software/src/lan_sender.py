#!/usr/bin/env python3
"""
lan_sender.py — Fake car on the LAN for stack testing.

Sends UDP packets to the base station that look exactly like real car CAN
batches, so the full pipeline (UDP recv → Redis → WebSocket bridge → clients)
lights up without a car present.

Usage:
    python lan_sender.py                    # defaults: 127.0.0.1:5005
    python lan_sender.py 10.71.1.10 5005   # explicit host/port

Packets are crafted to match the format data.py expects:
    [0:10]  seq (uint64 big-endian) + count (uint16 big-endian)
    [10:..] CAN frames, each 20 bytes:
                [0:8]   timestamp (double big-endian, epoch seconds)
                [8:12]  can_id (uint32 big-endian)
                [12:20] data (8 bytes)

Includes the real VCU_Timestamp CAN ID (1999) with epoch-ms payload so the
base station clock-sync logic activates normally.
"""

import socket
import struct
import time
import random
import argparse

# CAN IDs matching the real car DBC (pecan/src/assets/local.dbc)
CAN_IDS = {
    1999: "VCU_Timestamp",       # 1 Hz — epoch_ms (int64 little-endian in data)
    192:  "VCU_Status",
    193:  "Pedal_Sensors",
    194:  "Steering_Wheel",
    512:  "BMS_Status",
    513:  "BMS_Cell_Stats",
    256:  "MC_Command",
    257:  "MC_Feedback",
    768:  "Wheel_Speeds",
    1024: "IMU_Data",
    1280: "Cooling_Status",
}

ECU_TIMESTAMP_ID = 1999
PACKET_RATE_HZ = 20          # packets per second (matches real car)
INTER_MSG_DELAY = 1.0 / PACKET_RATE_HZ


def build_timestamp_frame() -> bytes:
    """VCU_Timestamp frame — epoch_ms as int64 little-endian (matches data.py)."""
    epoch_ms = int(time.time() * 1000)
    data = struct.pack("<q", epoch_ms)   # little-endian int64
    return struct.pack("!dI8s", time.time(), ECU_TIMESTAMP_ID, data)


def build_frame(can_id: int, data: bytes) -> bytes:
    """Pack one CAN frame: timestamp (double BE) + can_id (uint32 BE) + data (8 bytes)."""
    if len(data) < 8:
        data = data.ljust(8, b'\x00')
    elif len(data) > 8:
        data = data[:8]
    return struct.pack("!dI8s", time.time(), can_id, data)


def build_packet(seq: int, frames: list[bytes]) -> bytes:
    """Build a UDP packet: seq (uint64) + count (uint16) + N×20-byte frames."""
    count = len(frames)
    header = struct.pack("!QH", seq, count)
    return header + b''.join(frames)


def make_fake_values() -> dict[int, bytes]:
    """Generate realistic-looking CAN data for all IDs."""
    return {
        192:  struct.pack("<I", 0b00001),                    # VCU_State=1, Safety_Loop=0, Inverter=0
        193:  struct.pack("<HH", 500, 500) +                # APPS1=50%, APPS2=50%
               struct.pack("<HH", 0, 0),                     # brake=0
        194:  struct.pack("<hH", 0, 0),                     # steering=0, buttons=0
        512:  struct.pack("<HhBB", 5400, 0, 80, 0),         # PackVoltage=540V, current=0, SOC=80%
        513:  struct.pack("<HHhB", 3700, 3700, 3700, 25),   # cell voltages + maxTemp=25°C
        256:  struct.pack("<hH", 0, 0),                     # TorqueRequest=0, SpeedLimit=0
        257:  struct.pack("<HhB", 0, 0, 35),                # MotorSpeed=0, Torque=0, IGBT=35°C
        768:  struct.pack("<HHHH", 0, 0, 0, 0),             # all wheel speeds = 0
        1024: struct.pack("<hhhh", 0, 0, int(0.981 * 1000), 0),  # AccelX=0, AccelY=0, AccelZ=0.981g, YawRate=0
        1280: struct.pack("<BBBB", 30, 30, 50, 50),         # coolant temps + pump/fan speeds
    }


def main():
    parser = argparse.ArgumentParser(description="Fake car — send CAN-like UDP packets to base station")
    parser.add_argument("host", nargs="?", default="127.0.0.1", help="Base station IP (default: 127.0.0.1)")
    parser.add_argument("port", nargs="?", type=int, default=5005, help="UDP port (default: 5005)")
    args = parser.parse_args()

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.IPPROTO_IP, socket.IP_TOS, 0x10)

    seq = 0
    print(f"[lan_sender] Sending to {args.host}:{args.port} at {PACKET_RATE_HZ} Hz")
    print(f"[lan_sender] CAN IDs: {', '.join(f'{k} ({v})' for k, v in CAN_IDS.items())}")

    try:
        while True:
            t_start = time.monotonic()

            # Build one packet with all CAN frames
            frames = [build_timestamp_frame()]  # VCU_Timestamp (1 Hz embedded in packet)
            fake = make_fake_values()

            # Alternate some IDs each packet to simulate changing data
            for can_id, data in fake.items():
                if random.random() > 0.3:   # 70 % chance each ID appears per packet
                    frames.append(build_frame(can_id, data))

            packet = build_packet(seq, frames)
            sock.sendto(packet, (args.host, args.port))

            seq += 1
            if seq % 100 == 0:
                print(f"[lan_sender] sent {seq} packets")

            elapsed = time.monotonic() - t_start
            sleep_time = INTER_MSG_DELAY - elapsed
            if sleep_time > 0:
                time.sleep(sleep_time)

    except KeyboardInterrupt:
        print(f"\n[lan_sender] Stopped after {seq} packets sent.")
    finally:
        sock.close()


if __name__ == "__main__":
    main()

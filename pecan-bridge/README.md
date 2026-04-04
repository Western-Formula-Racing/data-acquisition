# Pecan Bridge (v2 -> Kvaser)

One-way bridge that consumes live Pecan/UTS WebSocket protocol v2 CAN telemetry and transmits frames on a physically attached Kvaser interface so TSMaster and other CAN tools can observe traffic live.

## Scope (v1)

- Input: WebSocket protocol v2 `can_data` envelope only.
- Output: Real CAN TX on Kvaser hardware (Windows).
- Direction: One-way (Pecan stream -> Kvaser CAN).
- Legacy payloads without `type` are rejected.

## Requirements

- Windows machine with Kvaser CANlib drivers installed.
- Kvaser interface physically connected.
- Python 3.10+.

## Install

```bash
cd pecan-bridge
pip install -r requirements.txt
```

## Run

```bash
python -m src.main \
  --ws-url ws://<uts-host>:9080 \
  --channel 0 \
  --bitrate 500000
```

Dry-run without CAN hardware:

```bash
python -m src.main --ws-url ws://<uts-host>:9080 --dry-run --log-level DEBUG
```

## Behavior notes

- Exponential reconnect when WebSocket drops.
- Bounded queue protects memory.
- Invalid v2 payloads are dropped with counters.
- Non-`can_data` v2 messages are ignored.

## TSMaster verification

1. Start this bridge on Windows with Kvaser connected.
2. Open TSMaster and select the same Kvaser channel.
3. Start capture/monitor.
4. Confirm IDs and byte payloads appear in real time.

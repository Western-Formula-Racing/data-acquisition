# Kvaser Bridge

A GUI app that bridges a Kvaser CAN adapter to the DAQ Radio dashboard via WebSocket.

```
Kvaser hardware
    |  (python-can / Kvaser CANlib)
    v
kvaser-bridge (this app)
    |  JSON over WebSocket
    v
DAQ Radio pecan dashboard
```

## Prerequisites

- Python 3.10+
- [Kvaser CANlib SDK](https://kvaser.com/download/)
- tkinter (included with most Python installations)

## Install

```bash
pip install -r requirements.txt
```

## Run

```bash
python src/main.py
```

A small window appears with:
- **Channel** - select which Kvaser CAN channel to use
- **Bitrate** - CAN bus bitrate (default 500k)
- **WS URL** - WebSocket URL of the dashboard (default `ws://localhost:9080`)
- **Start/Stop Bridge** - toggle the connection

Click **Start Bridge** to begin streaming CAN frames to the dashboard.

## Build (standalone binary)

```bash
# Linux
pyinstaller build.spec

# Windows
pyinstaller build.spec
```

Output binary is in `dist/kvaser-bridge` (or `dist/kvaser-bridge.exe`).

## Architecture

| File | Purpose |
|------|---------|
| `src/main.py` | Entry point; starts asyncio loop + tkinter GUI |
| `src/bridge.py` | Core Kvaser CAN -> WebSocket bridge (asyncio) |
| `src/tray.py` | tkinter GUI window |
| `src/config.py` | Bitrate options, defaults, config persistence |

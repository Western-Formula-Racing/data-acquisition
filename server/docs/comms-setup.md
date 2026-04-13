# Comms Setup Guide

Voice communication system for Western Formula Racing using Jitsi Meet.

## Architecture

```
Base Station RPI                    Car RPI
┌────────────────────┐              ┌──────────────────┐
│  Jitsi Meet Server │◄─Ubiquiti───►│  Headless Client │
│  (Web/XMPP/JVB)    │   Radio      │  (auto-rejoin)   │
│  WiFi Hotspot      │              │  Driver audio    │
└────────────────────┘              └──────────────────┘
        ▲
        │ WiFi
┌───────┴────────┐
│  Pit Crew      │
│  (PECAN Comms) │
└────────────────┘
```

## Quick Start

### Base Station

```bash
cd universal-telemetry-software
docker compose -f docker-compose.jitsi.yml up -d
```

Access: `http://<base-ip>:8000`

### Car RPI

```bash
# Set base station IP first
export JITSI_URL=http://192.168.1.1:8000

cd universal-telemetry-software
docker compose -f docker-compose.jitsi.yml --profile car up -d car-jitsi-client
```

The client will:
- Auto-join the `wfr-comms` room
- Retry every 5 seconds if base station unavailable
- Reconnect if disconnected

### Pit Crew (Browser)

1. Connect to base station WiFi
2. Open `http://<base-ip>:3000/comms`
3. Enter name, join room

## Rooms

| Room | Purpose |
|------|---------|
| `wfr-comms` | All team |
| `wfr-driver` | Driver only |
| `wfr-pit` | Pit crew |

## Configuration

### Car Client Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `JITSI_URL` | `http://192.168.1.1:8000` | Base station Jitsi URL |
| `ROOM_NAME` | `wfr-comms` | Room to join |
| `DISPLAY_NAME` | `Driver` | Name shown in meeting |
| `RETRY_INTERVAL_MS` | `5000` | Retry delay (ms) |
| `MAX_RETRIES` | `-1` | Infinite retries |

## Troubleshooting

**Car can't connect?**
- Check Ubiquiti link status
- Verify base station IP in `JITSI_URL`
- Check `docker logs daq-car-jitsi`

**No audio on car?**
- Verify PulseAudio: `pactl info`
- Check audio device: `aplay -l`

# Car RPi Deployment

The car runs the telemetry stack **natively via systemd** — no Docker, no Redis required.

Minimal footprint: reads `can0`, batches UDP to the base station, serves a TCP resend buffer,
and runs a local WebSocket bridge on port 9080 for direct PECAN connections when hotspotted.

---

## First-time install

```bash
# 1. Clone the repo
git clone https://github.com/western-formula-racing/daq-radio.git /home/pi/daq-radio
cd /home/pi/daq-radio/universal-telemetry-software

# 2. Install uv (if not already installed)
curl -LsSf https://astral.sh/uv/install.sh | sh

# 3. Sync Python dependencies (needs internet; only once per code change)
uv sync

# 4. Stamp the current git hash into the service file
sed -i "s/GIT_HASH=unknown/GIT_HASH=$(git rev-parse --short HEAD)/" deploy/car-telemetry.service

# 5. Install and enable the systemd service
sudo cp deploy/car-telemetry.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable car-telemetry
sudo systemctl start car-telemetry
```

---

## Day-to-day commands

```bash
# Start / stop / restart
sudo systemctl start car-telemetry
sudo systemctl stop car-telemetry
sudo systemctl restart car-telemetry

# Live logs
journalctl -u car-telemetry -f

# Check status
systemctl status car-telemetry
```

---

## After a code update

```bash
cd /home/pi/daq-radio
git pull
cd universal-telemetry-software
uv sync

# Re-stamp the git hash so the version checker on the base shows the right value
sudo sed -i "s/GIT_HASH=.*/GIT_HASH=$(git rev-parse --short HEAD)/" /etc/systemd/system/car-telemetry.service
sudo systemctl daemon-reload
sudo systemctl restart car-telemetry
```

---

## Network

| Role | IP | Set on |
|------|----|--------|
| Car RPi | `10.71.1.10` | RPi static LAN config |
| Base station | `10.71.1.20` | Laptop static LAN config |

The car sends UDP to `REMOTE_IP=10.71.1.20` (hardcoded in `car-telemetry.service`).

---

## Ports

| Port | Protocol | Purpose |
|------|----------|---------|
| 5005 | UDP | CAN data stream → base |
| 5006 | TCP | Packet resend server (base pulls missing batches) |
| 8080 | HTTP | Status page (`/`, `/version`, `/set-time`) |
| 9080 | WS | PECAN WebSocket (direct connection when hotspotted) |

---

## Hotspot / direct PECAN connection

When the car Pi is hotspotted and a laptop connects directly to it, PECAN can connect to
`ws://<car-ip>:9080` to receive live data without the base station. The WS bridge uses an
in-process queue — no Redis needed.

---

## Base station

The base station runs via Docker. Use `docker-compose.macbook-base.yml` on a MacBook
(full stack with TimescaleDB) or `docker-compose.rpi-base.yml` on a Pi (ephemeral, no DB):

```bash
cd universal-telemetry-software

# MacBook — full stack
docker compose -f deploy/docker-compose.macbook-base.yml up -d

# Pi — lightweight
docker compose -f deploy/docker-compose.rpi-base.yml up -d
```

---

## Troubleshooting

**Service fails to start:** Check `journalctl -u car-telemetry -e`. Common causes:
- `can0` not up — run `sudo ip link set can0 up type can bitrate 1000000` or check CAN hat wiring
- `uv sync` not run after a code update — Python deps missing

**Base shows version mismatch banner:** Git hash on car doesn't match base. Re-stamp and restart:
```bash
sudo sed -i "s/GIT_HASH=.*/GIT_HASH=$(git rev-parse --short HEAD)/" /etc/systemd/system/car-telemetry.service
sudo systemctl daemon-reload && sudo systemctl restart car-telemetry
```

**Status page shows car not connected:** Base isn't receiving UDP from `10.71.1.10:5005`.
Verify both ends have the right static IPs and that `REMOTE_IP` in `car-telemetry.service` matches the base.

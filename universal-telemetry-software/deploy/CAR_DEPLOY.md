# Car RPi Deployment

The car runs the telemetry stack **natively via systemd** — no Docker, no Redis required.

Minimal footprint: reads `can0`, batches UDP to the base station, serves a TCP resend buffer,
runs a local WebSocket bridge on port 9080, and relays that stream on loopback port 9089
for Cloudflared/LTE `wss://` access.

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

# 6. Optional LTE/WSS relay through Cloudflare Tunnel
cloudflared tunnel login
cloudflared tunnel create daq-car-lte
sudo cloudflared service install
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
| 8081 | HTTP | Video quality control — `POST /video/quality` (when `ENABLE_VIDEO=true`) |
| 9080 | WS | PECAN WebSocket (direct connection when hotspotted) |
| 9089 | WS | Loopback LTE relay target for Cloudflared |

## Video

When `ENABLE_VIDEO=true`, the car runs ffmpeg to push H.264 to MediaMTX on the base station via RTSP. A lightweight HTTP control server on port 8081 lets Pecan change quality presets at runtime without restarting the service.

**Quality presets** (POST to `http://10.71.1.10:8081/video/quality`):
```json
{"quality": "low"}    // 640x360 @ 500kbps
{"quality": "medium"} // 848x480 @ 800kbps  (default)
{"quality": "high"}   // 1280x720 @ 2000kbps
```

**Camera focus** (USB cameras with autofocus):
```bash
v4l2-ctl --device /dev/video0 --set-ctrl focus_automatic_continuous=0
v4l2-ctl --device /dev/video0 --set-ctrl focus_absolute=40
```

---

## Hotspot / direct PECAN connection

When the car Pi is hotspotted and a laptop connects directly to it, PECAN can connect to
`ws://<car-ip>:9080` to receive live data without the base station. The WS bridge uses an
in-process queue — no Redis needed.

---

## LTE relay through Cloudflared

The car service also starts a downlink-only relay on `ws://127.0.0.1:9089`. Cloudflared
runs separately as a systemd service, connects outbound through the phone hotspot/LTE link,
and publishes that local relay as a public `wss://` URL.

Example config at `/etc/cloudflared/config.yml`:

```yaml
tunnel: daq-car-lte
credentials-file: /home/car/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: daq-car-lte.example.com
    service: http://127.0.0.1:9089
  - service: http_status:404
```

Initial setup is interactive:

```bash
sudo deploy/setup-car-lte-cloudflare.sh daq-car-lte.example.com
```

The script prints the final `wss://` URL and saves it to `~/Desktop/daq-car-lte-wss-url.txt` for copy/paste.

PECAN can then use `wss://daq-car-lte.example.com` as its WebSocket URL. The car does not
choose WiFi vs LAN in code; Linux routes `10.71.1.0/24` over eth0/radio and Cloudflared's
internet connection over the phone hotspot default route.

---

## Base station

The base station runs via Docker. Use `docker-compose.macbook-base.yml` on a MacBook
(full stack with TimescaleDB):

```bash
cd universal-telemetry-software
docker compose -f deploy/docker-compose.macbook-base.yml up -d
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

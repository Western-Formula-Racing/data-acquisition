# Base Station Setup (macOS / Linux)

Local telemetry stack for a MacBook or Linux base station (including Raspberry Pi 4B). The default startup is minimal:
telemetry receiver, Redis, and the Pecan dashboard.

TimescaleDB writes, local media services, and the Cloudflare tunnel are opt-in
Docker Compose profiles.

## Prerequisites

**macOS:** [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running.

**Linux / Raspberry Pi 4B:** Nothing pre-installed — the installer bootstraps git and Docker Engine automatically. Requires Debian/Ubuntu or Raspberry Pi OS (apt-get).

Car RPi on the same network, or use simulation mode.

---

## One-Command Install (Recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/Western-Formula-Racing/data-acquisition/main/universal-telemetry-software/deploy/install.sh | bash
```

**Linux with Wi-Fi hotspot for pit devices** (RPi 4B at track — ethernet to car radio, Wi-Fi AP for laptops/tablets):

```bash
curl -fsSL https://raw.githubusercontent.com/Western-Formula-Racing/data-acquisition/main/universal-telemetry-software/deploy/install.sh | bash -s -- --hotspot
```

That's it. The script:
1. **macOS:** Verifies Docker Desktop is running
2. **Linux:** Installs git and Docker Engine if missing, enables Docker on boot
3. Clones the repo to `~/wfr-base-station/` (or updates if already present)
4. Pulls the latest images
5. Starts the stack (auto-restarts on reboot via `restart: unless-stopped`)
6. **`--hotspot` (Linux):** Prompts before enabling — switches `wlan0` to AP mode (`WFR-Base`); pit crew opens Pecan at `http://10.42.0.1:3000`. **Warning:** disconnects Wi-Fi SSH/internet if no other adapter is present.

Subsequent updates: run the same command again.

**Pecan runs in the browser on pit devices** — the base station only serves static files and forwards telemetry. Open Pecan from a laptop or tablet on the LAN, not in Chromium on the Pi itself.

---

## Manual Setup

Open:

| Service | URL |
|---------|-----|
| Pecan dashboard | http://localhost:3000 |
| Status page | http://localhost:8080 |
| Health endpoint | http://localhost:8080/health |

Optional profiles:

| Command | Starts |
|---------|--------|
| `--profile timescale` | Local TimescaleDB and telemetry writes |
| `--profile media` | MediaMTX and stream overlay |
| `--profile tunnel` | cloudflared relay |

Examples:

```bash
# Minimal LAN stack
docker compose -f deploy/docker-compose.macbook-base.yml --env-file deploy/.env.macbook up -d

# Add local TimescaleDB writes
docker compose --profile timescale -f deploy/docker-compose.macbook-base.yml --env-file deploy/.env.macbook up -d

# Add TimescaleDB and local media helpers
docker compose --profile timescale --profile media -f deploy/docker-compose.macbook-base.yml --env-file deploy/.env.macbook up -d
```

## Configuration

All configuration is done through `deploy/.env.macbook`. Key variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `REMOTE_IP` | `10.71.1.10` | Car RPi IP address |
| `ENABLE_TIMESCALE_LOGGING` | `auto` | Auto-start writer when the TimescaleDB profile is running |
| `TIMESCALE_TABLE` | `WFR26test` | Season table name (no `_base` suffix — added automatically) |
| `DBC_HOST_PATH` | `./universal-telemetry-software/deploy/example.dbc` | Path to DBC file (relative to repo root) |
| `RELAY_TOKEN` | blank | Optional relay token |
| `CLOUDFLARED_CONFIG` | `./cloudflared/config.yml` | Private tunnel config path for `--profile tunnel` |
| `CLOUDFLARED_CREDENTIALS` | `./cloudflared/credentials.json` | Private tunnel credentials path for `--profile tunnel` |

## Services

| Service | Description |
|---------|-------------|
| telemetry | Base station receiver — UDP/TCP from car, WebSocket to Pecan |
| redis | Message broker for CAN frames |
| pecan | Live telemetry dashboard |
| timescaledb | Optional local TimescaleDB — writes `WFR26test_base` table with `--profile timescale` |
| mediamtx | Optional local video transport with `--profile media` |
| stream-overlay | Optional local stream overlay with `--profile media` |
| cloudflared | Optional tunnel relay with `--profile tunnel` |

## Common Tasks

**Restart the stack:**
```bash
docker compose -f deploy/docker-compose.macbook-base.yml --env-file deploy/.env.macbook  restart
```

**View logs:**
```bash
docker compose -f deploy/docker-compose.macbook-base.yml logs -f
```

**Wipe all data and start fresh:**
```bash
docker compose -f deploy/docker-compose.macbook-base.yml --env-file deploy/.env.macbook  down -v
docker compose -f deploy/docker-compose.macbook-base.yml --env-file deploy/.env.macbook  up -d
```

**Update to the latest pre-built images:**
```bash
docker compose -f deploy/docker-compose.macbook-base.yml --env-file deploy/.env.macbook  pull
docker compose -f deploy/docker-compose.macbook-base.yml --env-file deploy/.env.macbook  up -d
```

**Rebuild from source (for development):**
Set `build: ..` back in `docker-compose.macbook-base.yml` for telemetry and run:
```bash
docker compose -f deploy/docker-compose.macbook-base.yml --env-file deploy/.env.macbook up -d --build
```

## Troubleshooting

**Can't connect to car RPi:** Verify `REMOTE_IP` in `.env.macbook` is correct and the car RPi is reachable.

**No data flow:** Check `http://localhost:8080/health` first. The `udp_listener` component should be OK, and the car section should show recent data after the car starts sending. `docker logs daq-telemetry` should also show `Initial sequence` after the first UDP packet arrives.

**Port conflicts:** If ports 3000, 8080, 5005, or 5006 are in use, edit the port mappings in `docker-compose.macbook-base.yml`. Optional profiles also use 5432 for TimescaleDB, 8554/8889/8189/9997 for media, and 8085 for the stream overlay.

**TimescaleDB not writing:** Start with `docker compose --profile timescale ... up -d`. In `auto` mode, telemetry probes the configured database at boot and starts the writer only when it is reachable. Verify the `WFR26test_base` table exists: `psql postgresql://wfr:wfr_password@localhost:5432/wfr -c "\dt"`

## Network setup

### macOS

Set IP `10.71.1.20` on the USB-C ethernet adapter connected to the car radio base.

Via GUI: System Settings → Network → USB-C Ethernet → Configure IPv4 → Manually → IP: 10.71.1.20 / Subnet: 255.255.255.0

Via CLI:
```bash
networksetup -listallhardwareports
sudo networksetup -setmanual '<interface>' 10.71.1.20 255.255.255.0
ping -c 3 10.71.1.10
```

### Linux / Raspberry Pi

Set IP `10.71.1.20` on the ethernet interface connected to the car radio (USB-ethernet or onboard).

```bash
ip -br link   # find interface name

# NetworkManager (RPi OS / Ubuntu)
sudo nmcli con mod '<connection-name>' ipv4.method manual \
  ipv4.addresses 10.71.1.20/24 ipv4.gateway ''
sudo nmcli con up '<connection-name>'

# Or temporary (resets on reboot)
sudo ip addr add 10.71.1.20/24 dev eth0

ping -c 3 10.71.1.10
```

With `--hotspot`, the installer **asks for confirmation** before switching `wlan0` to AP mode (`WFR-Base` / `wfr-racing`). This disconnects any Wi-Fi client connection (including SSH over Wi-Fi) and removes internet on Wi-Fi unless another adapter (e.g. ethernet) is connected. Pit devices connect and open `http://10.42.0.1:3000`. The ethernet car link at `10.71.1.20` is independent.

---

## Windows / WSL2 — Limited Support

The base station stack is designed for macOS and native Linux. Windows support is limited:

- **UDP telemetry (port 5005)** does not work reliably on Windows/WSL2 Docker. The car sends UDP directly to the base station IP, and WSL2 does not automatically forward LAN UDP packets into containers. This is the critical path.
- **WSL2 Ubuntu inside Windows** — If you must use Windows, run the entire stack inside a WSL2 Ubuntu Linux environment. Networking then behaves like native Linux.

**Recommended for Windows teammates:** Use a MacBook or Linux machine as the base station. Others connect to the Pecan dashboard at `http://<base-station-ip>:3000`.

For Windows WSL2 setup (if needed), see the [AGENTS.md](../AGENTS.md) Windows notes.

## Teardown

```bash
docker compose -f deploy/docker-compose.macbook-base.yml --env-file deploy/.env.macbook  down -v
```

Adds `-v` to wipe TimescaleDB and Redis data volumes. Omit `-v` to preserve data between runs.

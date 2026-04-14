# MacBook Base Station Setup

Run a lightweight telemetry stack (Redis, Pecan dashboard) on your MacBook. The base station writes CAN data directly to the server stack's TimescaleDB over the network.

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running
- Repo cloned somewhere with the standard directory structure intact
- Base station LAN is plugged into your MacBook, with LAN IP set to manual and 10.71.1.20

## Quick Start

```bash
cd universal-telemetry-software/
cp deploy/.env.macbook deploy/.env
```

Edit `deploy/.env` and set:
- `REMOTE_IP` — car RPi IP address (per team convention: `10.71.1.10`)
- `TIMESCALE_DSN` — server TimescaleDB connection string (e.g. `postgresql://wfr:<password>@data.westernformularacing.org:5432/wfr`)

```bash
docker compose -f docker-compose.macbook.yml --profile base up -d
```

Open:

| Service | URL |
|---------|-----|
| Pecan dashboard | http://localhost:3000 |
| Status page | http://localhost:8080 |


## Configuration

All configuration is done through `deploy/.env`. Key variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `REMOTE_IP` | `10.71.1.10` | Car RPi IP address |
| `INFLUX_SEASON` | `WFR26` | Season name (used for TIMESCALE_TABLE suffix) |
| `TIMESCALE_DSN` | (required) | Server TimescaleDB connection string |
| `GRAFANA_ADMIN_PASSWORD` | `admin` | Grafana admin password |

## Profiles

| Profile | Services Started |
|---------|-----------------|
| `base` | telemetry + redis + pecan |
| (none) | telemetry + redis only |

You'll almost always want `--profile base`.

## Common Tasks

**Restart the stack:**
```bash
docker compose -f deploy/docker-compose.macbook.yml --profile base restart
```

**View logs:**
```bash
docker compose -f deploy/docker-compose.macbook.yml logs -f
```

**Wipe all data and start fresh:**
```bash
docker compose -f deploy/docker-compose.macbook.yml --profile base down -v
docker compose -f deploy/docker-compose.macbook.yml --profile base up -d
```

**Update to the latest pre-built images:**
```bash
docker compose -f deploy/docker-compose.macbook.yml --profile base pull
docker compose -f deploy/docker-compose.macbook.yml --profile base up -d
```

**Rebuild from source instead of using pre-built images:**
Edit `docker-compose.macbook.yml` and change:
```yaml
# comment out this line:
# image: ghcr.io/western-formula-racing/daq-radio/universal-telemetry:latest
# uncomment this line:
build: ..
```
Then:
```bash
docker compose -f deploy/docker-compose.macbook.yml --profile base up -d --build
```

## Troubleshooting

**Can't connect to car RPi:** Verify `REMOTE_IP` in `.env` is correct and the car RPi is reachable from your MacBook's network.

**Port conflicts:** If ports 3000, 8080, 5005, or 5006 are in use on your MacBook, edit the port mappings in `docker-compose.macbook.yml`.

## Windows / WSL2

If you're on Windows with WSL2 (recommended), everything works the same — just run the commands from within your WSL2 Linux shell.

For native Windows Docker Desktop (non-WSL2), the Unix-style volume paths won't work — you'd need to convert them to Windows paths or use WSL2.

## Teardown

```bash
docker compose -f deploy/docker-compose.macbook.yml --profile base down -v
```

Adds `-v` to wipe data volumes. Omit `-v` to preserve data between runs.

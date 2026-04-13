# Local Stack — Offline Testing Guide

Minimal stack for testing without internet: InfluxDB3, Grafana, and file-uploader only.

## First-time setup (requires internet)

### 1. Pull pre-built images

```bash
cd installer
docker compose -f docker-compose.local.yml pull
```

This fetches `influxdb:3-core` and `grafana/grafana:latest` from Docker Hub.
Only needs to be done once, or when you want to update to newer images.

### 2. Build the file-uploader image

```bash
docker compose -f docker-compose.local.yml build file-uploader
```

This compiles the local `file-uploader/` source into an image.
Re-run this if you change code in `file-uploader/`.

### 3. Prepare required files

Make sure these exist in `installer/`:

- `influxdb3-admin-token.json` — InfluxDB admin token file
- A `.dbc` file (default: `example.dbc`, or set `DBC_FILE_PATH` in `.env`)

The DBC file is the fallback used when no custom DBC is uploaded via the UI.

---

## Syncing dashboards from production (optional)

User-built dashboards live in Grafana's internal database, not in this repo. Use `backup-dashboards.py` to export them before going offline.

```bash
# Save to a local directory (e.g. a private repo)
python installer/backup-dashboards.py \
    --output ~/daq-internal/grafana-dashboards \
    --git-push
```

Then point the local stack at that directory:

```bash
export GRAFANA_DASHBOARDS_PATH=~/daq-internal/grafana-dashboards
docker compose -f docker-compose.local.yml up
```

If `GRAFANA_DASHBOARDS_PATH` is not set, the stack falls back to `./grafana/dashboards` (the provisioned dashboards checked into this repo).

**Authentication** — the script reads from `.env` automatically:
- `GRAFANA_API_TOKEN` (preferred — service account token)
- `GRAFANA_ADMIN_PASSWORD` (fallback — basic auth as `admin`)

**Server cron** — to automatically back up and push daily at 2am:
```bash
crontab -e
# Add:
0 2 * * * cd /home/ubuntu/projects/daq-internal && python /home/ubuntu/projects/daq-server-components/installer/backup-dashboards.py --output ./grafana-dashboards --git-push >> /var/log/grafana-backup.log 2>&1
```

---

## Starting the stack (offline)

```bash
cd installer
docker compose -f docker-compose.local.yml up
```

| Service       | URL                        |
|---------------|----------------------------|
| Grafana       | http://localhost:8087       |
| File Uploader | http://localhost:8084       |
| InfluxDB      | http://localhost:9000       |

Grafana credentials: `admin` / `password` (or `GRAFANA_ADMIN_PASSWORD` from `.env`)

---

## Uploading data

1. Open http://localhost:8084
2. Select a bucket from the dropdown (buckets are auto-listed from InfluxDB)
3. Optionally select a custom `.dbc` file — if omitted, the server-side DBC is used
4. Drop or click to upload one or more `.csv` files
5. Watch the progress bar — data appears in Grafana as rows are written

---

## No internet checklist

Before going offline, verify:

- [ ] `docker images | grep influxdb` shows `influxdb:3-core`
- [ ] `docker images | grep grafana` shows `grafana/grafana`
- [ ] `docker images | grep file-uploader` shows the local build
- [ ] `influxdb3-admin-token.json` exists
- [ ] A `.dbc` file is present (or you plan to upload one per-session via the UI)

---

## Grafana has no plugins offline

The main `docker-compose.yml` installs `grafana-clock-panel` and `grafana-simple-json-datasource`
at container startup — this requires internet. The local compose omits `GF_INSTALL_PLUGINS`
so Grafana starts cleanly offline with only its built-in panels.

Dashboards that use those plugins will show "panel plugin not found" errors.
Use built-in panel types (Time series, Stat, Table, etc.) for offline-compatible dashboards.

---

## Updating images (back online)

To pull the latest versions:

```bash
docker compose -f docker-compose.local.yml pull
docker compose -f docker-compose.local.yml build file-uploader
```

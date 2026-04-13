# VPS Recovery Guide — OVH vps-1969c8c2

## What happened

The server ran out of memory (OOM). The Linux kernel started killing processes to survive, including:
- `containerd` (Docker runtime) — taking down all containers
- `cloudflared` binary — deleted from disk
- `tailscaled` binary — deleted from disk
- `containerd-shim-runc-v2` binary — deleted from disk

OVH detected the unresponsive server and rebooted it into **rescue mode**.

---

## Step 1 — Exit rescue mode

OVH boots into rescue mode automatically when the server crashes hard. You need to manually switch it back.

1. Go to [OVH control panel](https://www.ovh.com/manager/) → Bare Metal Cloud → VPS → `vps-1969c8c2.vps.ovh.ca`
2. Find the **Boot** field (shows `RESCUE`) — click the pencil/edit icon
3. Change to **Hard disk** (normal mode)
4. Click **Reboot**

> The server will come up clean — no Docker containers will auto-start (all are `restart=no` or `restart=unless-stopped` but Docker itself won't be running until the daemon starts).

---

## Step 2 — Fix SSH known_hosts

The rescue OS has a different host key, so SSH will warn you. After rebooting to normal mode, clear the old key:

```bash
ssh-keygen -R 148.113.191.22
```

Then connect:
```bash
ssh ubuntu@148.113.191.22
# or via Tailscale:
ssh ubuntu@ovh-daq-server
```

---

## Step 3 — Restore missing binaries

The OOM killer can delete binaries from disk. Check and fix each one:

### cloudflared
```bash
sudo systemctl status cloudflared
# If "status=203/EXEC" — binary is missing

curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
  -o /tmp/cloudflared
sudo mv /tmp/cloudflared /usr/bin/cloudflared
sudo chmod +x /usr/bin/cloudflared
sudo systemctl restart cloudflared
sudo systemctl status cloudflared
```

### tailscale
```bash
sudo systemctl status tailscaled
# If "status=203/EXEC" — binary is missing

sudo apt-get install --reinstall tailscale -y
sudo systemctl restart tailscaled
tailscale status
```

### containerd (Docker runtime)
```bash
# If Docker containers fail to start with:
# "containerd-shim-runc-v2: file does not exist"

sudo apt-get install --reinstall containerd.io -y
sudo systemctl daemon-reload
sudo systemctl start docker
docker info | grep "Server Version"
```

---

## Step 4 — Start the Docker stack

```bash
cd /home/ubuntu/projects/daq-server-components/installer
docker compose up -d
```

Wait ~30 seconds for InfluxDB to become healthy, then verify:

```bash
docker ps --format 'table {{.Names}}\t{{.Status}}'
```

Expected running containers:
| Container | Notes |
|---|---|
| influxdb3 | Should show `(healthy)` |
| influxdb3-explorer | InfluxDB UI |
| grafana | Dashboard |
| grafana-bridge | Grafana API bridge |
| file-uploader | |
| data-downloader-api | Waits for influxdb3 healthy |
| data-downloader-scanner | |
| data-downloader-frontend | |
| health-monitor | |
| sandbox | |
| code-generator | |
| slackbot | Exits cleanly if `ENABLE_SLACK=false` |
| startup-data-loader | Runs once then exits — normal |

> `lap-detector` is intentionally disabled. To run it: `docker compose --profile disabled up lap-detector -d`

---

## Step 5 — Verify Cloudflare tunnel

```bash
sudo systemctl status cloudflared
# Should show "Registered tunnel connection" in logs
```

Check that https://grafana.westernformularacing.org loads.

---

## Investigating an OOM crash

If the server crashed again and you're in rescue mode:

```bash
# Mount original disk
mkdir -p /mnt/vps
mount /dev/sdb1 /mnt/vps

# Check what got OOM-killed and when
journalctl --directory=/mnt/vps/var/log/journal \
  --since="2 hours ago" --no-pager \
  | grep -iE "oom|killed|memory" | head -50

# Check disk usage
df -h /mnt/vps
du -sh /mnt/vps/var/lib/docker /mnt/vps/var/lib/containerd /mnt/vps/var/log/journal

# Vacuum logs if journal is large (>500MB)
journalctl --vacuum-size=200M
```

---

## Preventing OOM crashes

Memory limits are now set in `docker-compose.yml`. Key limits:

| Service | Limit |
|---|---|
| influxdb3 | 4096M |
| file-uploader | 1536M |
| data-downloader-api | 1024M |
| sandbox | 1024M |
| grafana | 512M |
| others | 128–512M |

**Total ceiling: ~9GB** across all services (server has 8GB RAM + 8GB swap).

If OOM happens again, check which container hit its limit:
```bash
docker stats --no-stream
# or check logs:
sudo journalctl -u docker --since="1 hour ago" | grep -i "oom\|killed"
```

Daily restart is scheduled at 4 AM to clear any memory accumulation:
```bash
crontab -l  # shows: 0 4 * * * docker compose restart
# Logs at: /var/log/docker-restart.log
```

---

## Quick reference

| Service | Port |
|---|---|
| InfluxDB | 9000 |
| InfluxDB Explorer | 8888 |
| Grafana | 8087 (also via Cloudflare tunnel) |
| Grafana Bridge | 3001 |
| File Uploader | 8084 |
| Data Downloader API | 8000 |
| Data Downloader Frontend | 3000 |
| Lap Detector (disabled) | 8050 |

Tailscale IP: `100.72.11.60` (hostname: `ovh-daq-server`)

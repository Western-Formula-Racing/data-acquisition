# Chargecart Deployment

Chargecart is a Pi 4B kiosk/control appliance. It should run the minimum UTS path only: CAN RX, an RX websocket for the display/tunnel, and local-only guarded TX for BMS balancing.

Do not run TimescaleDB, Grafana, server installer services, hot/cold persistence, video, or audio on the chargecart Pi.

## One-click deploy

Run from the repo root on the chargecart Pi (after cloning/pulling):

```bash
sudo ./universal-telemetry-software/deploy/chargecart-deploy.sh
```

This idempotently installs and starts everything below. It is safe to re-run
after a `git pull` — it will restart services and rebuild the PECAN frontend.

### What the script does

| Step | What happens |
|------|-------------|
| `can0.service` | Installs + enables SocketCAN at boot, brings up can0 at 500 kbps |
| Python deps | Runs `uv sync` as the `chargecart` user |
| `chargecart-uts` | Installs, enables, and restarts the UTS service |
| PECAN kiosk | Runs `npm ci && npm run build`, syncs `dist/` to `/var/www/chargecart`, configures nginx |
| Cloudflare tunnel | Installed **only** if the credential JSON already exists (see below); otherwise skipped with a warning |

If `can0` is not up yet (device-tree overlay added for the first time), the
script installs everything and exits cleanly. After a reboot `can0.service` and
`chargecart-uts.service` will both start in the correct order.

## Pi Services (manual reference)

The deploy script handles this automatically. The following documents what it
sets up and why.

### SocketCAN (`can0`)

`chargecart-uts.service` declares `Wants=can0.service` and `After=can0.service`
so systemd orders the CAN interface up before UTS starts. `can0.service` is the
unit installed by the deploy script (500 kbps). Works with any CAN HAT
(MCP2515, MCP2517FD, etc.) as long as the correct device-tree overlay is
present in `/boot/firmware/config.txt` and the kernel module is loaded.

### Chargecart UTS

The service runs `main_chargecart.py` and binds:

```text
127.0.0.1:9080  RX telemetry websocket
127.0.0.1:9078  local-only TX websocket
```

The TX bridge is started with `TX_CHARGECART_ONLY=true`, so it rejects generic transmitter messages and accepts only the dedicated `can_send_chargecart_balance` command for:

```text
start -> TORCH_START_BALANCE, CAN 998
stop  -> TORCH_STOP_BALANCE, CAN 999
```

## Cloudflare Tunnel

The tunnel was created from the development machine with ID:

```text
8675ba25-b084-4e4b-9d89-4aa5061d48ac
```

DNS was routed with:

```bash
cloudflared tunnel route dns chargecart chargecart-ws.westernformularacing.org
```

Copy the tunnel credential to the Pi:

```bash
scp ~/.cloudflared/8675ba25-b084-4e4b-9d89-4aa5061d48ac.json chargecart@<chargecart-pi>:/home/chargecart/.cloudflared/
```

Then copy the service config:

```bash
sudo mkdir -p /etc/cloudflared
sudo cp universal-telemetry-software/deploy/chargecart-cloudflared.yml /etc/cloudflared/chargecart.yml
```

Install the tunnel service:

```bash
sudo cp universal-telemetry-software/deploy/chargecart-cloudflared.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now chargecart-cloudflared
```

The provided tunnel config exposes only:

```text
wss://chargecart-ws.westernformularacing.org/ws -> http://127.0.0.1:9080
```

It intentionally does not expose `9078`.

## Frontend Hosting

Host the frontend with Cloudflare Pages, like Flight Recorder, rather than serving the full app from the Pi.

Use a separate Cloudflare Pages project for chargecart:

```text
Project name: wfr-chargecart
Root directory: pecan
Build command: npm ci && npm run build
Build output: dist
Custom domain: chargecart.westernformularacing.org
Zero Trust: protect chargecart.westernformularacing.org
```

The route is:

```text
https://chargecart.westernformularacing.org/chargecart
```

On that hostname, the frontend is RX-only and connects to:

```text
wss://chargecart-ws.westernformularacing.org/ws
```

DNS should be split cleanly:

```text
chargecart     -> Cloudflare Pages custom domain for wfr-chargecart
chargecart-ws  -> Cloudflare Tunnel CNAME for the Pi RX websocket
```

## Kiosk

Install the local static frontend for the physical 7-inch screen:

```bash
cd /home/chargecart/data-acquisition/pecan
npm ci
npm run build

sudo mkdir -p /var/www/chargecart
sudo rsync -a --delete dist/ /var/www/chargecart/

sudo apt install -y nginx
sudo cp /home/chargecart/data-acquisition/universal-telemetry-software/deploy/chargecart-nginx.conf /etc/nginx/sites-available/chargecart
sudo ln -sf /etc/nginx/sites-available/chargecart /etc/nginx/sites-enabled/chargecart
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl enable --now nginx
sudo systemctl reload nginx
```

The physical 7-inch screen should open Chromium to:

```text
http://localhost/chargecart
```

The nginx config serves `/var/www/chargecart`, not the checkout under `/home/chargecart`. Keeping the web root outside the home directory avoids relying on broad execute permissions on `/home/chargecart`, `/home/chargecart/data-acquisition`, and `/home/chargecart/data-acquisition/pecan`. After each frontend rebuild, refresh the deployed static files with:

```bash
cd /home/chargecart/data-acquisition/pecan
npm run build
sudo rsync -a --delete dist/ /var/www/chargecart/
sudo systemctl reload nginx
```

Use `localhost`, not `127.0.0.1`, because `127.0.0.1` is reserved by the frontend for demo websocket mode. The local page has TX controls; the Cloudflare Pages hostname remains RX-only.

## Verification

```bash
systemctl status chargecart-uts
systemctl status chargecart-cloudflared
journalctl -u chargecart-uts -f
journalctl -u chargecart-cloudflared -f
curl -I https://chargecart.westernformularacing.org/chargecart
```

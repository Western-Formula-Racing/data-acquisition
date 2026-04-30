#!/usr/bin/env bash
set -euo pipefail

TUNNEL_NAME="${TUNNEL_NAME:-daq-car-lte}"
HOSTNAME="${1:-${CLOUDFLARE_HOSTNAME:-}}"
SERVICE_URL="${SERVICE_URL:-http://127.0.0.1:9089}"
SERVICE_USER="${SUDO_USER:-$(logname 2>/dev/null || whoami)}"
SERVICE_HOME="$(getent passwd "$SERVICE_USER" | cut -d: -f6)"
CONFIG_DIR="/etc/cloudflared"
CONFIG_FILE="$CONFIG_DIR/config.yml"
LINK_FILE="$SERVICE_HOME/Desktop/daq-car-lte-wss-url.txt"

if [[ -z "$HOSTNAME" ]]; then
    echo "Usage: $0 <cloudflare-hostname>"
    echo "Example: $0 daq-car-lte.example.com"
    exit 1
fi

if [[ $EUID -ne 0 ]]; then
    echo "Run as root: sudo $0 $HOSTNAME"
    exit 1
fi

sudo -u "$SERVICE_USER" cloudflared tunnel login
sudo -u "$SERVICE_USER" cloudflared tunnel create "$TUNNEL_NAME" || true
sudo -u "$SERVICE_USER" cloudflared tunnel route dns "$TUNNEL_NAME" "$HOSTNAME"

CREDENTIALS_FILE="$(sudo -u "$SERVICE_USER" sh -c "ls -t '$SERVICE_HOME'/.cloudflared/*.json | head -1")"
mkdir -p "$CONFIG_DIR"
cat > "$CONFIG_FILE" <<EOF
tunnel: $TUNNEL_NAME
credentials-file: $CREDENTIALS_FILE

ingress:
  - hostname: $HOSTNAME
    service: $SERVICE_URL
  - service: http_status:404
EOF

cloudflared service install || true
systemctl enable cloudflared
systemctl restart cloudflared

mkdir -p "$SERVICE_HOME/Desktop"
printf 'wss://%s\n' "$HOSTNAME" > "$LINK_FILE"
chown "$SERVICE_USER:$SERVICE_USER" "$LINK_FILE"

printf '\nLTE relay WebSocket URL:\n  wss://%s\n\nSaved to:\n  %s\n' "$HOSTNAME" "$LINK_FILE"

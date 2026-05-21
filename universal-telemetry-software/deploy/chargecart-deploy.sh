#!/usr/bin/env bash
# chargecart-deploy.sh — Idempotent chargecart Pi deployment
#
# Installs and starts:
#   can0.service      — SocketCAN interface at boot (MCP2517FD HAT, 500 kbps)
#   chargecart-uts    — Minimal UTS: CAN reader + RX/TX websockets
#   nginx             — Serves local PECAN kiosk at http://localhost/chargecart
#
# Cloudflare tunnel is OPTIONAL. Automatically enabled when the credential JSON
# is present at ~/.cloudflared/<tunnel-id>.json for the chargecart user.
# Skipped with a warning when the credential is absent — the kiosk still works
# fully on the local screen without it.
#
# Safe to re-run after a git pull to update services and rebuild the frontend.
#
# Usage (from anywhere inside the repo):
#   sudo ./universal-telemetry-software/deploy/chargecart-deploy.sh
#
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓ $*${NC}"; }
warn() { echo -e "${YELLOW}⚠ $*${NC}"; }
die()  { echo -e "${RED}✗ $*${NC}"; exit 1; }
step() { echo -e "\n${YELLOW}── $* ──${NC}"; }

[[ $EUID -eq 0 ]] || die "Run as root: sudo $0"

# ── Resolve paths from script location ────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UTS_DIR="$(dirname "$SCRIPT_DIR")"
REPO_DIR="$(dirname "$UTS_DIR")"
PECAN_DIR="$REPO_DIR/pecan"
CHARGECART_USER="chargecart"
WEB_ROOT="/var/www/chargecart"
TUNNEL_UUID="8675ba25-b084-4e4b-9d89-4aa5061d48ac"
TUNNEL_CRED="/home/${CHARGECART_USER}/.cloudflared/${TUNNEL_UUID}.json"

echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}   WFR Chargecart — Deployment             ${NC}"
echo -e "${GREEN}============================================${NC}"
echo -e "  Repo:  $REPO_DIR"
echo -e "  UTS:   $UTS_DIR"
echo -e "  PECAN: $PECAN_DIR"
echo ""

# Sanity-check repo layout before touching anything
[[ -f "$UTS_DIR/main_chargecart.py" ]]            || die "main_chargecart.py not found — wrong directory? ($UTS_DIR)"
[[ -f "$PECAN_DIR/package.json" ]]                 || die "pecan/package.json not found ($PECAN_DIR)"
[[ -f "$SCRIPT_DIR/chargecart-uts.service" ]]      || die "chargecart-uts.service not found ($SCRIPT_DIR)"
[[ -f "$SCRIPT_DIR/chargecart-nginx.conf" ]]       || die "chargecart-nginx.conf not found ($SCRIPT_DIR)"

# ── 1. SocketCAN / can0.service ───────────────────────────────────────────────
step "SocketCAN (can0)"

if ! command -v cansend &>/dev/null; then
    warn "can-utils not found — installing"
    apt-get update -qq && apt-get install -y can-utils
fi
ok "can-utils present"

CAN_SERVICE=/etc/systemd/system/can0.service
if [[ ! -f "$CAN_SERVICE" ]]; then
    cat > "$CAN_SERVICE" <<'EOF'
[Unit]
Description=CAN bus interface can0
After=network.target

[Service]
Type=oneshot
ExecStart=/sbin/ip link set can0 up type can bitrate 500000
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF
    ok "can0.service created"
else
    ok "can0.service already present"
fi

systemctl daemon-reload
systemctl enable can0
ok "can0.service enabled at boot"

# Try to bring the interface up now; only succeeds after HAT overlay is active
if ip link set can0 up type can bitrate 500000 2>/dev/null; then
    ok "can0 is UP at 500 kbps"
    ip link show can0
else
    warn "can0 not yet available — check that the CAN HAT device-tree overlay is in /boot/firmware/config.txt"
    warn "If the overlay was just added, a reboot is required. Services are installed and will start correctly after reboot."
fi

# ── 2. Python deps (uv sync) ──────────────────────────────────────────────────
step "Python dependencies"

if ! sudo -u "$CHARGECART_USER" bash -c 'command -v uv &>/dev/null'; then
    warn "uv not found for user $CHARGECART_USER — installing"
    sudo -u "$CHARGECART_USER" bash -c 'curl -LsSf https://astral.sh/uv/install.sh | sh'
fi

sudo -u "$CHARGECART_USER" bash -c "cd '$UTS_DIR' && ~/.local/bin/uv sync"
ok "Python deps synced"

# ── 3. chargecart-uts.service ─────────────────────────────────────────────────
step "chargecart-uts service"

cp "$SCRIPT_DIR/chargecart-uts.service" /etc/systemd/system/chargecart-uts.service
systemctl daemon-reload
systemctl enable chargecart-uts
systemctl restart chargecart-uts
ok "chargecart-uts installed, enabled, and started"

# ── 4. PECAN kiosk frontend ───────────────────────────────────────────────────
step "PECAN kiosk frontend"

if ! command -v npm &>/dev/null; then
    warn "npm not found — installing nodejs"
    apt-get update -qq && apt-get install -y nodejs npm
fi

sudo -u "$CHARGECART_USER" bash -c "cd '$PECAN_DIR' && npm ci && npm run build"
ok "PECAN built"

if ! command -v nginx &>/dev/null; then
    apt-get update -qq && apt-get install -y nginx
fi
ok "nginx present"

mkdir -p "$WEB_ROOT"
rsync -a --delete "$PECAN_DIR/dist/" "$WEB_ROOT/"
ok "Static files deployed to $WEB_ROOT"

NGINX_SITE=/etc/nginx/sites-available/chargecart
cp "$SCRIPT_DIR/chargecart-nginx.conf" "$NGINX_SITE"
ln -sf "$NGINX_SITE" /etc/nginx/sites-enabled/chargecart
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable nginx
systemctl reload nginx
ok "nginx configured, enabled, and reloaded"

# ── 5. Cloudflare tunnel (optional) ───────────────────────────────────────────
step "Cloudflare tunnel (optional)"

if [[ ! -f "$TUNNEL_CRED" ]]; then
    warn "Credential not found: $TUNNEL_CRED"
    warn "Skipping tunnel. See CHARGECART_DEPLOY.md to copy the credential, then re-run."
elif ! command -v cloudflared &>/dev/null; then
    warn "cloudflared binary not installed — skipping tunnel"
    warn "Install cloudflared, copy the credential, and re-run to enable remote access."
else
    mkdir -p /etc/cloudflared
    cp "$SCRIPT_DIR/chargecart-cloudflared.yml" /etc/cloudflared/chargecart.yml
    cp "$SCRIPT_DIR/chargecart-cloudflared.service" /etc/systemd/system/chargecart-cloudflared.service
    systemctl daemon-reload
    systemctl enable chargecart-cloudflared
    systemctl restart chargecart-cloudflared
    ok "Cloudflare tunnel installed, enabled, and started"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}   Deployment complete                     ${NC}"
echo -e "${GREEN}============================================${NC}"

_status() { systemctl is-active "$1" 2>/dev/null || echo "inactive"; }
_can0()   { ip link show can0 2>/dev/null | grep -oE 'state [A-Z]+' | awk '{print $2}' || echo "unavailable"; }

echo -e "  chargecart-uts : $(_status chargecart-uts)"
echo -e "  nginx          : $(_status nginx)"
echo -e "  can0           : $(_can0)"
if systemctl is-enabled chargecart-cloudflared &>/dev/null; then
    echo -e "  cloudflared    : $(_status chargecart-cloudflared)"
fi
echo ""
echo -e "  Kiosk URL  : http://localhost/chargecart"
echo -e "  Logs       : journalctl -u chargecart-uts -f"
echo -e "  Status     : systemctl status chargecart-uts"
echo -e "${GREEN}============================================${NC}"

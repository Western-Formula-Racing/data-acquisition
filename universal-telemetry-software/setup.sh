#!/usr/bin/env bash
# setup.sh — Full first-time setup for the car/base RPi
#
# Covers: system packages, GStreamer/gi bindings, CAN kernel modules,
# MCP2517FD device tree overlay (20 MHz crystal), can0 boot service,
# uv install, Python venv, car-telemetry systemd service,
# static IP on eth0, WiFi routing priority, Tailscale, NoMachine.
#
# Usage: sudo ./setup.sh [--car | --base]
#   --car   non-interactive car setup  (10.71.1.10, remote 10.71.1.20)
#   --base  non-interactive base setup (10.71.1.20, remote 10.71.1.10)
#   (omit flag for interactive role prompt)

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; NC='\033[0m'

ok()   { echo -e "${GREEN}✓ $*${NC}"; }
warn() { echo -e "${YELLOW}  $*${NC}"; }
die()  { echo -e "${RED}✗ $*${NC}"; exit 1; }
hdr()  { echo -e "\n${BOLD}── $* ──${NC}"; }

if [[ $EUID -ne 0 ]]; then
    die "Run as root: sudo $0 $*"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Role selection ────────────────────────────────────────────────────────────
ROLE=""
for arg in "$@"; do
    case "$arg" in
        --car)  ROLE=car  ;;
        --base) ROLE=base ;;
    esac
done

if [[ -z "$ROLE" ]]; then
    echo -e "${YELLOW}Which RPi is this?${NC}"
    echo "  1) Car  — 10.71.1.10  (remote: 10.71.1.20)"
    echo "  2) Base — 10.71.1.20  (remote: 10.71.1.10)"
    echo ""
    read -rp "Enter 1 or 2: " choice
    case "$choice" in
        1) ROLE=car  ;;
        2) ROLE=base ;;
        *) die "Invalid choice." ;;
    esac
fi

if [[ "$ROLE" == "car" ]]; then
    LOCAL_IP="10.71.1.10"
    REMOTE_IP="10.71.1.20"
else
    LOCAL_IP="10.71.1.20"
    REMOTE_IP="10.71.1.10"
fi

# Derive the real user who will run the service (the one who called sudo)
SERVICE_USER="${SUDO_USER:-$(logname 2>/dev/null || echo car)}"
SERVICE_HOME="$(getent passwd "$SERVICE_USER" | cut -d: -f6)"
UV="$SERVICE_HOME/.local/bin/uv"

echo ""
echo -e "${BOLD}Role:${NC}         $ROLE"
echo -e "${BOLD}Local IP:${NC}     $LOCAL_IP"
echo -e "${BOLD}Remote IP:${NC}    $REMOTE_IP"
echo -e "${BOLD}Service user:${NC} $SERVICE_USER ($SERVICE_HOME)"
echo ""

# ── 1. System packages ────────────────────────────────────────────────────────
hdr "System packages"
apt-get update -qq
apt-get install -y \
    can-utils \
    python3-gi \
    python3-gst-1.0 \
    gstreamer1.0-tools \
    gstreamer1.0-plugins-base \
    gstreamer1.0-plugins-good \
    curl
ok "System packages installed"

# ── 2. CAN kernel modules ─────────────────────────────────────────────────────
hdr "CAN kernel modules"
for mod in can can_raw mcp251xfd; do
    modprobe "$mod"
    if ! grep -qx "$mod" /etc/modules 2>/dev/null; then
        echo "$mod" >> /etc/modules
    fi
done
ok "Modules loaded and persisted in /etc/modules"

# ── 3. MCP2517FD device tree overlay (20 MHz crystal) ────────────────────────
hdr "Boot config — MCP2517FD overlay"
CONFIG=/boot/firmware/config.txt
for line in \
    "dtoverlay=mcp251xfd,oscillator=20000000,interrupt=25" \
    "dtoverlay=spi-bcm2835"
do
    if grep -qF "$line" "$CONFIG" 2>/dev/null; then
        warn "Already present: $line"
    else
        echo "$line" >> "$CONFIG"
        ok "Added: $line"
    fi
done

# ── 4. can0 boot service ──────────────────────────────────────────────────────
hdr "can0 systemd service"
cat > /etc/systemd/system/can0.service <<'EOF'
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
systemctl daemon-reload
systemctl enable can0
ok "can0.service installed and enabled"

if ip link set can0 up type can bitrate 500000 2>/dev/null; then
    ok "can0 is UP at 500 kbps"
else
    warn "can0 not yet available — overlay activates after reboot"
fi

# ── 5. Install uv ─────────────────────────────────────────────────────────────
hdr "uv"
if [[ -x "$UV" ]]; then
    ok "uv already installed at $UV"
else
    sudo -u "$SERVICE_USER" env HOME="$SERVICE_HOME" \
        sh -c 'curl -LsSf https://astral.sh/uv/install.sh | sh'
    ok "uv installed at $UV"
fi

# ── 6. Enable Wayland compositor (required for NoMachine on headless Pi) ─────
hdr "Wayland compositor"
if raspi-config nonint get_wayland 2>/dev/null | grep -q "W2"; then
    ok "Wayland already enabled"
else
    raspi-config nonint do_wayland W2
    ok "Wayland enabled (Wayfire) — takes effect after reboot"
fi

# ── 8. Python venv + dependencies ────────────────────────────────────────────
hdr "Python venv (system-site-packages for gi/GStreamer)"
cd "$SCRIPT_DIR"
sudo -u "$SERVICE_USER" env HOME="$SERVICE_HOME" \
    "$UV" venv --system-site-packages --clear .venv
sudo -u "$SERVICE_USER" env HOME="$SERVICE_HOME" \
    "$UV" sync
ok "venv ready at $SCRIPT_DIR/.venv"

# ── 7. car-telemetry systemd service ─────────────────────────────────────────
hdr "car-telemetry systemd service"
SERVICE_SRC="$SCRIPT_DIR/deploy/car-telemetry.service"
GIT_HASH=$(git -C "$SCRIPT_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)

sed \
    -e "s|User=.*|User=$SERVICE_USER|" \
    -e "s|WorkingDirectory=.*|WorkingDirectory=$SCRIPT_DIR|" \
    -e "s|ExecStart=.*uv run|ExecStart=$UV run|" \
    -e "s|REMOTE_IP=.*|REMOTE_IP=$REMOTE_IP|" \
    -e "s|GIT_HASH=.*|GIT_HASH=$GIT_HASH|" \
    "$SERVICE_SRC" > /etc/systemd/system/car-telemetry.service

systemctl daemon-reload
systemctl enable car-telemetry
ok "car-telemetry.service installed and enabled (hash=$GIT_HASH, remote=$REMOTE_IP)"

if [[ "$ROLE" == "car" ]]; then
    systemctl restart car-telemetry
    ok "car-telemetry started"
else
    warn "Base role — skipping car-telemetry start"
fi

# ── 8. Static IP on eth0 + WiFi routing priority ─────────────────────────────
# eth0 gets a high metric (low priority for default route) so WiFi remains the
# default gateway for internet traffic even when the radio link is connected.
# eth0 is still reachable at 10.71.1.x for the telemetry link.
hdr "Static IP — eth0 (metric 200, WiFi stays default route)"
NETPLAN_FILE=/etc/netplan/10-eth0-static.yaml
cat > "$NETPLAN_FILE" <<EOF
network:
  version: 2
  ethernets:
    eth0:
      addresses:
        - ${LOCAL_IP}/24
      routes:
        - to: 10.71.1.0/24
          via: 0.0.0.0
          metric: 200
          on-link: true
      dhcp4: false
      dhcp6: false
EOF
chmod 600 "$NETPLAN_FILE"
ok "Written $NETPLAN_FILE"

# WiFi remains the default route automatically — eth0's netplan has no gateway,
# so it only adds a host route to 10.71.1.0/24 and never competes for default.

echo -e "${YELLOW}Applying netplan...${NC}"
netplan apply
ok "netplan applied"

ASSIGNED=$(ip addr show eth0 2>/dev/null | grep -oP "inet \K[0-9.]+" || echo "")
if [[ "$ASSIGNED" == "$LOCAL_IP" ]]; then
    ok "eth0 is now ${LOCAL_IP}/24"
else
    warn "eth0 shows '${ASSIGNED:-none}' — expected '${LOCAL_IP}' (cable may not be plugged in yet)"
fi

# ── 9. Tailscale ─────────────────────────────────────────────────────────────
hdr "Tailscale"
if command -v tailscale &>/dev/null; then
    ok "Tailscale already installed ($(tailscale version | head -1))"
else
    curl -fsSL https://tailscale.com/install.sh | sh
    ok "Tailscale installed"
fi
systemctl enable --now tailscaled
warn "Run 'sudo tailscale up' to authenticate this node"

# ── 10. NoMachine ─────────────────────────────────────────────────────────────
hdr "NoMachine"
if command -v nxserver &>/dev/null || dpkg -l nomachine &>/dev/null 2>&1; then
    ok "NoMachine already installed"
else
    NX_URL="https://web9001.nomachine.com/download/9.4/Raspberry/nomachine_9.4.14_1_arm64.deb"
    NX_DEB="/tmp/nomachine.deb"
    echo "  Downloading NoMachine for $ARCH..."
    curl -L "$NX_URL" -o "$NX_DEB"
    dpkg -i "$NX_DEB"
    rm -f "$NX_DEB"
    ok "NoMachine installed"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}=========================================${NC}"
echo -e "${GREEN}${BOLD}  Setup complete${NC}"
echo -e "${GREEN}${BOLD}=========================================${NC}"
echo -e "  Role:          $ROLE"
echo -e "  This Pi:       ${LOCAL_IP}/24 (eth0)"
echo -e "  Remote:        $REMOTE_IP"
echo -e "  WiFi:          default route (eth0 has no gateway)"
echo -e "  Git hash:      $GIT_HASH"
echo ""
echo -e "  ${YELLOW}Next steps:${NC}"
echo -e "    sudo tailscale up          # authenticate Tailscale"
echo -e "    sudo reboot                # activates MCP2517FD overlay"
echo ""
echo -e "  After reboot:"
echo -e "    ip link show can0"
echo -e "    systemctl status car-telemetry"
echo -e "    journalctl -u car-telemetry -f"
echo -e "${GREEN}${BOLD}=========================================${NC}"

#!/usr/bin/env bash
# setup.sh — Full first-time setup for the car/base RPi
#
# Covers: system packages, GStreamer/gi bindings, CAN HAT setup (setup-socketcan.sh),
# uv install, Python venv, car-telemetry and CAN recorder systemd services (car only),
# static IP on eth0, WiFi routing priority, Tailscale, NoMachine.
#
# Usage: sudo ./setup.sh [--car | --base] [--wayland]
#   --car      non-interactive car setup  (10.71.1.10, remote 10.71.1.20)
#   --base     non-interactive base setup (10.71.1.20, remote 10.71.1.10)
#   --wayland  switch the desktop to Wayland (Labwc), for NoMachine on a headless Pi.
#              Remote Desktop (xrdp) sessions crashed on login after this on the car Pi.
#   (omit --car/--base for an interactive role prompt)

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
WAYLAND=false
for arg in "$@"; do
    case "$arg" in
        --car)     ROLE=car  ;;
        --base)    ROLE=base ;;
        --wayland) WAYLAND=true ;;
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
SERVICE_USER="${SUDO_USER:-$(logname 2>/dev/null || echo base)}"
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

# ── 2. CAN HAT ────────────────────────────────────────────────────────────────
hdr "CAN HAT"
"$SCRIPT_DIR/setup-socketcan.sh"

# ── 3. Install uv ─────────────────────────────────────────────────────────────
hdr "uv"
if [[ -x "$UV" ]]; then
    ok "uv already installed at $UV"
else
    sudo -u "$SERVICE_USER" env HOME="$SERVICE_HOME" \
        sh -c 'curl -LsSf https://astral.sh/uv/install.sh | sh'
    ok "uv installed at $UV"
fi

# ── 4. Desktop session ───────────────────────────────────────────────────────
# Left as it is unless asked: on the car Pi, Remote Desktop (xrdp) sessions crashed on
# login after this switched to Wayland.
if [[ "$WAYLAND" == true ]]; then
    hdr "Wayland compositor"
    if raspi-config nonint get_wayland 2>/dev/null | grep -q "W2"; then
        ok "Wayland already enabled"
    else
        # W2 is Labwc in current raspi-config. W1 (X11) undoes it.
        raspi-config nonint do_wayland W2
        ok "Wayland enabled (Labwc) — takes effect after reboot"
        warn "If Remote Desktop sessions close on login, undo with: sudo raspi-config nonint do_wayland W1"
    fi
fi

# ── 5. Python venv + dependencies ────────────────────────────────────────────
hdr "Python venv (system-site-packages for gi/GStreamer)"
cd "$SCRIPT_DIR"
sudo -u "$SERVICE_USER" env HOME="$SERVICE_HOME" \
    "$UV" venv --system-site-packages --clear .venv
sudo -u "$SERVICE_USER" env HOME="$SERVICE_HOME" \
    "$UV" sync
ok "venv ready at $SCRIPT_DIR/.venv"

# ── 6. car-telemetry systemd service ─────────────────────────────────────────
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
ok "car-telemetry.service installed (hash=$GIT_HASH, remote=$REMOTE_IP)"

# A base station runs through Docker, so it must not start this at boot.
if [[ "$ROLE" == "car" ]]; then
    systemctl enable car-telemetry
    systemctl restart car-telemetry
    ok "car-telemetry enabled and started"
else
    warn "Base role — car-telemetry left disabled"
fi

# ── 7. CAN recorder (car only) ───────────────────────────────────────────────
if [[ "$ROLE" == "car" ]]; then
    hdr "CAN recorder"
    sed \
        -e "s|^User=.*|User=$SERVICE_USER|" \
        -e "s|^WorkingDirectory=.*|WorkingDirectory=$SCRIPT_DIR|" \
        "$SCRIPT_DIR/deploy/can-recorder.service" > /etc/systemd/system/can-recorder.service
    install -m 644 "$SCRIPT_DIR/deploy/99-can-recorder.conf" /etc/sysctl.d/99-can-recorder.conf
    sysctl --system >/dev/null
    systemctl daemon-reload
    systemctl enable can-recorder
    systemctl restart --no-block can-recorder
    # These write to the card, and they catch up soon after boot, which on a car
    # is the start of a session. See deploy/CAN_RECORDER.md.
    systemctl mask --now apt-daily.timer apt-daily-upgrade.timer man-db.timer \
        fstrim.timer dpkg-db-backup.timer e2scrub_all.timer
    ok "can-recorder enabled, background disk timers masked"
fi

# ── 8. Static IP on eth0 + WiFi routing priority ─────────────────────────────
# eth0 gets no gateway, so WiFi remains the default route for internet traffic while
# the radio link carries 10.71.1.x. Also writes deploy/.env with REMOTE_IP.
hdr "Static IP — eth0"
"$SCRIPT_DIR/setup-static-ip.sh" "--$ROLE"

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
    echo "  Downloading NoMachine..."
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
echo -e "    sudo reboot                # activates the CAN HAT overlay"
echo ""
echo -e "  After reboot:"
echo -e "    ip -d link show can0"
if [[ "$ROLE" == "car" ]]; then
    echo -e "    systemctl status car-telemetry can-recorder"
fi
if [[ "$ROLE" == "car" ]]; then
    echo -e "    journalctl -u car-telemetry -f"
fi
echo -e "${GREEN}${BOLD}=========================================${NC}"

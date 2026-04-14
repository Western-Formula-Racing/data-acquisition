#!/usr/bin/env bash
# setup-socketcan.sh — One-click SocketCAN setup for the car RPi (MCP2517FD HAT)
# Usage: sudo ./setup-socketcan.sh
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

if [[ $EUID -ne 0 ]]; then
    echo -e "${RED}Run as root: sudo $0${NC}"
    exit 1
fi

echo -e "${YELLOW}Setting up SocketCAN for MCP2517FD HAT...${NC}"

# ── 1. Install can-utils ───────────────────────────────────────────────────────
if ! command -v cansend &>/dev/null; then
    echo "Installing can-utils..."
    apt-get update -qq && apt-get install -y can-utils
fi
echo -e "${GREEN}✓ can-utils present${NC}"

# ── 2. Load kernel modules now + persist across reboots ───────────────────────
for mod in can can_raw mcp251xfd; do
    modprobe "$mod"
    if ! grep -qx "$mod" /etc/modules 2>/dev/null; then
        echo "$mod" >> /etc/modules
    fi
done
echo -e "${GREEN}✓ CAN kernel modules loaded and persisted in /etc/modules${NC}"

# ── 3. Configure device tree overlay ──────────────────────────────────────────
CONFIG=/boot/firmware/config.txt
OVERLAY_LINE="dtoverlay=mcp251xfd,oscillator=20000000,interrupt=25"
SPI_LINE="dtoverlay=spi-bcm2835"

for line in "$OVERLAY_LINE" "$SPI_LINE"; do
    if ! grep -qF "$line" "$CONFIG" 2>/dev/null; then
        echo "$line" >> "$CONFIG"
        echo -e "${GREEN}✓ Added to $CONFIG: $line${NC}"
    else
        echo -e "${YELLOW}  Already in $CONFIG: $line${NC}"
    fi
done

# ── 4. Create systemd service to bring up can0 at boot ────────────────────────
SERVICE=/etc/systemd/system/can0.service
cat > "$SERVICE" <<'EOF'
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
echo -e "${GREEN}✓ can0.service installed and enabled${NC}"

# ── 5. Try to bring up can0 now (only works if HAT is already active) ─────────
echo ""
echo -e "${YELLOW}Attempting to bring up can0 now (requires HAT + overlay active)...${NC}"
if ip link set can0 up type can bitrate 500000 2>/dev/null; then
    echo -e "${GREEN}✓ can0 is UP at 500 kbps${NC}"
    ip link show can0
else
    echo -e "${YELLOW}  can0 not yet available — overlay takes effect after reboot.${NC}"
    echo -e "${YELLOW}  Run: sudo reboot${NC}"
fi

echo ""
echo -e "${GREEN}=========================================${NC}"
echo -e "${GREEN}  Setup complete — next steps:${NC}"
echo -e "${GREEN}=========================================${NC}"
echo -e "  1. Plug in the CAN HAT (if not already)"
echo -e "  2. sudo reboot"
echo -e "  3. Verify CAN is up:   ip link show can0"
echo -e "  4. Start the stack:    docker compose -f deploy/docker-compose.rpi-base.yml --profile base up -d"
echo -e "  5. Check role:         docker compose -f deploy/docker-compose.rpi-base.yml logs telemetry | grep Role"
echo -e "${GREEN}=========================================${NC}"

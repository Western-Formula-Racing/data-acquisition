#!/usr/bin/env bash
# setup-static-ip.sh — Assign a persistent static IP to eth0 for the radio link
# Usage: sudo ./setup-static-ip.sh
#
# Sets eth0 to 192.168.1.10/24 (car) or 192.168.1.20/24 (base).
# No gateway is set — the radio link is a direct point-to-point connection.
#
# Also writes deploy/.env with per-Pi settings (REMOTE_IP, SET_TIME_ENABLED)
# so git reset never clobbers them.
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

if [[ $EUID -ne 0 ]]; then
    echo -e "${RED}Run as root: sudo $0${NC}"
    exit 1
fi

echo -e "${YELLOW}Static IP setup for eth0 (Ubiquiti radio link)${NC}"
echo ""
echo "Which RPi is this?"
echo "  1) Car  — 10.71.1.10"
echo "  2) Base — 10.71.1.20"
echo ""
read -rp "Enter 1 or 2: " choice

case "$choice" in
    1) IP="10.71.1.10"; ROLE="car";  REMOTE_IP="10.71.1.20" ;;
    2) IP="10.71.1.20"; ROLE="base"; REMOTE_IP="10.71.1.10" ;;
    *) echo -e "${RED}Invalid choice. Enter 1 or 2.${NC}"; exit 1 ;;
esac

NETPLAN_FILE=/etc/netplan/10-eth0-static.yaml
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/deploy/.env"

# ── Write netplan config ───────────────────────────────────────────────────────
cat > "$NETPLAN_FILE" <<EOF
network:
  version: 2
  ethernets:
    eth0:
      addresses:
        - ${IP}/24
EOF

chmod 600 "$NETPLAN_FILE"
echo -e "${GREEN}✓ Written $NETPLAN_FILE${NC}"

# ── Apply ─────────────────────────────────────────────────────────────────────
echo -e "${YELLOW}Applying netplan (network will reset briefly — Tailscale may drop for a few seconds)...${NC}"
netplan apply
echo -e "${GREEN}✓ netplan applied${NC}"

# ── Verify ────────────────────────────────────────────────────────────────────
echo ""
ASSIGNED=$(ip addr show eth0 | grep -oP "inet \K[0-9.]+")
if [[ "$ASSIGNED" == "$IP" ]]; then
    echo -e "${GREEN}✓ eth0 is now ${IP}/24 ($ROLE RPi)${NC}"
else
    echo -e "${RED}✗ eth0 shows '${ASSIGNED}' — expected '${IP}'. Check if another netplan file is overriding.${NC}"
    exit 1
fi

# ── Write deploy/.env ─────────────────────────────────────────────────────────
cat > "$ENV_FILE" <<EOF
REMOTE_IP=${REMOTE_IP}
SET_TIME_ENABLED=true
EOF

echo -e "${GREEN}✓ Written $ENV_FILE${NC}"
echo -e "    REMOTE_IP=${REMOTE_IP}"
echo -e "    SET_TIME_ENABLED=true"

echo ""
echo -e "${GREEN}=========================================${NC}"
echo -e "${GREEN}  Static IP set — next steps:${NC}"
echo -e "${GREEN}=========================================${NC}"
if [[ "$ROLE" == "car" ]]; then
    echo -e "  Ping base RPi:  ping -c 4 10.71.1.20"
else
    echo -e "  Ping car RPi:   ping -c 4 10.71.1.10"
fi
echo -e "  IP and deploy/.env persist across reboots and git resets."
echo -e "${GREEN}=========================================${NC}"

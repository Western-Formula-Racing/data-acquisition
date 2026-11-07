#!/usr/bin/env bash
# setup-static-ip.sh — Assign a persistent static IP to eth0 for the radio link
# Usage: sudo ./setup-static-ip.sh [--car | --base]
#
# Sets eth0 to 10.71.1.10/24 (car) or 10.71.1.20/24 (base).
# No gateway is set, so Wi-Fi stays the default route for internet traffic.
#
# Uses a NetworkManager profile, not a netplan file. Raspberry Pi OS's NetworkManager
# writes its own netplan files, and a hand-written one for eth0 got merged into one of
# those on the car Pi, leaving eth0 with two addresses.
#
# Also writes deploy/.env with per-Pi settings (REMOTE_IP, SET_TIME_ENABLED)
# so git reset never clobbers them.
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

CON_NAME="wfr-radio"
IFACE="eth0"
# Above the default "Wired connection 1" profile, so this one wins on eth0.
PRIORITY=100
OLD_NETPLAN_FILE=/etc/netplan/10-eth0-static.yaml

if [[ "$(id -u)" != "0" ]]; then
    echo -e "${RED}Run as root: sudo $0${NC}"
    exit 1
fi

ROLE=""
for arg in "$@"; do
    case "$arg" in
        --car)  ROLE=car  ;;
        --base) ROLE=base ;;
        *) echo -e "${RED}Unknown option: $arg${NC}"; exit 1 ;;
    esac
done

if [[ -z "$ROLE" ]]; then
    echo -e "${YELLOW}Static IP setup for eth0 (Ubiquiti radio link)${NC}"
    echo ""
    echo "Which RPi is this?"
    echo "  1) Car  — 10.71.1.10"
    echo "  2) Base — 10.71.1.20"
    echo ""
    read -rp "Enter 1 or 2: " choice
    case "$choice" in
        1) ROLE=car  ;;
        2) ROLE=base ;;
        *) echo -e "${RED}Invalid choice. Enter 1 or 2.${NC}"; exit 1 ;;
    esac
fi

if [[ "$ROLE" == "car" ]]; then
    IP="10.71.1.10"; REMOTE_IP="10.71.1.20"
else
    IP="10.71.1.20"; REMOTE_IP="10.71.1.10"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/deploy/.env"

command -v nmcli >/dev/null || { echo -e "${RED}This needs NetworkManager (nmcli).${NC}"; exit 1; }

# ── NetworkManager profile ────────────────────────────────────────────────────
# Not grep -q: it can exit early, and pipefail then reports nmcli's SIGPIPE as no match.
if ! nmcli -t -f NAME con show | grep -xF "$CON_NAME" >/dev/null; then
    # autoconnect no: it must not take over eth0 before it's fully configured.
    nmcli con add type ethernet ifname "$IFACE" con-name "$CON_NAME" autoconnect no >/dev/null
fi
nmcli con modify "$CON_NAME" \
    connection.autoconnect yes \
    connection.autoconnect-priority "$PRIORITY" \
    ipv4.method manual \
    ipv4.addresses "$IP/24" \
    ipv4.gateway "" \
    ipv4.never-default yes \
    ipv4.route-metric 200 \
    ipv6.method disabled
echo -e "${GREEN}✓ $CON_NAME profile: $IFACE at ${IP}/24, no gateway${NC}"

if [[ -f "$OLD_NETPLAN_FILE" ]]; then
    echo -e "${YELLOW}  $OLD_NETPLAN_FILE is from an older version of this script. $CON_NAME takes${NC}"
    echo -e "${YELLOW}  priority over it, but delete it and run 'sudo netplan apply' to avoid surprises.${NC}"
fi

# ── Apply ─────────────────────────────────────────────────────────────────────
if ip link show "$IFACE" 2>/dev/null | grep -q 'LOWER_UP'; then
    echo -e "${YELLOW}Applying (anything connected over $IFACE drops briefly)...${NC}"
    if nmcli con up "$CON_NAME" >/dev/null; then
        ASSIGNED=$(ip -4 -br addr show "$IFACE" | awk '{$1=$2=""; print}' | xargs)
        if [[ "$ASSIGNED" == "$IP/24" ]]; then
            echo -e "${GREEN}✓ $IFACE is now ${IP}/24 ($ROLE RPi)${NC}"
        else
            echo -e "${RED}✗ $IFACE shows '${ASSIGNED}', expected only '${IP}/24'. Check: nmcli con show${NC}"
            exit 1
        fi
    else
        echo -e "${RED}✗ Could not bring up $CON_NAME. Check: nmcli con show $CON_NAME${NC}"
        exit 1
    fi
else
    echo -e "${YELLOW}  No cable on $IFACE, so this applies when one is connected.${NC}"
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
echo -e "  The IP and deploy/.env persist across reboots and git resets."
echo -e "${GREEN}=========================================${NC}"

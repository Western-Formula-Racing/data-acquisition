#!/usr/bin/env bash
# setup-socketcan.sh — SocketCAN and clock setup for the car RPi's custom HAT
#
# The HAT has an MCP2515 controller (12 MHz crystal, interrupt on GPIO 17), an
# MCP2562FD transceiver and a PCF8563 clock on I2C bus 1. Safe to re-run: it
# replaces older settings rather than adding to them, and backs up config.txt
# before changing it.
#
# Usage: sudo ./setup-socketcan.sh
#        ./setup-socketcan.sh --update-config FILE   # only edit FILE, for testing
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

CAN_OVERLAY="dtoverlay=mcp2515-can0,oscillator=12000000,interrupt=17,spimaxfrequency=4000000"
RTC_OVERLAY="dtoverlay=i2c-rtc,pcf8563"

# Prints the new contents of a config.txt. Any other overlay for this SPI device
# has to go: it would fight over spi0.0, and the old mcp251xfd line also took
# GPIO 25, which is the PoE read pin.
#
# The Pi 5's onboard clock has to go too. The kernel only reads and updates the
# clock named rtc0, and the onboard one takes that name if it is enabled, which
# would leave the HAT's clock unused. A Pi 4 has no onboard clock.
#
# usb_max_current_enable is for the same Pi 5: the HAT powers it through the GPIO
# header, where it can't negotiate over USB-C, so it assumes a 3 A supply and limits
# USB to 600 mA. The HAT's supply must really deliver 5 A. A Pi 4 has no such setting.
render_boot_config() {
    local config=$1
    sed -E \
        -e "s/^dtoverlay=mcp2515-can0(,.*)?$/$CAN_OVERLAY/" \
        -e "s/^dtoverlay=i2c-rtc(,.*)?$/$RTC_OVERLAY/" \
        -e 's/^dtoverlay=(mcp251xfd|mcp2515|mcp2515-can1|spi-bcm2835|spi-bcm2835-overlay)(,.*)?$/# Replaced by setup-socketcan.sh: &/' \
        "$config" || return 1
    local missing=()
    grep -qxF "dtparam=spi=on" "$config" || missing+=("dtparam=spi=on")
    grep -qE "^dtoverlay=mcp2515-can0(,.*)?$" "$config" || missing+=("$CAN_OVERLAY")
    grep -qxF "dtparam=i2c_arm=on" "$config" || missing+=("dtparam=i2c_arm=on")
    grep -qE "^dtoverlay=i2c-rtc(,.*)?$" "$config" || missing+=("$RTC_OVERLAY")
    if [[ ${#missing[@]} -gt 0 ]]; then
        # Lines after a conditional filter such as [cm5] only apply to that board.
        printf '\n[all]\n# Car HAT: see universal-telemetry-software/setup-socketcan.sh\n'
        printf '%s\n' "${missing[@]}"
    fi
    local pi5_missing=()
    grep -qxF "dtparam=rtc=off" "$config" || pi5_missing+=("dtparam=rtc=off")
    grep -qxF "usb_max_current_enable=1" "$config" || pi5_missing+=("usb_max_current_enable=1")
    if [[ ${#pi5_missing[@]} -gt 0 ]]; then
        printf '\n[pi5]\n'
        printf '%s\n' "${pi5_missing[@]}"
        printf '[all]\n'
    fi
}

# Returns success if the file changed, and exits on any error. A bad write here
# stops the Pi booting, so the new file replaces the old one in a single rename.
# Callers use this in an `if`, which turns off set -e inside it, so every step
# checks for itself.
update_boot_config() {
    local config=$1 updated
    updated=$(mktemp) || exit 1
    if [[ ! -s "$config" ]] || ! render_boot_config "$config" > "$updated"; then
        rm -f "$updated"
        echo -e "${RED}Could not read $config, so it was left unchanged${NC}" >&2
        exit 1
    fi
    if cmp -s "$config" "$updated"; then
        rm -f "$updated"
        return 1
    fi
    if ! cp -p "$config" "$config.bak-$(date +%Y%m%d-%H%M%S)" \
        || ! cp "$updated" "$config.new" \
        || ! sync \
        || ! mv "$config.new" "$config"; then
        rm -f "$updated" "$config.new"
        echo -e "${RED}Could not update $config${NC}" >&2
        exit 1
    fi
    rm -f "$updated"
    sync
}

if [[ "${1:-}" == "--update-config" ]]; then
    update_boot_config "$2" || true
    exit 0
fi

if [[ $EUID -ne 0 ]]; then
    echo -e "${RED}Run as root: sudo $0${NC}"
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo -e "${YELLOW}Setting up SocketCAN for the car's MCP2515 HAT...${NC}"

# ── 1. Install can-utils ───────────────────────────────────────────────────────
if ! command -v cansend &>/dev/null; then
    echo "Installing can-utils..."
    apt-get update -qq && apt-get install -y can-utils
fi
echo -e "${GREEN}✓ can-utils present${NC}"

# ── 2. Load kernel modules now + persist across reboots ───────────────────────
sed -i '/^mcp251xfd$/d' /etc/modules 2>/dev/null || true
for mod in can can_raw mcp251x; do
    modprobe "$mod"
    if ! grep -qx "$mod" /etc/modules 2>/dev/null; then
        echo "$mod" >> /etc/modules
    fi
done
echo -e "${GREEN}✓ CAN kernel modules loaded and persisted in /etc/modules${NC}"

# ── 3. Configure device tree overlay ──────────────────────────────────────────
CONFIG=/boot/firmware/config.txt
REBOOT_NEEDED=false
if update_boot_config "$CONFIG"; then
    REBOOT_NEEDED=true
    echo -e "${GREEN}✓ Updated $CONFIG (backup saved beside it)${NC}"
else
    echo -e "${GREEN}✓ $CONFIG already correct${NC}"
fi

# ── 4. Install the systemd service that brings up can0 at boot ────────────────
install -m 644 "$SCRIPT_DIR/deploy/can0.service" /etc/systemd/system/can0.service
systemctl daemon-reload
systemctl enable can0
echo -e "${GREEN}✓ can0.service installed and enabled${NC}"

# ── 5. Bring up can0 now if the HAT is already active ─────────────────────────
# An interface that is already up is left alone, so re-running this during a
# session can't interrupt recording. Its new settings apply at the next reboot.
echo ""
if ! ip link show can0 &>/dev/null; then
    REBOOT_NEEDED=true
    echo -e "${YELLOW}  can0 not available yet — the overlay takes effect after a reboot with the HAT fitted.${NC}"
elif ip link show can0 | grep -qE '[<,]UP[,>]'; then
    echo -e "${GREEN}✓ can0 is already up${NC}"
else
    systemctl restart can0
    echo -e "${GREEN}✓ can0 is up at 500 kbps${NC}"
fi

echo ""
echo -e "${GREEN}=========================================${NC}"
echo -e "${GREEN}  SocketCAN setup complete${NC}"
echo -e "${GREEN}=========================================${NC}"
if [[ "$REBOOT_NEEDED" == "true" ]]; then
    echo -e "  Reboot to apply:   sudo reboot"
fi
echo -e "  Verify CAN is up:  ip -d link show can0"
echo -e "  Expect:            state ERROR-ACTIVE, restart-ms 100, bitrate 500000"
echo -e "  Check the SPI link: see 'Check the SPI link' in deploy/CAN_RECORDER.md"
echo -e "  Check the clock:   journalctl -b -k | grep -iE 'pcf8563|setting system clock'"
echo -e "${GREEN}=========================================${NC}"

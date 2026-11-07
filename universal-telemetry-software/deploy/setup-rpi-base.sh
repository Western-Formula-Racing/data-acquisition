#!/usr/bin/env bash
# Sets up a Raspberry Pi as a base station that needs no laptop. See RPI_BASE_DEPLOY.md.
#
# Safe to re-run. It doesn't switch the Wi-Fi or Ethernet while it runs, so it can't
# cut off the session running it: those changes apply when the Pi next boots.
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UTS_DIR="$(dirname "${DEPLOY_DIR}")"
REPO_DIR="$(dirname "${UTS_DIR}")"
COMPOSE_FILE="${DEPLOY_DIR}/docker-compose.rpi-base.yml"
ENV_FILE="${DEPLOY_DIR}/.env"
BASE_ADDRESS="10.71.1.20/24"
CAR_ADDRESS="10.71.1.10"
RADIO_IF="eth0"
RADIO_CON_NAME="wfr-radio"
RADIO_PRIORITY=100
HOTSPOT_IF="${WFR_HOTSPOT_IF:-wlan0}"
IMAGE_PREFIX="ghcr.io/western-formula-racing/data-acquisition"

DBC_SOURCE=""
BUILD_IMAGES=false
REPLACE_CAR_TELEMETRY=false
HOTSPOT_BOOT_FLAG="--on-boot"
HOTSPOT_ARGS=()

usage() {
  cat <<EOF
Usage: sudo deploy/setup-rpi-base.sh [options]

  --dbc FILE                 The car's DBC. Without one, PECAN warns viewers that
                             signal names and values may be wrong.
  --build-images             Build the images here rather than pull them, for a
                             branch that hasn't reached main yet (takes a while)
  --manual-hotspot           Don't start the hotspot on boot
  --replace-car-telemetry    This Pi runs car-telemetry: disable it. They need the
                             same ports, so a Pi can't be both.
  --ssid, --psk, --band, --channel, --address
                             Passed to wfr-net setup
EOF
}

die() {
  echo "ERROR: $*" >&2
  exit 1
}

step() {
  echo ""
  echo "→ $*"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dbc) DBC_SOURCE="${2:?--dbc needs a file}"; shift 2 ;;
    --build-images) BUILD_IMAGES=true; shift ;;
    --manual-hotspot) HOTSPOT_BOOT_FLAG="--manual"; shift ;;
    --replace-car-telemetry) REPLACE_CAR_TELEMETRY=true; shift ;;
    --ssid|--psk|--band|--channel|--address)
      HOTSPOT_ARGS+=("$1" "${2:?$1 needs a value}"); shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "Unknown option: $1" ;;
  esac
done

[[ "$(id -u)" == "0" ]] || die "Run this with sudo."
[[ -z "${DBC_SOURCE}" || -s "${DBC_SOURCE}" ]] || die "DBC file not found or empty: ${DBC_SOURCE}"
command -v nmcli >/dev/null || die "This needs NetworkManager (nmcli)."

# Checked before anything changes, so a refusal leaves the Pi as it was.
if systemctl is-active --quiet car-telemetry && [[ "${REPLACE_CAR_TELEMETRY}" != true ]]; then
  die "car-telemetry is running here, and it needs the same ports as the base station.
Re-run with --replace-car-telemetry to disable it."
fi

step "Installing packages"
apt_packages=()
command -v nft >/dev/null || apt_packages+=(nftables)
command -v qrencode >/dev/null || apt_packages+=(qrencode)
if [[ ${#apt_packages[@]} -gt 0 ]]; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y "${apt_packages[@]}"
fi
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

step "Hotspot and firewall"
install -m 755 "${DEPLOY_DIR}/wfr-net" /usr/local/sbin/wfr-net
WFR_HOTSPOT_IF="${HOTSPOT_IF}" /usr/local/sbin/wfr-net setup "${HOTSPOT_BOOT_FLAG}" ${HOTSPOT_ARGS[@]+"${HOTSPOT_ARGS[@]}"}

mkdir -p /etc/wfr
sed "s/^define HOTSPOT_IF = .*/define HOTSPOT_IF = \"${HOTSPOT_IF}\"/" \
  "${DEPLOY_DIR}/wfr-hotspot-firewall.nft" > /etc/wfr/hotspot-firewall.nft
install -m 644 "${DEPLOY_DIR}/wfr-hotspot-firewall.service" /etc/systemd/system/wfr-hotspot-firewall.service
systemctl daemon-reload
systemctl enable wfr-hotspot-firewall >/dev/null
systemctl restart wfr-hotspot-firewall

step "Radio link: ${RADIO_IF} at ${BASE_ADDRESS}"
if ! nmcli -t -f NAME con show | grep -xF "${RADIO_CON_NAME}" >/dev/null; then
  # autoconnect no: it must not take over the Ethernet before it's fully configured.
  nmcli con add type ethernet ifname "${RADIO_IF}" con-name "${RADIO_CON_NAME}" autoconnect no >/dev/null
fi
nmcli con modify "${RADIO_CON_NAME}" \
  connection.autoconnect yes \
  connection.autoconnect-priority "${RADIO_PRIORITY}" \
  ipv4.method manual \
  ipv4.addresses "${BASE_ADDRESS}" \
  ipv4.gateway "" \
  ipv4.never-default yes \
  ipv6.method disabled

step "DBC"
mkdir -p "${DEPLOY_DIR}/dbc"
if [[ -n "${DBC_SOURCE}" ]]; then
  install -m 644 "${DBC_SOURCE}" "${DEPLOY_DIR}/dbc/active.dbc"
  echo "Installed ${DBC_SOURCE}"
elif [[ -s "${DEPLOY_DIR}/dbc/active.dbc" ]]; then
  echo "Keeping the existing deploy/dbc/active.dbc"
else
  echo "WARNING: No DBC. Re-run with --dbc FILE, or viewers will see a warning."
fi

step "Base station stack"
if [[ "${BUILD_IMAGES}" == true ]]; then
  docker build --build-arg "GIT_HASH=$(git -C "${REPO_DIR}" rev-parse --short HEAD 2>/dev/null || echo unknown)" \
    -t "${IMAGE_PREFIX}/universal-telemetry:latest" "${UTS_DIR}"
  docker build -t "${IMAGE_PREFIX}/pecan:latest" "${REPO_DIR}/pecan"
else
  docker compose -f "${COMPOSE_FILE}" pull telemetry pecan redis || die "Could not pull the images. They're private, so log in to ghcr.io first, or use --build-images."
fi

# A Pi that used to be the car keeps REMOTE_IP=<its base> in deploy/.env, which compose
# reads automatically and which would point this base at itself.
touch "${ENV_FILE}"
sed -i '/^REMOTE_IP=/d' "${ENV_FILE}"
echo "REMOTE_IP=${CAR_ADDRESS}" >> "${ENV_FILE}"

# Last, so a failed install or build leaves the running telemetry alone.
if systemctl is-active --quiet car-telemetry || systemctl is-enabled --quiet car-telemetry; then
  step "Replacing car-telemetry"
  systemctl disable --now car-telemetry
fi
docker compose -f "${COMPOSE_FILE}" up -d

cat <<EOF

═══════════════════════════════════════
 Base station installed
═══════════════════════════════════════

The Wi-Fi and Ethernet changes apply at the next boot. That disconnects anything
using them now, including Remote Desktop and Tailscale if wlan0 is the Pi's only
internet connection.

  Reboot:          sudo reboot
  Status/password: sudo wfr-net status
  Printable card:  sudo wfr-net card
  Back on Wi-Fi:   sudo wfr-net client

EOF

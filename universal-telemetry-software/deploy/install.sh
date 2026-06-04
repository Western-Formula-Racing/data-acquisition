#!/usr/bin/env bash
# WFR Base Station — one-line installer (macOS + Linux)
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Western-Formula-Racing/data-acquisition/main/universal-telemetry-software/deploy/install.sh | bash
#   curl -fsSL .../install.sh | bash -s -- --hotspot   # Linux: also enable Wi-Fi AP for pit devices

set -e

REPO="Western-Formula-Racing/data-acquisition"
BRANCH="main"
INSTALL_DIR="${HOME}/wfr-base-station"
HOTSPOT_SSID="WFR-Base"
HOTSPOT_PSK="wfr-racing"
HOTSPOT_CON_NAME="wfr-hotspot"
HOTSPOT_WLAN_IF="${WFR_HOTSPOT_IF:-wlan0}"

ENABLE_HOTSPOT=false
for arg in "$@"; do
  case "${arg}" in
    --hotspot) ENABLE_HOTSPOT=true ;;
    -h|--help)
      echo "Usage: install.sh [--hotspot]"
      echo "  --hotspot  Linux only: prompt before creating a Wi-Fi AP for pit devices"
      exit 0
      ;;
  esac
done

OS="$(uname)"
IS_LINUX=false
IS_MACOS=false
DOCKER=(docker)

if [[ "${OS}" == "Linux" ]]; then
  IS_LINUX=true
  DOCKER=(sudo docker)
elif [[ "${OS}" == "Darwin" ]]; then
  IS_MACOS=true
else
  echo "ERROR: Unsupported OS: ${OS}"
  echo "This installer supports macOS and Linux only."
  exit 1
fi

cat << 'ART'
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣀⣀⣀⣀⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⢠⣤⢀⣤⠀⣤⠄⣤⣤⣤⣤⣤⡄⣠⣤⣤⣤⣤⡄⢠⣤⣤⣤⣤⡤⢠⣤⣤⣤⣤⣤⢀⣤⣤⣤⣤⣤⠀⣤⡄⠀⢀⣤⠀⠀⠀⠀⠀⣇⠀⠀⠀⣇⣀⣀⣀⣀⣀⣀⣀⣀⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⢀⣿⠃⣾⠇⣼⡟⣰⣿⣤⣤⣤⡄⢰⣿⣥⣤⣤⡤⠀⠀⢠⣿⠃⠀⢀⣿⣧⣤⣤⣤⠀⣾⠧⣤⣤⣾⠏⣼⡟⣿⡄⣼⠏⠀⠀⠀⠀⠀⢧⣤⣤⣤⡇⠀⠀⠀⠀⠀⠀⠀⠀⢿⠲⢤⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⣾⣧⣼⣯⣴⡟⢠⣿⣥⣤⣤⡤⢠⣤⣤⣤⣤⣿⠃⠀⢀⣾⠇⠀⠀⣾⣧⣤⣤⣤⠄⣼⡏⠀⠘⢿⡆⣰⡟⠀⠘⣿⡟⠀⠀⠀⠀⠀⠀⠀⠀⡔⠋⠲⣀⣀⣀⣀⣠⠊⠑⣆⡿⠊⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠳⠤⠜⠁⠀⠀⠀⠘⠦⠴⠃⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⢀⣶⣶⣶⣶⣶⢠⣶⣶⣶⣶⡖⣰⣶⣶⣶⣶⡆⣴⣶⣶⣶⣶⡆⣴⡆⠀⠀⣴⠆⣴⠆⠀⠀⠀⢀⣶⣶⣶⣶⣶⠀⠀⠀⢠⣶⣶⣶⣶⡶⢰⣶⣶⣶⣶⡆⣴⣶⣶⣶⡶⢠⡶⢠⣶⡀⠀⣰⡆⣴⣶⣶⣶⣶⠆⠀⠀
⠀⠀⠀⣼⠿⠶⠶⠶⢂⣾⠃⠀⢠⡿⢡⡿⠱⣶⡶⠟⣰⡟⣰⡟⣰⡟⣰⡟⠀⠀⣼⡏⣼⡏⠀⠀⠀⠀⣼⠷⠶⢶⣾⠃⠀⠀⢀⣾⠓⢶⣶⠿⢡⡿⠷⠶⢶⡿⣰⡟⠀⠀⠀⢀⣿⢃⣿⠙⣷⣴⡟⣰⡟⠠⠶⣶⡆⠀⠀⠀
⠀⠀⠸⠟⠀⠀⠀⠀⠾⠿⠾⠷⠿⠃⠿⠃⠀⠈⠿⠠⠿⠡⠿⠡⠿⠡⠿⠿⠾⠾⠟⠰⠿⠷⠿⠾⠇⠼⠏⠀⠀⠾⠇⠀⠀⠀⠼⠇⠀⠈⠻⣦⡸⠃⠀⠠⠿⠡⠿⠷⠿⠾⠇⠾⠇⠾⠃⠀⠘⠿⠡⠿⠷⠿⠾⠟⠀⠀⠀⠀
⠀⠀⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠿⠷⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠆⠀⠀
⠀⠀⠀⠀⡴⠶⣶⢠⣶⣶⡶⠰⢶⡶⠖⣴⣶⣶⠆⠀⢀⣶⣶⣶⢢⡶⠶⠶⣰⠶⣶⢢⡆⠀⣴⢰⢆⣶⣶⡶⣰⠦⢶⡶⠶⣰⢢⡶⠶⣶⢰⣆⢀⡖⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠼⠧⠴⠋⠞⠉⠹⠃⠀⠟⠀⠸⠋⠩⠏⠀⠀⠼⠉⠹⠇⠿⠤⠤⠰⠧⢷⠇⠾⠤⠼⠣⠏⠬⠭⠽⠣⠏⠀⠼⠁⠠⠏⠾⠤⠼⠣⠏⠘⠿⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⡰⠀⡀⠀⠀⠀⠀⠀⡀⢢⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢰⠁⡜⢠⠆⢀⣀⠀⢆⢹⡀⢧⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠸⡀⢣⠘⠄⠈⡞⠀⠎⣸⠁⡞⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠱⠀⠁⠀⠀⣇⠀⠀⠁⠜⠁⠀⠀⡄⠀⣀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⣀⣀⠀⠀⠀⢀⠴⠦⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢸⠉⢹⠀⠀⠀⠀⠀⠀⡗⠀⢸⠀⠀⠀⢆⠀⢤⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠰⡁⠀⡇⠀⠀⢸⠒⠒⡗⠂⠀⠀⡖⠓⣆⠀⠀⠀⢠⠚⢲⡀⠀⠸⡤⡼⠀⠀⠀⠀⠀⠘⠁⠀⠎⠀⠀⢀⡞⠀⢸⠀⠀⠈⡇⠀⢦⠀⠀⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⣠⠛⠛⢅⠀⠀⢨⠗⢾⠁⠀⠀⢀⡣⢤⡃⠀⠀⠀⣘⠦⡜⠀⡀⠀⡇⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠀⠀⠃⠀⠀⠠⠃⠀⡜⠀⠀⣹⠀⢳⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⢀⢇⠄⠀⠘⡄⠀⡏⡔⠈⡇⠀⠀⡏⢄⣀⡈⣆⠀⢰⠃⠀⢈⠶⡻⠀⡇⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠀⠀⠐⠃⠠⠎⠀⠀⠀⠀⢀⣀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠘⡜⠄⠀⢠⠃⠀⢇⢇⠀⡇⠀⠀⠱⡔⠒⢲⠊⠀⠸⡀⠀⢸⠉⠀⠀⡇⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣇⣸⣀⠀⠀⠀⠀⠀⠀⣄⣀⣀⣀⣀⣀⣀⡄⠀⠀⠀
⠀⠀⠀⢸⠀⡄⢸⠀⠀⢸⠚⠀⡎⠉⡆⠀⠀⠀⢸⠀⠀⠀⡏⢀⢸⠀⠀⠸⣏⣹⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⠤⢤⠀⡇⠀⣇⠙⠢⣄⠀⠀⠀⠧⡤⠤⠤⢤⠤⠤⡇⠀⠀⠀
⠀⠀⠀⢸⠀⡇⢸⠀⠀⡼⢠⠖⠻⡚⠁⠀⡖⠒⠒⡖⠀⠀⡇⢸⢸⠀⠀⡴⢹⠘⣆⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣀⡠⠤⠴⠒⠒⠒⠒⠻⢤⣼⣤⣴⣁⣇⣀⡼⠤⠤⢤⣙⣢⣄⣀⣇⣀⠀⢸⠀⠀⡇⠀⠀⠀
⠀⠀⠀⢸⠀⡇⣺⠀⠀⡇⡎⠘⣌⠧⢤⣸⠁⠀⢰⠁⠀⠀⡇⣸⢸⠀⡰⠁⣸⡄⠘⡆⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣀⡤⠖⠋⠁⡰⠊⠉⠑⢦⣠⣄⣤⡤⠴⠒⠚⠉⠁⠀⠀⠀⠀⠀⣀⠀⡔⠉⣀⡈⠑⡞⠒⠒⡇⠀⠀⠀
⠀⠀⠀⢸⠀⡇⡏⠀⠀⡇⢇⠀⠛⠻⣍⢹⠍⢹⠁⠀⠀⠀⡇⡏⢸⡰⢁⡜⢹⠈⢦⠘⡄⠀⠀⠀⠀⠀⠀⠀⣐⣮⣁⡤⢤⠀⠰⡃⢸⣉⡗⢈⡇⡇⠀⡇⠀⠀⠀⠀⠀⣀⡠⠔⠚⠉⢸⠸⡄⠸⣀⡸⠀⡸⠉⠉⠁⠀⠀⠀
⠀⠀⠀⠈⠉⠉⠉⠁⠈⠁⠁⠉⠉⠉⠈⠉⠁⠈⠉⠀⠀⠈⠉⠉⠙⠁⠋⠀⠘⠀⠀⠃⠘⠀⠀⠀⠀⠀⠀⠛⠓⠒⠒⠒⠚⠉⠉⠱⢤⣀⡤⠞⠉⠓⠒⠓⠒⠒⠒⠒⠛⠓⠒⠒⠒⠒⠚⠒⠓⠤⣀⡠⠔⠁⠀⠀⠀⠀⠀⠀
⠀⠀⠉⠉⠀⠉⠉⠀⠉⠉⠀⠈⠉⠁⠈⠉⠁⠀⠉⠉⠀⠈⠉⠁⠈⠉⠁⠀⠉⠉⠀⠈⠉⠁⠈⠉⠉⠀⠉⠉⠀⠉⠉⠁⠈⠉⠁⠈⠉⠁⠀⠉⠉⠀⠉⠉⠀⠈⠉⠁⠈⠉⠁⠀⠉⠉⠀⠉⠉⠀⠉⠉⠁⠈⠉⠁⠈⠉⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
ART

install_linux_deps() {
  if ! command -v apt-get &>/dev/null; then
    echo "ERROR: This Linux installer requires apt-get (Debian/Ubuntu or Raspberry Pi OS)."
    exit 1
  fi

  echo ""
  echo "→ Checking Linux dependencies..."

  if ! command -v git &>/dev/null; then
    echo "  Installing git..."
    sudo apt-get update -qq
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y git
  fi
  echo "✓ git available"

  if ! command -v docker &>/dev/null; then
    echo "  Installing Docker Engine (this may take a few minutes)..."
    curl -fsSL https://get.docker.com | sudo sh
  fi

  if ! docker compose version &>/dev/null && ! sudo docker compose version &>/dev/null; then
    echo "ERROR: Docker Compose plugin is not available after Docker install."
    exit 1
  fi
  echo "✓ Docker Engine available"

  if ! groups "${USER}" | grep -q '\bdocker\b'; then
    echo "  Adding ${USER} to the docker group (effective after re-login)..."
    sudo usermod -aG docker "${USER}" || true
  fi

  if command -v systemctl &>/dev/null; then
    sudo systemctl enable docker >/dev/null 2>&1 || true
    sudo systemctl start docker >/dev/null 2>&1 || true
  fi

  if ! sudo docker info &>/dev/null; then
    echo ""
    echo "ERROR: Docker daemon is not running."
    echo "Try: sudo systemctl start docker"
    exit 1
  fi
  echo "✓ Docker daemon running"
}

setup_macos_docker() {
  if ! command -v docker &>/dev/null; then
    echo ""
    echo "ERROR: Docker is not installed."
    echo "Download Docker Desktop for macOS:"
    echo "  https://docs.docker.com/desktop/install/mac-install/"
    echo ""
    echo "After installing Docker Desktop, re-run this script."
    exit 1
  fi

  if ! docker info &>/dev/null; then
    echo ""
    echo "ERROR: Docker Desktop is not running."
    echo "Start Docker Desktop from Applications, then re-run this script."
    exit 1
  fi
  echo "✓ Docker Desktop running"
}

ensure_repo() {
  if [[ -d "${INSTALL_DIR}/.git" ]]; then
    echo ""
    echo "→ Updating existing installation..."
    git -C "${INSTALL_DIR}" fetch origin "${BRANCH}"
    git -C "${INSTALL_DIR}" checkout "${BRANCH}"
    git -C "${INSTALL_DIR}" pull origin "${BRANCH}"
  else
    echo ""
    echo "→ Cloning repository..."
    git clone --branch "${BRANCH}" --depth 1 "https://github.com/${REPO}.git" "${INSTALL_DIR}"
  fi
  echo "✓ Repository ready at ${INSTALL_DIR}"
}

start_stack() {
  DEPLOY_DIR="${INSTALL_DIR}/universal-telemetry-software/deploy"
  COMPOSE_FILE="${DEPLOY_DIR}/docker-compose.macbook-base.yml"
  ENV_FILE="${DEPLOY_DIR}/.env.macbook"

  echo ""
  echo "→ Pulling latest images (first run may take a few minutes)..."
  "${DOCKER[@]}" compose \
    --project-directory "${INSTALL_DIR}" \
    -f "${COMPOSE_FILE}" \
    pull 2>&1 | grep -v "^$\|Pulling\|^[[:space:]]" || true

  echo ""
  echo "→ Starting base station stack..."
  "${DOCKER[@]}" compose \
    --project-directory "${INSTALL_DIR}" \
    -f "${COMPOSE_FILE}" \
    --env-file "${ENV_FILE}" \
    up -d
}

print_macos_network_hint() {
  echo ""
  echo "═══════════════════════════════════════"
  echo " One-time network setup required"
  echo "═══════════════════════════════════════"
  echo ""
  echo "Your MacBook needs IP 10.71.1.20 on the USB-C ethernet adapter"
  echo "connected to the car radio base."
  echo ""
  echo "Via GUI (recommended for non-technical users):"
  echo "  System Settings → Network → USB-C Ethernet → Configure IPv4 →"
  echo "  Select 'Manually' → IP: 10.71.1.20 / Subnet: 255.255.255.0 → Apply"
  echo ""
  echo "Via CLI:"
  echo "  1. Find the interface: networksetup -listallhardwareports"
  echo "  2. Set the IP:"
  echo "     sudo networksetup -setmanual '<interface>' 10.71.1.20 255.255.255.0"
  echo ""
  echo "Verify connectivity with the car:"
  echo "  ping -c 3 10.71.1.10"
  echo ""
  echo "Do this before the first track session — the stack will still"
  echo "run but won't receive telemetry until the IP is correct."
  echo ""
}

print_linux_network_hint() {
  echo ""
  echo "═══════════════════════════════════════"
  echo " One-time network setup required"
  echo "═══════════════════════════════════════"
  echo ""
  echo "Set IP 10.71.1.20 on the ethernet interface connected to the car radio."
  echo ""
  echo "Find interfaces:"
  echo "  ip -br link"
  echo ""
  echo "Option A — NetworkManager (Raspberry Pi OS / Ubuntu):"
  echo "  sudo nmcli con mod '<connection-name>' ipv4.method manual \\"
  echo "    ipv4.addresses 10.71.1.20/24 ipv4.gateway ''"
  echo "  sudo nmcli con up '<connection-name>'"
  echo ""
  echo "Option B — temporary (resets on reboot):"
  echo "  sudo ip addr add 10.71.1.20/24 dev eth0"
  echo ""
  echo "Verify connectivity with the car:"
  echo "  ping -c 3 10.71.1.10"
  echo ""
  echo "Pecan renders in the browser on pit devices — open http://<base-ip>:3000"
  echo "from a laptop or tablet, not on the Pi itself."
  echo ""
}

has_non_wifi_connectivity() {
  local iface
  while IFS= read -r iface; do
    [[ "${iface}" == "${HOTSPOT_WLAN_IF}" ]] && continue
    [[ "${iface}" == "lo" ]] && continue
    if ip -4 addr show dev "${iface}" 2>/dev/null | grep -q 'inet '; then
      return 0
    fi
  done < <(ip -br link | awk '{print $1}')
  return 1
}

confirm_hotspot() {
  if [[ "${IS_LINUX}" != true ]]; then
    return 1
  fi

  echo ""
  echo "═══════════════════════════════════════"
  echo " Wi-Fi hotspot confirmation"
  echo "═══════════════════════════════════════"
  echo ""
  echo "Enabling --hotspot switches ${HOTSPOT_WLAN_IF} from Wi-Fi client mode to"
  echo "access-point mode (SSID: ${HOTSPOT_SSID})."
  echo ""
  echo "  • SSH sessions over Wi-Fi will disconnect when the hotspot starts"
  echo "  • The Pi loses Wi-Fi internet unless another adapter provides it"
  echo "  • Car telemetry still requires ethernet at 10.71.1.20 — the hotspot"
  echo "    is for pit laptops/tablets only"
  echo ""

  if ! has_non_wifi_connectivity; then
    echo "  ⚠️  No other network adapter has an IP address on this Pi."
    echo "     After hotspot enable, this Pi will have no internet access."
    echo ""
  fi

  if [[ ! -t 0 ]]; then
    echo "Not an interactive terminal — skipping hotspot."
    echo "Run this on the Pi locally (or over SSH before confirming) to enable it."
    return 1
  fi

  read -r -p "Enable Wi-Fi hotspot now? [y/N] " reply
  case "${reply}" in
    [yY]|[yY][eE][sS])
      return 0
      ;;
    *)
      echo "Skipping hotspot. The base station stack is still running."
      echo "Re-run with --hotspot when you are ready."
      return 1
      ;;
  esac
}

setup_hotspot() {
  if [[ "${IS_LINUX}" != true ]]; then
    echo ""
    echo "Note: --hotspot is Linux-only. On macOS, use System Settings → Sharing → Internet Sharing."
    return 0
  fi

  echo ""
  echo "→ Setting up Wi-Fi hotspot for pit devices..."

  if ! command -v nmcli &>/dev/null; then
    echo "  Installing NetworkManager..."
    sudo apt-get update -qq
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y network-manager
  fi

  if ! ip link show "${HOTSPOT_WLAN_IF}" &>/dev/null; then
    echo "ERROR: Wi-Fi interface '${HOTSPOT_WLAN_IF}' not found."
    echo "Set WFR_HOTSPOT_IF to your wireless interface and re-run with --hotspot."
    exit 1
  fi

  if ! nmcli -t -f NAME con show | grep -qx "${HOTSPOT_CON_NAME}"; then
    sudo nmcli con add type wifi ifname "${HOTSPOT_WLAN_IF}" con-name "${HOTSPOT_CON_NAME}" \
      autoconnect yes ssid "${HOTSPOT_SSID}" \
      802-11-wireless.mode ap \
      wifi-sec.key-mgmt wpa-psk wifi-sec.psk "${HOTSPOT_PSK}" \
      ipv4.method shared
  fi

  sudo nmcli con up "${HOTSPOT_CON_NAME}" || {
    echo "ERROR: Failed to bring up hotspot '${HOTSPOT_CON_NAME}'."
    exit 1
  }

  sudo tee /etc/systemd/system/wfr-hotspot.service >/dev/null <<EOF
[Unit]
Description=WFR Base Station Wi-Fi Hotspot
After=NetworkManager.service
Wants=NetworkManager.service

[Service]
Type=oneshot
ExecStart=/usr/bin/nmcli con up ${HOTSPOT_CON_NAME}
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF

  sudo systemctl daemon-reload
  sudo systemctl enable wfr-hotspot >/dev/null 2>&1 || true
  sudo systemctl start wfr-hotspot >/dev/null 2>&1 || true

  echo ""
  echo "═══════════════════════════════════════"
  echo " Wi-Fi Hotspot active"
  echo "═══════════════════════════════════════"
  echo ""
  echo "  SSID:     ${HOTSPOT_SSID}"
  echo "  Password: ${HOTSPOT_PSK}"
  echo "  Pecan:    http://10.42.0.1:3000  (open on any connected device)"
  echo ""
  echo "  Ethernet car link is unaffected — still configure 10.71.1.20 on eth."
  echo ""
}

print_success() {
  DEPLOY_DIR="${INSTALL_DIR}/universal-telemetry-software/deploy"
  COMPOSE_FILE="${DEPLOY_DIR}/docker-compose.macbook-base.yml"
  ENV_FILE="${DEPLOY_DIR}/.env.macbook"
  DOCKER_HINT="docker"
  if [[ "${IS_LINUX}" == true ]]; then
    DOCKER_HINT="sudo docker"
  fi

  echo "═══════════════════════════════════════"
  echo " Base station is running!"
  echo "═══════════════════════════════════════"
  echo ""
  echo "  Pecan dashboard:  http://localhost:3000"
  echo "  Status page:      http://localhost:8080"
  echo "  Health check:     http://localhost:8080/health"
  echo ""
  echo "  To stop:   ${DOCKER_HINT} compose -f ${COMPOSE_FILE} --env-file ${ENV_FILE} down"
  echo "  To update: re-run this installer"
  echo ""
}

echo ""
echo "═══════════════════════════════════════"
if [[ "${IS_MACOS}" == true ]]; then
  echo " WFR Base Station — macOS Setup"
elif [[ "${IS_LINUX}" == true ]]; then
  echo " WFR Base Station — Linux Setup"
fi
echo "═══════════════════════════════════════"

if [[ "${IS_MACOS}" == true ]]; then
  echo "✓ macOS detected"
  setup_macos_docker
elif [[ "${IS_LINUX}" == true ]]; then
  echo "✓ Linux detected"
  install_linux_deps
fi

ensure_repo
start_stack

if [[ "${IS_MACOS}" == true ]]; then
  print_macos_network_hint
elif [[ "${IS_LINUX}" == true ]]; then
  print_linux_network_hint
fi

if [[ "${ENABLE_HOTSPOT}" == true ]]; then
  if confirm_hotspot; then
    setup_hotspot
  fi
fi

print_success

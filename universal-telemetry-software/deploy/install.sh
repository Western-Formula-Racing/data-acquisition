#!/usr/bin/env bash
# WFR Base Station — One-line macOS installer
# Usage: curl -fsSL https://raw.githubusercontent.com/Western-Formula-Racing/data-acquisition/main/universal-telemetry-software/deploy/install.sh | bash

set -e

REPO="Western-Formula-Racing/data-acquisition"
BRANCH="main"
INSTALL_DIR="${HOME}/wfr-base-station"

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

echo ""
echo "═══════════════════════════════════════"
echo " WFR Base Station — macOS Setup"
echo "═══════════════════════════════════════"

# ── 1. Check macOS ──────────────────────────────────────
if [[ "$(uname)" != "Darwin" ]]; then
  echo "ERROR: This script requires macOS."
  echo "For other platforms, see:"
  echo "  https://github.com/${REPO}/blob/${BRANCH}/universal-telemetry-software/deploy/MACBOOK_DEPLOY.md"
  exit 1
fi
echo "✓ macOS detected"

# ── 2. Check Docker Desktop ─────────────────────────────
if ! command -v docker &>/dev/null; then
  echo ""
  echo "ERROR: Docker is not installed."
  echo "Download Docker Desktop for macOS:"
  echo "  https://docs.docker.com/desktop/install/mac-install/"
  echo ""
  echo "After installing Docker Desktop, re-run this script."
  exit 1
fi

# Docker daemon running?
if ! docker info &>/dev/null; then
  echo ""
  echo "ERROR: Docker Desktop is not running."
  echo "Start Docker Desktop from Applications, then re-run this script."
  exit 1
fi
echo "✓ Docker Desktop running"

# ── 3. Clone / update repo ──────────────────────────────
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

DEPLOY_DIR="${INSTALL_DIR}/universal-telemetry-software/deploy"
COMPOSE_FILE="${DEPLOY_DIR}/docker-compose.macbook-base.yml"
ENV_FILE="${DEPLOY_DIR}/.env.macbook"

# ── 4. Pull pre-built images ────────────────────────────
echo ""
echo "→ Pulling latest images (first run may take a few minutes)..."
docker compose \
  --project-directory "${INSTALL_DIR}" \
  -f "${COMPOSE_FILE}" \
  pull 2>&1 | grep -v "^$\|Pulling\|^[[:space:]]" || true

# ── 5. Start the stack ──────────────────────────────────
echo ""
echo "→ Starting base station stack..."
docker compose \
  --project-directory "${INSTALL_DIR}" \
  -f "${COMPOSE_FILE}" \
  --env-file "${ENV_FILE}" \
  up -d

echo ""
echo "═══════════════════════════════════════"
echo " ⚠️  One-time network setup required"
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
echo "⚠️  Do this before the first track session — the stack will still"
echo "    run but won't receive telemetry until the IP is correct."
echo ""

echo "═══════════════════════════════════════"
echo " Base station is running!"
echo "═══════════════════════════════════════"
echo ""
echo "  Pecan dashboard:  http://localhost:3000"
echo "  Status page:      http://localhost:8080"
echo "  Health check:     http://localhost:8080/health"
echo ""
echo "  To stop:   docker compose -f ${COMPOSE_FILE} --env-file ${ENV_FILE} down"
echo "  To update: re-run this installer"
echo ""

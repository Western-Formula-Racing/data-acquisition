#!/bin/bash
# lan_sender.sh — Run lan_sender without activating the venv.
# Pass host and port as arguments.
#   ./lan_sender.sh 10.71.1.10 5005

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON="${PYTHON:-python3}"

exec "$PYTHON" "$SCRIPT_DIR/src/lan_sender.py" "$@"

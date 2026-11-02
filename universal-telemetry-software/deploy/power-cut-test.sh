#!/usr/bin/env bash
# power-cut-test.sh - Runs the CAN recorder pull-the-plug test on every boot.
#
# Records generated traffic from a virtual CAN interface into ~/power-cut-test and
# reports each durable commit to a laptop. Because it starts by itself, you can
# pull and restore power repeatedly without logging in between pulls. It does not
# touch can0, the real recorder or /var/lib/can-recorder.
#
#   sudo deploy/power-cut-test.sh start <laptop-ip>
#   sudo deploy/power-cut-test.sh stop     # always run this when finished
#
# See "Power-cut test" in deploy/CAN_RECORDER.md for the full procedure.
set -euo pipefail

UNIT=can-recorder-power-cut-test.service
UNIT_FILE=/etc/systemd/system/$UNIT
ACK_PORT=5999

usage() {
    echo "Usage: sudo $0 start <laptop-ip> | stop" >&2
    exit 2
}

[[ $# -ge 1 ]] || usage
if [[ $EUID -ne 0 ]]; then
    echo "Run as root: sudo $0 $*" >&2
    exit 1
fi

UTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_USER="$(stat -c %U "$UTS_DIR")"
TEST_DIR="$(getent passwd "$TEST_USER" | cut -d: -f6)/power-cut-test"

case "$1" in
    start)
        [[ $# -eq 2 && $2 =~ ^[0-9]+(\.[0-9]+){3}$ ]] || usage
        LAPTOP_IP=$2
        cat > "$UNIT_FILE" <<EOF
# Temporary. Remove with: sudo deploy/power-cut-test.sh stop
[Unit]
Description=CAN recorder power-cut test (temporary)
After=local-fs.target

[Service]
User=$TEST_USER
WorkingDirectory=$UTS_DIR
ExecStartPre=+/sbin/modprobe vcan
ExecStartPre=+/bin/sh -c '/sbin/ip link show vcan0 >/dev/null 2>&1 || /sbin/ip link add vcan0 type vcan; /sbin/ip link set up vcan0'
# Short segments so that more pulls land near the creation of a new file.
ExecStart=/bin/sh -c 'cangen vcan0 -g 1 -I 200 -L 8 & exec /usr/bin/python3 -m src.can_recorder --iface vcan0 --dir $TEST_DIR --segment-seconds 10 --ack-udp $LAPTOP_IP:$ACK_PORT'
Restart=always
RestartSec=1

[Install]
WantedBy=multi-user.target
EOF
        systemctl daemon-reload
        systemctl enable --now "$UNIT"
        echo "Recording test traffic to $TEST_DIR and reporting commits to $LAPTOP_IP:$ACK_PORT."
        echo "Lines like 'run=1 frames=900 recorder=...' should now appear in the laptop window."
        echo "It restarts by itself on every boot until you run: sudo $0 stop"
        ;;
    stop)
        [[ $# -eq 1 ]] || usage
        systemctl disable --now "$UNIT" 2>/dev/null || true
        rm -f "$UNIT_FILE"
        systemctl daemon-reload
        ip link del vcan0 2>/dev/null || true
        echo "Test stopped and removed. The recording is still in $TEST_DIR."
        ;;
    *)
        usage
        ;;
esac

#!/usr/bin/env bash
# can-loopback-test.sh
#
# Sends a rotating set of DBC-valid CAN frames on can1 → received by can0.
# Use this to populate the Pecan dashboard (:3000) and status page (:8080)
# without a real ECU. Requires can0 and can1 to be wired together on the
# Waveshare 2-CH CAN HAT.
#
# Usage: ./can-loopback-test.sh [interval_ms]
#   interval_ms  Sleep between frames in milliseconds (default: 100)

set -e

INTERVAL_MS=${1:-100}
BITRATE=500000

# ── Bring up interfaces if needed ────────────────────────────────────────────
for iface in can0 can1; do
    state=$(ip -details link show "$iface" 2>/dev/null | grep -o 'state [A-Z_]*' | awk '{print $2}')
    if [ -z "$state" ]; then
        echo "ERROR: $iface not found. Is the CAN HAT configured in /boot/firmware/config.txt?"
        exit 1
    fi
    if [ "$state" = "DOWN" ]; then
        echo "Bringing up $iface at ${BITRATE}bps..."
        sudo ip link set "$iface" up type can bitrate $BITRATE
    fi
    echo "$iface: $(ip -details link show $iface | grep -o 'state [A-Z_]*')"
done

echo ""
echo "Sending frames on can1 → can0 every ${INTERVAL_MS}ms. Ctrl-C to stop."
echo "Monitor: Pecan dashboard :3000  |  Status page :8080"
echo ""

# ── Frame list ────────────────────────────────────────────────────────────────
# Format: <CAN_ID>#<8-byte-hex>  [# comment]
# All IDs are in the example.dbc. Values are mid-range / realistic.
FRAMES=(
    "0A0#A000A000A000A000"  # M160_Temperature_Set_1    (coolant ~45°C, motor ~60°C)
    "0A1#8C008C008C008C00"  # M161_Temperature_Set_2    (module temps ~38°C)
    "0A5#0000C4093E030500"  # M165_Motor_Position_Info  (speed 2500 rpm)
    "0A6#B0049C04BA045203"  # M166_Current_Info         (phase ~120A, DC ~85A)
    "0A7#D80E9808D007B603"  # M167_Voltage_Info         (DC bus 380V)
    "0AD#342100000000DC05"  # M173_Modulation_And_Flux  (Iq 150A, mod index 0.85)
    "0AA#0880800080800000"  # M170_Internal_States
    "0A8#00000000FFFFFFFF"  # M168_Flux_ID_IQ_Info
)

# ── Loop ─────────────────────────────────────────────────────────────────────
SLEEP=$(echo "scale=3; $INTERVAL_MS / 1000" | bc)
i=0
while true; do
    frame="${FRAMES[$((i % ${#FRAMES[@]}))]}"
    cansend can1 "$frame"
    printf "\r  sent: %s  [%d]" "$frame" "$i"
    sleep "$SLEEP"
    i=$((i + 1))
done

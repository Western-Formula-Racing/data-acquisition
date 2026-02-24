# LED Behavior Reference

## Physical Layout

| Jack | Color | GPIO | Function |
|------|-------|------|----------|
| — | Blue | 3 | CAN activity |
| DATA LAN | Yellow | 6 | CAN telemetry process |
| DATA LAN | Green | 10 | WebSocket bridge |
| RADIO LAN | Yellow | 7 | Audio streaming |
| RADIO LAN | Green | 9 | Video streaming |

## Normal Operation

### CAN Activity (Blue, GPIO 3)

| Role | Condition | LED |
|------|-----------|-----|
| Base Station | Always | Off |
| Car | CAN data flowing | Solid on |
| Car | No CAN data for >1 s | Double-flash (2x 80 ms on, 120 ms gap, 1 s pause) |

### DATA LAN Jack

| Color | Service | Condition | LED |
|-------|---------|-----------|-----|
| Yellow | CAN telemetry | Process heartbeat within 3 s | Solid on |
| Yellow | CAN telemetry | No heartbeat | Off |
| Green | WebSocket bridge | Process heartbeat within 3 s | Solid on |
| Green | WebSocket bridge | No heartbeat | Off |

### RADIO LAN Jack

| Color | Service | Condition | LED |
|-------|---------|-----------|-----|
| Yellow | Audio streaming | Process heartbeat within 3 s | Solid on |
| Yellow | Audio streaming | No heartbeat | Off |
| Green | Video streaming | Process heartbeat within 3 s | Solid on |
| Green | Video streaming | No heartbeat | Off |

## PoE Error Override

When the PoE physical switch is off (GPIO 27 enable HIGH but GPIO 25 read LOW), **all 5 LEDs flash in unison** (0.5 s on / 0.5 s off), overriding all normal behavior. This indicates the user has enabled PoE in software but the physical switch on the board is off.

Normal LED behavior resumes immediately when the switch is turned on.

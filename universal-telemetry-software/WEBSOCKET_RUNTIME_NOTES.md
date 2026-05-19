# WebSocket Runtime Notes

The canonical WebSocket protocol specification lives at:

[`../WEBSOCKET_PROTOCOL.md`](../WEBSOCKET_PROTOCOL.md)

This file is intentionally limited to UTS runtime/deployment notes so the repository does not maintain two drifting copies of the same protocol contract.

## UTS Runtime Notes

UTS uses the same Python WebSocket bridge code in both deployment roles:

- Car: runs natively through `car-telemetry.service` with `ROLE=car`.
- Base station: runs through Docker Compose with `ROLE=base`.

The protocol is the same in both roles. The uplink path differs:

| Role | Uplink path | Redis required |
|------|-------------|----------------|
| Car | Browser -> WebSocket bridge -> `python-can` -> `can0` | No |
| Base station | Browser -> WebSocket bridge -> Redis `can_uplink` -> UDP `0xCAFE` relay -> car | Yes |

The optional downlink-only relay is implemented by [`src/ws_relay.py`](src/ws_relay.py). It rebroadcasts upstream telemetry frames to remote viewers and intentionally does not forward uplink messages.

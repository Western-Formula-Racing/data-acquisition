# UTS Quick Reference Card — DAQ Radio

> [!TIP]
> Print landscape on A5, laminate, punch hole. One card per RPi.

---

## TWO-MINUTE PREFLIGHT

| | **CAR RPi** | **BASE RPi** |
|---|---|---|
| **Role** | Reads CAN, streams UDP | Receives UDP, serves PECAN |
| **CAN HAT** | Must be installed + running | Not needed |
| **Network** | Connects to base IP | Connects to car IP |
| **PECAN** | TX websocket (port 9078) | RX dashboard (port 3000) |

---

## 1 · HARDWARE + OS

### [STOP] CAN HAT — Car RPi only

```bash
# Verify kernel modules loaded
lsmod | grep -E "can|mcp"

# Verify device tree overlay applied
ls /proc/device-tree/ | grep can
dmesg | grep -i mcp
```

> [!WARNING]
> If empty → CAN HAT not configured. See `README.md` §Hardware Setup.
>
> **Required steps:**
> 1. Add to `/etc/modules`: `can can_raw mcp251xfd`
> 2. Add to `/boot/firmware/config.txt`:
>    `dtoverlay=mcp251xfd,oscillator=20000000,interrupt=25`
> 3. `sudo reboot`

### [GO] CAN Interface Up

```bash
ip link show can0
```

| | **Pass** | **Fail** |
|---|---|---|
| Expected | `can0: <NOARP,UP,LOWER_UP>` | `can0: ERROR` or missing |
| Fix | — | `sudo systemctl start can0` |

### Network — Both RPis

```bash
ping <other-rpi-ip>
```

| | **Pass** | **Fail** |
|---|---|---|
| Expected | Reply from other RPi | 100% packet loss |
| Fix | — | Check Ethernet / radio link |

---

## 2 · REMOTE_IP CONFIG

```bash
# Check current setting
grep REMOTE_IP docker-compose.yml
```

| | **CAR RPi** | **BASE RPi** |
|---|---|---|
| **REMOTE_IP** | Base RPi IP (e.g. `192.168.1.100`) | Car RPi IP |
| **Example** | `192.168.1.20` | `192.168.1.10` |

> [!WARNING]
> Wrong `REMOTE_IP` = no data flows. Car sends to wrong IP, base listens on wrong IP.

### Edit

```bash
nano docker-compose.yml
# Find: - REMOTE_IP=192.168.1.100
# Change to correct IP
docker compose down && docker compose up -d
```

---

## 3 · START SERVICES

```bash
cd ~/daq-radio/universal-telemetry-software
docker compose up -d
```

### Verify All Containers Running

```bash
docker compose ps
```

| | **Pass** | **Fail** |
|---|---|---|
| Expected | `telemetry redis pecan` all running | Any `Exit` or missing |
| Fix | — | `docker compose logs telemetry` |

### Verify Redis Up

```bash
docker compose ps redis
# or
redis-cli ping
```

| | **Pass** | **Fail** |
|---|---|---|
| Expected | `PONG` | Connection refused |
| Fix | — | `docker compose restart redis` |

---

## 4 · ROLE AUTO-DETECTION

```bash
docker compose logs telemetry | grep "Auto-detected Role"
```

| | **CAR RPi** | **BASE RPi** |
|---|---|---|
| **Expected log** | `Auto-detected Role: car` | `Auto-detected Role: base` |
| **What happened** | `can0` found → car mode | `can0` absent → base mode |
| **Override** | Set `ROLE=car` in docker-compose.yml | Set `ROLE=base` |

> [!WARNING]
> Wrong role = LED pattern wrong + no data on PECAN.

---

## 5 · DATA FLOW CHECKS

### Car: UDP Sending

```bash
docker compose logs telemetry | grep "UDP"
```

| | **Pass** | **Fail** |
|---|---|---|
| Expected | `Sending UDP packets to <base-ip>:5005` | Silent |
| Fix | — | Check `REMOTE_IP` + `can0` |

### Base: UDP Receiving

```bash
docker compose logs telemetry | grep "Initial sequence"
```

| | **Pass** | **Fail** |
|---|---|---|
| Expected | `Initial sequence:` + incrementing | Silent |
| Fix | — | Check `REMOTE_IP` + ping car |

### Car: CAN Frames Reading

```bash
docker compose logs telemetry | grep "CAN Reader"
```

| | **Pass** | **Fail** |
|---|---|---|
| Expected | `CAN Reader started on can0` | Silent |
| Fix | — | `docker compose logs telemetry \| grep -i can` |

---

## 6 · PECAN DASHBOARD

Open browser → `http://<base-rpi-ip>:3000`

### TX Page (Car RPi — direct CAN write)
`http://<car-rpi-ip>:3000/transmitter`

| | **Pass** | **Fail** |
|---|---|---|
| WebSocket | Shows `Connected` | `Disconnected` |
| CAN preview | DBC signals decode | No response |
| CAN send | `ack: queued` when `ENABLE_TX_WS=true` | `TX_DISABLED` |

### RX Page (Base RPi — telemetry view)
`http://<base-rpi-ip>:3000`

| | **Pass** | **Fail** |
|---|---|---|
| CAN messages | Live messages updating | No data |
| Message rate | >0 msg/s when car running | 0 msg/s |

---

## 7 · ENABLE TX WebSocket (Car Only)

> [!WARNING]
> **Disabled by default.** Only enable on car RPi when you want to send CAN frames from the TX page.

```bash
# In docker-compose.yml
ENABLE_TX_WS=true
```

```bash
docker compose down && docker compose up -d
```

### Verify TX Enabled

```bash
docker compose logs telemetry | grep "TX WebSocket"
# Expected: "TX WebSocket bridge started on port 9078 (enable via ENABLE_TX_WS=true for actual CAN writes)"
```

---

## 8 · ENABLE_INFLUX_LOGGING (Base Only)

> [!TIP]
> Defaults to `true` in docker-compose.yml. Writes CAN telemetry to local InfluxDB3 for post-run analysis.

| Service | Port | Verify |
|---|---|---|
| InfluxDB3 | `:9000` | `curl http://localhost:9000/health` → `{"status":"ok"}` |
| Grafana | `:8087` | Browser → `admin`/`admin` |

---

## LED QUICK REFERENCE

| LED | Color | Location | Meaning |
|---|---|---|---|
| **CAN activity** | Blue | GPIO 26 | Car mode only — solid = CAN data flowing |
| **CAN activity** | Blue | GPIO 26 | Car mode only — double-flash = no CAN data >1s |
| **CAN telemetry** | Yellow | GPIO 6 | Base + Car — solid = process alive |
| **WebSocket** | Green | GPIO 23 | Connected to PECAN |
| **Audio** | White | GPIO 22 | Audio streaming active |
| **Video** | Red | GPIO 24 | Video streaming active |

---

## FAST TROUBLESHOOTING

| Symptom | Check first | Fix |
|---|---|---|
| No data on PECAN | Base `REMOTE_IP` correct? | Set to car IP |
| Car not sending UDP | Car `REMOTE_IP` correct? | Set to base IP |
| `can0: ERROR` | CAN HAT driver loaded? | `sudo modprobe mcp251xfd` |
| PECAN TX shows `TX_DISABLED` | `ENABLE_TX_WS=true` set? | Edit docker-compose.yml |
| Role wrong on base | `can0` present on base? | Base should NOT have CAN HAT |
| Influx not logging | `ENABLE_INFLUX_LOGGING=true`? | Check docker-compose.yml |
| Redis connection error | `docker compose ps redis` | `docker compose restart redis` |

---

## COMPOSE FILE LOCATIONS

| File | Use |
|---|---|
| `docker-compose.yml` | Development — builds locally |
| `docker-compose.prod.yml` | Production — uses GHCR images |

```bash
# Prod deployment
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

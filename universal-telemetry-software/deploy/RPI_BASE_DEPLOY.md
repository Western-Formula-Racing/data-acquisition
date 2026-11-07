# Raspberry Pi Base Station

The Pi is the whole base station, with no laptop. It talks to the car over the radio link and runs its own Wi-Fi hotspot. Anyone can join the hotspot and open PECAN in a browser, with nothing to install.

Devices on the hotspot can only view. They can't send to the car.

## What viewers do

1. Join the `WFR-BASE` Wi-Fi. The password is on the printed card, or scan its QR code.
2. If the device warns there's no internet, stay connected. A phone may also need mobile data turned off.
3. Open `http://192.168.20.1`. `http://pecan.wfr` also works on most devices, but a phone using mobile data or a private DNS service may not find it.

Type `http://`, because the Pi doesn't serve HTTPS.

Both addresses have been tested in Chrome and Safari on an iPhone, and on a Windows laptop.

## Install

Run this while the Pi has internet. It doesn't switch the Wi-Fi or Ethernet until the next boot, so it can't cut off your session partway.

```bash
cd universal-telemetry-software
sudo deploy/setup-rpi-base.sh --dbc /path/to/car.dbc
sudo wfr-net card       # writes wfr-hotspot-card.html to print
sudo reboot
```

The images are private, so log in to `ghcr.io` first, or add `--build-images` to build them on the Pi. A branch that hasn't reached `main` needs `--build-images`, because images are only published from `main`.

| Option | Use |
|--------|-----|
| `--dbc FILE` | The car's DBC, from the team's private DBC repo. Without it, PECAN warns viewers that signal names and values may be wrong |
| `--build-images` | Build the images on the Pi rather than pull them |
| `--manual-hotspot` | Don't start the hotspot on boot |
| `--replace-car-telemetry` | Disable `car-telemetry` on a Pi that's running it. They need the same ports, so a Pi can't be both |
| `--channel`, `--band`, `--ssid`, `--psk`, `--address` | Hotspot settings. Defaults are 2.4 GHz channel 1. The radios are expected to use 5.8 GHz, so keep the hotspot on 2.4 GHz |

The setup is safe to re-run. It keeps the generated password unless you pass `--psk`.

`--replace-car-telemetry` leaves `can-recorder` alone. If this Pi won't be on the car, stop it yourself with `sudo systemctl disable --now can-recorder`.

## After a reboot

Check these from a device on the hotspot:

| Check | Expected |
|-------|----------|
| Open `http://192.168.20.1` | The dashboard, with no DBC warning |
| Live data | Values update once the car is transmitting |
| `http://192.168.20.1:8080` | Doesn't connect, because the firewall blocks it |

On the Pi, `sudo wfr-net status` shows the Wi-Fi state, firewall, and password.

## Radio power

The base's radio gets passive 24 V PoE from the PoE injection board on the HAT:

```
Pi Ethernet port → HAT input port → board adds 24 V on the spare pairs → HAT output port → radio
```

When the stack starts, the telemetry container drives GPIO 26 low to enable it, and the board's physical switch decides whether power flows. If the switch is off, `daq-telemetry` logs a warning and the status LEDs flash together (see [LED_BEHAVIOR.md](../LED_BEHAVIOR.md)).

**Passive PoE doesn't check what's connected, so it can damage a device that isn't built for it.** Only plug the radio into the HAT's output port. The Pi's own Ethernet port doesn't carry the 24 V, so a laptop can use it on the bench in place of the HAT.

On a Pi without the board, add `OFF_THE_SHELF=true` to `deploy/.env` and run `docker compose -f deploy/docker-compose.rpi-base.yml up -d` from `universal-telemetry-software`. This also turns off the status LEDs.

## Getting back online

The Pi has one Wi-Fi radio, so it's either a hotspot or joined to a network. While it's a hotspot, it has no internet and Tailscale stops working unless Ethernet provides a route.

```bash
sudo wfr-net client       # join a saved Wi-Fi network, then return after 30 minutes
sudo wfr-net client 60    # or after 60 minutes
sudo wfr-net hotspot      # return now
```

If it can't join a saved network, it goes back to the hotspot. Run these from an SSH session or local terminal: Remote Desktop is blocked from the hotspot.

To take the images into the field without internet, see [offline/README.md](offline/README.md).

## Updating the DBC

Re-run `sudo deploy/setup-rpi-base.sh --dbc FILE`, then restart telemetry with `docker restart daq-telemetry`. Viewers get the new file when they reload the page.

Anyone on the hotspot can download the DBC.

## What's different from the laptop stack

| | Pi base | Laptop base |
|---|---|---|
| Viewing | Any device, view-only | The laptop, and devices on its LAN |
| Sending to the car | No | Only if `ENABLE_UPLINK` or `ENABLE_TX_WS` is set |
| Link logging | Raw CSV in the `raw_can_data` Docker volume | Raw CSV, plus TimescaleDB with `--profile timescale` |
| Remote viewers, video | No | `--profile tunnel`, `--profile media` |

The car's `can-recorder` is the complete record either way. The base only has what reached it over the radio.

## How it's locked down

Anyone with the password can join, so the Pi doesn't trust hotspot devices:

- **CAN writes are off.** The compose file sets `ENABLE_UPLINK=false` and `ENABLE_TX_WS=false`, and `tests/test_deploy_contracts.py` fails if that changes.
- **The firewall allows only what viewers need.** `wfr-hotspot-firewall.nft` allows PECAN (80, 3000), live telemetry (9080), DNS, DHCP, and SSH with keys. It blocks the rest, including the status page's upload endpoints and the CAN transmit bridge.
- **Hotspot devices can't reach the car.** The firewall stops the Pi routing hotspot traffic onto the radio link.
- **Redis only listens on `127.0.0.1`.** It has no password.

The firewall also applies while `wlan0` is joined to a normal network, so use Tailscale to reach the Pi then.

## Clock

The Pi has no internet at the track, so its clock can't be trusted, and it could be wrong by however long it was last off. It only sets the car's clock when NTP has synced it (`CAR_TIME_PUSH_REQUIRES_SYNC=true`). Telemetry timestamps come from the car, so the dashboard isn't affected.

## What viewers lose over plain HTTP

Browsers restrict pages that aren't on HTTPS or `localhost`. The dashboard still works, but on the hotspot:

- **History** stays in the browser's memory for about 5 minutes, because the long-session archive needs HTTPS.
- **The app can't be installed** to a home screen, so each visit loads from the Pi.
- **Microphone and USB CAN adapters** don't work, so those pages are hidden.

## Many viewers

Each device gets its own queue on the Pi. One that can't keep up, such as a phone at the edge of Wi-Fi range, loses its own oldest messages instead of slowing the others. After 30 seconds without progress the Pi closes its connection, and the dashboard reconnects when the device comes back.

The Pi's built-in Wi-Fi limits how many devices can join and how far it reaches. Test with the number of devices you expect before relying on it.

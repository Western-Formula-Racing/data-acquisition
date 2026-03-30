# Deploy — Compose File Reference

All Docker Compose files live here. Run every `docker compose` command from the repository root
(i.e. `daq-radio/universal-telemetry-software/`) so that relative volume paths resolve correctly.

---

## docker-compose.yml — Local dev / build

Builds all images from source. Use on either RPi during active development.

```bash
docker compose -f deploy/docker-compose.yml up -d
```

Builds `telemetry` from `../` (the repo root of `universal-telemetry-software`) and `pecan` from
`../../pecan`. Volume mounts for `go2rtc.yaml` and `influxdb3-admin-token.json` resolve to files
one level up in `universal-telemetry-software/`.

---

## docker-compose.prod.yml — Production

Pulls pre-built `:latest` images from GHCR. This is the stack that runs at a race event.

```bash
docker compose -f deploy/docker-compose.prod.yml pull
docker compose -f deploy/docker-compose.prod.yml up -d
```

No local source code is needed — all images are fetched from
`ghcr.io/western-formula-racing/daq-radio/`. Set `REMOTE_IP` to the IP of the other RPi before
starting.

---

## docker-compose.staging.yml — Staging

Pulls `:test-latest` images built from non-main branches. Use this to validate a branch build on
real hardware before merging to main.

```bash
docker compose -f deploy/docker-compose.staging.yml pull
docker compose -f deploy/docker-compose.staging.yml up -d
```

Mirrors the production stack but uses `test-latest` tags so you can smoke-test CI-built images
before they are promoted to `latest`.

---

## docker-compose.test.yml — Integration test stack

Runs car + base containers plus a dedicated test InfluxDB3 instance on a shared bridge network.
Both the car and base images are built from source. Used by CI and by `run_ci_tests.sh`.

```bash
docker compose -f deploy/docker-compose.test.yml up -d --build
```

The car runs in `SIMULATE=true` mode; the base writes to `daq-test-influxdb3`. Bring it down with:

```bash
docker compose -f deploy/docker-compose.test.yml down -v
```

---

## docker-compose.can-test.yml — vCAN pipeline test

Minimal two-service stack (telemetry + Redis) for testing the real CAN read path. The telemetry
container uses `network_mode: host` so it can see the host `can0` interface.

**Requires `can0` to be up on the host before starting:**

```bash
sudo modprobe vcan
sudo ip link add dev can0 type vcan
sudo ip link set up can0
docker compose -f deploy/docker-compose.can-test.yml up -d --build
```

---

## docker-compose.jitsi.yml — Jitsi Meet comms addon

Optional self-hosted Jitsi Meet stack for voice/video communication between car and pit.
Deploy on the base station RPi. The car-side Jitsi client starts only with `--profile car`.

```bash
# Base station
docker compose -f deploy/docker-compose.jitsi.yml up -d

# Car RPi (adds the headless Jitsi client)
docker compose -f deploy/docker-compose.jitsi.yml --profile car up -d
```

Jitsi config directories (`jitsi-config/`, `custom-jitsi-config.js`) must exist in
`universal-telemetry-software/` before starting.

---

## docker-compose.rpi5.yml — Raspberry Pi 5 override

Apply on top of any other compose file when running on an RPi5 to work around the jemalloc 16KB
page incompatibility. This override forces `influxdb3` (and `test-influxdb3`) to run under QEMU
amd64 emulation instead of native ARM64.

**One-time setup on the Pi 5:**

```bash
sudo apt-get install -y qemu-user-static binfmt-support
```

**Usage — stack on RPi5:**

```bash
# Production
docker compose -f deploy/docker-compose.prod.yml -f deploy/docker-compose.rpi5.yml up -d

# Integration tests on RPi5
docker compose -f deploy/docker-compose.test.yml -f deploy/docker-compose.rpi5.yml up -d --build
```

# Offline Docker Images

This folder contains a tarball of all Docker images needed to run the MacBook stack without internet.

## Build the tarball (with internet, before going to the field)

```bash
cd universal-telemetry-software/deploy
docker save \
  ghcr.io/western-formula-racing/daq-radio/universal-telemetry:latest \
  ghcr.io/western-formula-racing/daq-radio/pecan:latest \
  timescale/timescaledb:latest-pg16 \
  redis:8.2 \
  bluenviron/mediamtx:latest \
  grafana/grafana:latest \
  -o offline/wfr-docker-images.tar
```

## Load the tarball (on site, no internet)

```bash
cd universal-telemetry-software/deploy
docker load -i offline/wfr-docker-images.tar
```

## Bring up the stack offline

```bash
cd universal-telemetry-software/deploy
docker compose -f docker-compose.macbook-base.yml --env-file .env.macbook up -d
```

Then access at:
- Pecan: http://localhost:3000
- Grafana: http://localhost:8087 (admin / admin)
- Status: http://localhost:8080

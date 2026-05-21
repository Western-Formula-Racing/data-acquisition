# Offline Docker Images

This folder contains a tarball of all Docker images needed to run the MacBook stack without internet.

## Build the tarball (with internet, before going to the field)

```bash
cd universal-telemetry-software/deploy
docker save \
  ghcr.io/western-formula-racing/data-acquisition/universal-telemetry:latest \
  ghcr.io/western-formula-racing/data-acquisition/pecan:latest \
  redis:8.2 \
  -o offline/wfr-docker-images.tar
```

Add optional profile images to that `docker save` command only when needed:

```bash
timescale/timescaledb:latest-pg16   # --profile timescale
bluenviron/mediamtx:latest          # --profile media
nginx:alpine                        # --profile media
cloudflare/cloudflared:latest       # --profile tunnel
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
- Status: http://localhost:8080

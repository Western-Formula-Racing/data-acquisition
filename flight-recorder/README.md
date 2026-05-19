# Flight Recorder

Flight Recorder is a supported phone-based store-and-forward telemetry recorder with an optional live relay. It gives the team a lightweight way to get run data into the database without setting up the full base-station workflow or pulling the SD card from the `ECU_25` ECU code setup after every run.

Internal app: <https://fdr.westernformularacing.org> (`wfr-fdr.pages.dev`, protected by Cloudflare Zero Trust)

Typical use:

1. Connect a phone to the car hotspot.
2. Open Flight Recorder.
3. Point it at the car UTS WebSocket, for example `ws://<car-ip>:9080`.
4. Start recording before the run.
5. Stop recording after the run.
6. Sync the stored frames when WiFi/cellular/server access is available.

## What It Does

- Receives telemetry from the UTS WebSocket stream.
- Decodes messages with the selected DBC.
- Records CAN frame IDs, raw bytes, and receipt timestamps into browser IndexedDB while recording is enabled.
- Keeps frames local until upload succeeds.
- Uploads decoded signal batches to the data-downloader API at `POST /api/can-frames/batch`.
- Marks local frames as synced after a successful upload so interrupted uploads can be retried.
- Provides separate guarded controls for `WS Relay` and `DB Forward`; either path can be used without turning on the other.

## What It Is Not

- It is not the primary live telemetry dashboard. Use PECAN + UTS for real-time monitoring.
- It does not read CAN hardware directly from the phone.
- It does not replace the base station stack for normal track operations.

The phone must stay connected to the car hotspot and keep the page open during the run.

## Relationship To `lte-relay`

The old `lte-relay` branch explored publishing the car's live WebSocket over Cloudflare/LTE. Flight Recorder is the preferred path for no-SD-card database ingest because it records locally first and uploads later. That store-and-forward behavior is more tolerant of weak cellular/WiFi links than a live-only relay.

Keep LTE relay concepts only for remote live viewing or debugging. Do not treat LTE relay as the primary run-data ingestion path.

## Optional Live Relay Mode

Flight Recorder can act as the phone-side half of an LTE/WebSocket relay, but it cannot replace the whole relay by itself.

A browser PWA cannot listen for inbound WebSocket connections, expose `wss://` publicly, or run Cloudflared. It can only make outbound connections. To use Flight Recorder for remote live viewing, you still need a cloud relay backend that accepts an ingest WebSocket from the phone and rebroadcasts those frames to remote viewers. The included Wrangler Worker in [`relay-worker/`](relay-worker/) provides that backend without running a separate server.

Expected shape:

1. Phone connects to the car hotspot and receives UTS telemetry from `ws://<car-ip>:9080`.
2. Flight Recorder records frames locally for store-and-forward database ingest.
3. If live relay is enabled, Flight Recorder asks the Worker for a unique relay session.
4. The Worker returns an ingest URL for the phone and a viewer `wss://` URL for PECAN/remote viewers.
5. Flight Recorder opens the ingest WebSocket, forwards raw UTS frames, and injects a 1 Hz heartbeat frame with CAN ID `0x7FD` and data `FA AA FA AA 00 00 00 00`.
6. The Cloudflare Worker backend rebroadcasts those frames to remote PECAN/viewer clients subscribed to the viewer URL.

The database ingest path should still be store-and-forward. Live relay is best-effort and should be used only for remote viewing/debugging.

The relay Worker is intentionally public and tokenless to keep trackside setup simple. Treat generated viewer URLs as shareable links rather than secrets.

When Flight Recorder is connected to the hosted demo source (`wss://ws-demo.westernformularacing.org`), live relay intentionally sends only the 1 Hz heartbeat. Demo telemetry is not rebroadcast to viewer sessions.

## DBC Access

DBC files are listed and fetched from `Western-Formula-Racing/DBC` using the build-time Vite environment variable `VITE_GITHUB_DBC_READONLY_TOKEN`. For Cloudflare Pages Git builds, set that variable in the `wfr-fdr` Pages project. For direct `wrangler pages deploy dist` uploads, the value must be present in the local build environment before running `npm run build`.

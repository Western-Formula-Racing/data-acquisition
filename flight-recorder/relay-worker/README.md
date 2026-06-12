# Flight Recorder Relay Worker

Cloudflare Worker + Durable Object relay for optional live viewing from the phone-based Flight Recorder workflow.

This is not a separate VPS backend. It is a Wrangler-deployed Cloudflare Worker that creates per-session relay URLs and accepts:

- phone ingest WebSocket: `wss://<worker-domain>/ingest?room=<room>`
- viewer WebSocket: `wss://<worker-domain>/view?room=<room>`
- session creation endpoint: `https://<worker-domain>/session`

Flight Recorder connects to the car UTS WebSocket and records locally. If live relay is enabled, it also forwards raw UTS WebSocket frames to `/ingest`. Remote PECAN/viewer clients connect to `/view` and receive those frames.

Deployed Worker:

```text
https://flight-recorder-relay.westernformularacing.workers.dev
```

## Deploy

```bash
cd flight-recorder/relay-worker
npm install
npm run deploy
```

Use the deployed Worker URL in Flight Recorder's live relay box:

```text
https://flight-recorder-relay.westernformularacing.workers.dev
```

Tap the session button in Flight Recorder. The Worker returns a unique room with:

- an ingest URL for the phone
- a viewer WSS URL for PECAN/remote viewers

Remote viewers use the generated viewer URL, shaped like:

```text
wss://<worker-domain>/view?room=<generated-room>
```

## Notes

- Store-and-forward database ingest remains the reliable path.
- Live relay is best-effort and depends on the phone staying awake, connected to the car hotspot, and able to reach Cloudflare over cellular/WiFi.
- The Worker does not decode or persist telemetry; it only rebroadcasts raw WebSocket frames.
- Flight Recorder injects a synthetic heartbeat once per second while relay is connected: CAN ID `0x7FD`, data bytes `FA AA FA AA 00 00 00 00`.
- Flight Recorder does not rebroadcast telemetry from `wss://ws-demo.westernformularacing.org`; demo-source relay sessions send only the synthetic heartbeat.
- The relay is intentionally public. Anyone with a viewer URL can subscribe to that room, and anyone who knows an ingest room URL can publish frames to it.

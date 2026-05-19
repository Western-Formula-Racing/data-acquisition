# Flight Recorder

Flight Recorder is an optional trackside phone recorder. It is useful when you want a quick temporary recording path without setting up the full base-station workflow or pulling the SD card from the `ECU_25` ECU code setup after every run.

Typical use:

1. Connect a phone to the car hotspot.
2. Open Flight Recorder.
3. Point it at the car UTS WebSocket, for example `ws://<car-ip>:9080`.
4. Start recording before the run.
5. Stop recording after the run and upload the stored frames when WiFi/server access is available.

## What It Does

- Receives telemetry from the UTS WebSocket stream.
- Decodes messages with the selected DBC.
- Records CAN frame IDs, raw bytes, and receipt timestamps into browser IndexedDB while recording is enabled.
- Uploads decoded signal batches to the data-downloader API at `POST /api/can-frames/batch`.

## What It Is Not

- It is not the primary live telemetry dashboard. Use PECAN + UTS for real-time monitoring.
- It does not read CAN hardware directly from the phone.
- It does not replace the base station stack for normal track operations.

The phone must stay connected to the car hotspot and keep the page open during the run.

import os
import sys
import time
import uuid
import multiprocessing
import logging
from src.data import TelemetryNode
from src.video import run_video
from src.audio import run_audio
from src.websocket_bridge import run_websocket_bridge
from src.websocket_bridge_tx import run_tx_bridge
from src.ws_relay import run_ws_relay
from src.status_server import run_status_server
from src.leds import run_leds
from src.poe import run_poe
from src.link_diagnostics import run_link_diagnostics
import asyncio

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger("Main")

# Processes that carry the live telemetry feed. If one of these dies the stack
# is genuinely broken, so we tear everything down and exit non-zero to let the
# supervisor (Docker `restart:`/systemd `Restart=always`) restart cleanly.
# Auxiliary processes (TimescaleBridge, TX bridge, status server, link
# diagnostics, video, audio, LEDs, PoE) are best-effort: if e.g. the optional
# Timescale logging DB is unreachable, that must NOT take the live feed down —
# restarting the whole stack on its death would only crash-loop the feed we are
# trying to keep alive. Those are logged loudly but tolerated.
CRITICAL_PROCESSES = {"Telemetry", "CarServices", "WebSocket"}


def _timescale_dsn_reachable() -> bool:
    """Return True when the configured Timescale/Postgres DSN accepts a connection."""
    dsn = os.getenv("POSTGRES_DSN")
    if not dsn:
        logger.info("Timescale auto mode disabled: POSTGRES_DSN is not set")
        return False

    try:
        import psycopg2

        conn = psycopg2.connect(dsn, connect_timeout=1)
        conn.close()
        return True
    except Exception as e:
        logger.info("Timescale auto mode disabled: database is not reachable (%s)", e)
        return False


def _resolve_timescale_enabled(role: str) -> bool:
    raw = os.getenv("ENABLE_TIMESCALE_LOGGING", "false").strip().lower()
    if role != "base":
        return False
    if raw == "auto":
        enabled = _timescale_dsn_reachable()
        os.environ["TIMESCALE_EFFECTIVE_ENABLED"] = "true" if enabled else "false"
        logger.info("Timescale auto mode resolved to %s", "enabled" if enabled else "disabled")
        return enabled
    enabled = raw == "true"
    os.environ["TIMESCALE_EFFECTIVE_ENABLED"] = "true" if enabled else "false"
    return enabled

def start_telemetry(can_event=None, telemetry_event=None):
    # Base station: telemetry runs as its own process; WS bridge is a separate process reading Redis.
    try:
        os.nice(-10)
        logger.info("Telemetry process priority set to -10 (High)")
    except PermissionError:
        logger.warning("Could not set Telemetry priority (needs root/CAP_SYS_NICE)")
    node = TelemetryNode(can_event=can_event, telemetry_event=telemetry_event)
    asyncio.run(node.start())


def start_car_services(can_event=None, telemetry_event=None, websocket_event=None):
    # Car: telemetry + WS bridge share one asyncio event loop via a direct queue.
    # No Redis needed — messages flow in-process from TelemetryNode -> websocket_bridge.
    try:
        os.nice(-10)
        logger.info("Telemetry process priority set to -10 (High)")
    except PermissionError:
        logger.warning("Could not set Telemetry priority (needs root/CAP_SYS_NICE)")

    async def _run():
        # Queue must be created inside the event loop so it binds to the correct loop.
        # Creating asyncio.Queue() before asyncio.run() triggers get_event_loop() which
        # sets a default loop; asyncio.gather() then returns a Future instead of a
        # coroutine, causing asyncio.run() to raise ValueError.
        direct_queue: asyncio.Queue = asyncio.Queue(maxsize=2000)
        node = TelemetryNode(can_event=can_event, telemetry_event=telemetry_event)
        node.direct_queue = direct_queue
        await asyncio.gather(
            node.start(),
            run_websocket_bridge(heartbeat_event=websocket_event, direct_queue=direct_queue),
        )

    asyncio.run(_run())


def start_leds(role, poe_ok_event, can_event, telemetry_event, websocket_event, audio_event, video_event):
    run_leds(role, poe_ok_event, can_event, telemetry_event, websocket_event, audio_event, video_event)

def start_poe(poe_ok_event):
    run_poe(poe_ok_event)

def start_video(role, remote_ip, video_event=None):
    # Set Lower Priority (Video can drop frames if needed)
    try:
        os.nice(5)
    except PermissionError:
        pass
    run_video(role, remote_ip, heartbeat_event=video_event)

def start_audio(role, remote_ip, audio_event=None):
    # Set Medium Priority (Audio needs low latency)
    try:
        os.nice(-5)
        logger.info("Audio process priority set to -5 (Medium)")
    except PermissionError:
        logger.warning("Could not set Audio priority")
    run_audio(role, remote_ip, heartbeat_event=audio_event)

def start_websocket_bridge(websocket_event=None):
    # WebSocket bridge for PECAN dashboard
    logger.info("Starting WebSocket bridge for PECAN")
    asyncio.run(run_websocket_bridge(heartbeat_event=websocket_event))


def start_tx_bridge():
    # TX WebSocket bridge for PECAN Transmitter page (signal-based CAN encode + send)
    # OFF by default; set ENABLE_TX_WS=true to enable
    logger.info("Starting TX WebSocket bridge on port 9078 (ENABLE_TX_WS controls actual CAN writes)")
    asyncio.run(run_tx_bridge())


def start_ws_relay():
    logger.info("Starting WebSocket telemetry relay (ENABLE_WS_RELAY)")
    asyncio.run(run_ws_relay())

def start_status_server():
    # HTTP server for status monitoring page
    logger.info("Starting status monitoring HTTP server")
    run_status_server()

def start_link_diagnostics():
    # Link diagnostics (ping, throughput, radio stats)
    logger.info("Starting link diagnostics service")
    asyncio.run(run_link_diagnostics())

def start_timescale_bridge():
    # Redis → TimescaleDB bridge (decodes CAN and writes to server TimescaleDB)
    # Imported lazily so the car role doesn't need psycopg2 installed
    from src.timescale_bridge import run_timescale_bridge
    logger.info("Starting TimescaleDB bridge (Redis → server TimescaleDB)")
    asyncio.run(run_timescale_bridge())

if __name__ == "__main__":
    logger.info("Universal Telemetry Software Starting...")
    
    # Configuration
    role = os.getenv("ROLE", "auto")
    remote_ip = os.getenv("REMOTE_IP", "127.0.0.1")
    enable_video = os.getenv("ENABLE_VIDEO", "true").lower() == "true"
    enable_audio = os.getenv("ENABLE_AUDIO", "true").lower() == "true"
    
    boot_session_id = os.getenv("BOOT_SESSION_ID", str(uuid.uuid4())[:8])
    os.environ["BOOT_SESSION_ID"] = boot_session_id
    logger.info(f"Generated BOOT_SESSION_ID: {boot_session_id}")

    # Note: Telemetry needs to run first or alone to detect role if "auto"
    # But for simplicity, if "auto", we might need logic in main to detect first?
    # TelemetryNode detects it internally. Ideally, we detect once here.
    
    if role == "auto":
        # Quick detection logic (duplicated for now from telemetry.py for init)
        try:
            import can
            with can.interface.Bus(channel='can0', bustype='socketcan') as bus:
                role = "car"
        except:
            role = "base"
        logger.info(f"Auto-detected Role: {role}")

    # Export ROLE so child processes (e.g. websocket_bridge) can read it
    os.environ["ROLE"] = role
    enable_timescale = _resolve_timescale_enabled(role)
    logger.info(f"REMOTE_IP={remote_ip} (role={role})")

    processes = []

    # Shared events for LED controller
    poe_ok_event     = multiprocessing.Event()
    poe_ok_event.set()  # assume OK until PoE monitor says otherwise
    can_event        = multiprocessing.Event()
    telemetry_event  = multiprocessing.Event()
    websocket_event  = multiprocessing.Event()
    audio_event      = multiprocessing.Event()
    video_event      = multiprocessing.Event()

    off_the_shelf = os.getenv("OFF_THE_SHELF", "true").lower() == "true"

    # 0a. PoE enable & switch monitor (skip on off-the-shelf CAN HAT — no PoE hardware)
    if not off_the_shelf:
        p_poe = multiprocessing.Process(target=start_poe, args=(poe_ok_event,), name="PoE")
        p_poe.start()
        processes.append(p_poe)
    else:
        poe_ok_event.set()  # assume OK when no PoE hardware
        logger.info("PoE monitor skipped (OFF_THE_SHELF=true)")

    # 0b. LED controller (skip on off-the-shelf CAN HAT — no status LEDs)
    if not off_the_shelf:
        p_leds = multiprocessing.Process(
            target=start_leds,
            args=(role, poe_ok_event, can_event, telemetry_event, websocket_event, audio_event, video_event),
            name="LEDs"
        )
        p_leds.start()
        processes.append(p_leds)
    else:
        logger.info("LED controller skipped (OFF_THE_SHELF=true)")

    # 1. Telemetry + WebSocket Bridge
    if role == "car":
        # Car: single process runs CAN reader, UDP sender, and WS bridge together.
        # They share an asyncio.Queue — no Redis required on the car.
        p_telemetry = multiprocessing.Process(
            target=start_car_services,
            args=(can_event, telemetry_event, websocket_event),
            name="CarServices",
        )
        p_telemetry.start()
        processes.append(p_telemetry)
        logger.info("Car services started (telemetry + WS bridge in one process, no Redis)")
    else:
        # Base: telemetry and WS bridge are separate processes communicating via Redis.
        p_telemetry = multiprocessing.Process(target=start_telemetry, args=(can_event, telemetry_event), name="Telemetry")
        p_telemetry.start()
        processes.append(p_telemetry)

        # Eagerly initialize the WCARS engine in the parent so the ring buffer is
        # warm before the first frame arrives in the child WS bridge process.
        if os.getenv("WCARS_ENABLED", "1") == "1":
            from src.websocket_bridge import get_wcars_engine
            get_wcars_engine()

        p_websocket = multiprocessing.Process(target=start_websocket_bridge, args=(websocket_event,), name="WebSocket")
        p_websocket.start()
        processes.append(p_websocket)
        logger.info(f"WebSocket bridge started for PECAN dashboard (role={role})")

    # 2b. TX WebSocket Bridge (port 9078) — signal-based CAN encode + send via python-can
    #     OFF by default; set ENABLE_TX_WS=true to enable
    p_tx_websocket = multiprocessing.Process(target=start_tx_bridge, name="TxWebSocket")
    p_tx_websocket.start()
    processes.append(p_tx_websocket)
    logger.info("TX WebSocket bridge started on port 9078 (enable via ENABLE_TX_WS=true for actual CAN writes)")

    if os.getenv("ENABLE_WS_RELAY", "false").lower() == "true":
        p_ws_relay = multiprocessing.Process(target=start_ws_relay, name="WsRelay")
        p_ws_relay.start()
        processes.append(p_ws_relay)
        logger.info(
            "WebSocket relay started (RELAY_LISTEN_PORT=%s)",
            os.getenv("RELAY_LISTEN_PORT", "9089"),
        )

    # 3. Status Server (Base Station Only - for monitoring)
    if role == "base":
        p_status = multiprocessing.Process(target=start_status_server, name="StatusServer")
        p_status.start()
        processes.append(p_status)
        logger.info("Status monitoring server started on port 8080")

    # 4. Link Diagnostics (Base Station Only - ping, throughput, radio)
    if role == "base":
        p_link_diag = multiprocessing.Process(target=start_link_diagnostics, name="LinkDiagnostics")
        p_link_diag.start()
        processes.append(p_link_diag)
        logger.info("Link diagnostics service started")

    # 5. TimescaleDB Bridge (Base Station Only, opt-in)
    if role == "base" and enable_timescale:
        p_timescale = multiprocessing.Process(target=start_timescale_bridge, name="TimescaleBridge")
        p_timescale.start()
        processes.append(p_timescale)
        logger.info(f"TimescaleDB bridge started (dsn=*, table={os.getenv('TIMESCALE_TABLE', 'wfr26_base')})")

    # 5. Video (Optional)
    if enable_video:
        p_video = multiprocessing.Process(target=start_video, args=(role, remote_ip, video_event), name="Video")
        p_video.start()
        processes.append(p_video)

    # 5. Audio (Optional)
    if enable_audio:
        p_audio = multiprocessing.Process(target=start_audio, args=(role, remote_ip, audio_event), name="Audio")
        p_audio.start()
        processes.append(p_audio)

    try:
        while True:
            time.sleep(1)
            # Monitor children. A dead child means the pipeline is degraded. The
            # parent stays alive in this loop, so neither Docker's
            # `restart: unless-stopped` nor systemd's `Restart=always` ever sees
            # the failure and the stack silently keeps running half-dead.
            #
            # For a critical process (the live-feed path — telemetry / WS bridge)
            # fail fast: tear down the surviving children and exit non-zero so the
            # supervisor restarts the whole stack cleanly. For an auxiliary
            # process, log loudly and stop tracking it, but keep the live feed
            # running — nuking the stack because, say, the optional Timescale DB
            # is down would only crash-loop the very feed we are protecting.
            dead = [p for p in processes if not p.is_alive()]
            if dead:
                dead_critical = [p for p in dead if p.name in CRITICAL_PROCESSES]
                for p in dead:
                    level = logger.error if p in dead_critical else logger.warning
                    fate = (
                        "Shutting down for supervisor restart."
                        if p in dead_critical
                        else "Auxiliary process — live feed kept running."
                    )
                    level(f"Process {p.name} died (exitcode={p.exitcode}). {fate}")

                if dead_critical:
                    for p in processes:
                        if p.is_alive():
                            p.terminate()
                    for p in processes:
                        p.join(timeout=5)
                    sys.exit(1)

                # Stop tracking dead auxiliary processes so we don't re-log them
                # every second.
                for p in dead:
                    processes.remove(p)
    except KeyboardInterrupt:
        logger.info("Shutting down...")
        for p in processes:
            p.terminate()
            p.join()

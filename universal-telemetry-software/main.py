import os
import time
import multiprocessing
import logging
from src.data import TelemetryNode
from src.video import run_video
from src.audio import run_audio
from src.websocket_bridge import run_websocket_bridge
from src.status_server import run_status_server
from src.leds import run_leds
from src.poe import run_poe
from src.link_diagnostics import run_link_diagnostics
import asyncio

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger("Main")

def start_telemetry(can_event=None, telemetry_event=None):
    # Set High Priority (Critical for CAN)
    try:
        os.nice(-10)
        logger.info("Telemetry process priority set to -10 (High)")
    except PermissionError:
        logger.warning("Could not set Telemetry priority (needs root/CAP_SYS_NICE)")

    # Telemetry is asyncio based
    node = TelemetryNode(can_event=can_event, telemetry_event=telemetry_event)
    asyncio.run(node.start())


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

def start_status_server():
    # HTTP server for status monitoring page
    logger.info("Starting status monitoring HTTP server")
    run_status_server()

def start_link_diagnostics():
    # Link diagnostics (ping, throughput, radio stats)
    logger.info("Starting link diagnostics service")
    asyncio.run(run_link_diagnostics())

if __name__ == "__main__":
    logger.info("Universal Telemetry Software Starting...")
    
    # Configuration
    role = os.getenv("ROLE", "auto")
    remote_ip = os.getenv("REMOTE_IP", "127.0.0.1")
    enable_video = os.getenv("ENABLE_VIDEO", "true").lower() == "true"
    enable_audio = os.getenv("ENABLE_AUDIO", "true").lower() == "true"

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

    processes = []

    # Shared events for LED controller
    poe_ok_event     = multiprocessing.Event()
    poe_ok_event.set()  # assume OK until PoE monitor says otherwise
    can_event        = multiprocessing.Event()
    telemetry_event  = multiprocessing.Event()
    websocket_event  = multiprocessing.Event()
    audio_event      = multiprocessing.Event()
    video_event      = multiprocessing.Event()

    # 0a. PoE enable & switch monitor
    p_poe = multiprocessing.Process(target=start_poe, args=(poe_ok_event,), name="PoE")
    p_poe.start()
    processes.append(p_poe)

    # 0b. LED controller (always on when hardware is present)
    p_leds = multiprocessing.Process(
        target=start_leds,
        args=(role, poe_ok_event, can_event, telemetry_event, websocket_event, audio_event, video_event),
        name="LEDs"
    )
    p_leds.start()
    processes.append(p_leds)

    # 1. Telemetry (Critical)
    p_telemetry = multiprocessing.Process(target=start_telemetry, args=(can_event, telemetry_event), name="Telemetry")
    p_telemetry.start()
    processes.append(p_telemetry)

    # 2. WebSocket Bridge (Base Station Only - for PECAN)
    if role == "base":
        p_websocket = multiprocessing.Process(target=start_websocket_bridge, args=(websocket_event,), name="WebSocket")
        p_websocket.start()
        processes.append(p_websocket)
        logger.info("WebSocket bridge started for PECAN dashboard")

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
            # Monitor children
            for p in processes:
                if not p.is_alive():
                    logger.error(f"Process {p.name} died!")
                    # Optional: Restart logic
    except KeyboardInterrupt:
        logger.info("Shutting down...")
        for p in processes:
            p.terminate()
            p.join()

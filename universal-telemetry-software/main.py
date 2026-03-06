import os
import time
import multiprocessing
import logging
from src.data import TelemetryNode
from src.video import run_video
from src.audio import run_audio
from src.websocket_bridge import run_websocket_bridge
from src.status_server import run_status_server
import asyncio

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger("Main")

def start_telemetry():
    # Set High Priority (Critical for CAN)
    try:
        os.nice(-10)
        logger.info("Telemetry process priority set to -10 (High)")
    except PermissionError:
        logger.warning("Could not set Telemetry priority (needs root/CAP_SYS_NICE)")

    # Telemetry is asyncio based
    node = TelemetryNode()
    asyncio.run(node.start())

def start_video(role, remote_ip):
    # Set Lower Priority (Video can drop frames if needed)
    try:
        os.nice(5)
    except PermissionError:
        pass
    run_video(role, remote_ip)

def start_audio(role, remote_ip):
    # Set Medium Priority (Audio needs low latency)
    try:
        os.nice(-5)
        logger.info("Audio process priority set to -5 (Medium)")
    except PermissionError:
        logger.warning("Could not set Audio priority")
    run_audio(role, remote_ip)

def start_websocket_bridge():
    # WebSocket bridge for PECAN dashboard
    logger.info("Starting WebSocket bridge for PECAN")
    asyncio.run(run_websocket_bridge())

def start_status_server():
    # HTTP server for status monitoring page
    logger.info("Starting status monitoring HTTP server")
    run_status_server()

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

    # Export ROLE so child processes (e.g. websocket_bridge) can read it
    os.environ["ROLE"] = role

    processes = []

    # 1. Telemetry (Critical)
    p_telemetry = multiprocessing.Process(target=start_telemetry, name="Telemetry")
    p_telemetry.start()
    processes.append(p_telemetry)

    # 2. WebSocket Bridge (Both roles — for PECAN)
    #    Car mode:  enables direct CAN bus uplink writes (no Redis relay)
    #    Base mode: relays uplink via Redis -> UDP to car
    p_websocket = multiprocessing.Process(target=start_websocket_bridge, name="WebSocket")
    p_websocket.start()
    processes.append(p_websocket)
    logger.info(f"WebSocket bridge started for PECAN dashboard (role={role})")

    # 3. Status Server (Base Station Only - for monitoring)
    if role == "base":
        p_status = multiprocessing.Process(target=start_status_server, name="StatusServer")
        p_status.start()
        processes.append(p_status)
        logger.info("Status monitoring server started on port 8080")

    # 4. Video (Optional)
    if enable_video:
        p_video = multiprocessing.Process(target=start_video, args=(role, remote_ip), name="Video")
        p_video.start()
        processes.append(p_video)

    # 5. Audio (Optional)
    if enable_audio:
        p_audio = multiprocessing.Process(target=start_audio, args=(role, remote_ip), name="Audio")
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

import gi
import os
import glob
import json
import logging
import subprocess
import threading
import time
import http.server
import socketserver

gi.require_version('Gst', '1.0')
from gi.repository import Gst, GLib

from src import utils

logger = logging.getLogger("Video")
logger.setLevel(logging.INFO)

# Optional OpenCV import for file simulation
try:
    import cv2
    HAS_OPENCV = True
except ImportError:
    HAS_OPENCV = False

RTSP_PORT   = int(os.getenv("RTSP_PORT", "8554"))
STREAM_NAME = os.getenv("VIDEO_STREAM_NAME", "car-camera")
VIDEO_CONTROL_PORT = int(os.getenv("VIDEO_CONTROL_PORT", "8081"))

QUALITY_PRESETS = {
    "low":    {"width": "640",  "height": "360", "bitrate": "500",  "fps": "30"},
    "medium": {"width": "848",  "height": "480", "bitrate": "800",  "fps": "30"},
    "high":   {"width": "1280", "height": "720", "bitrate": "2000", "fps": "30"},
}
DEFAULT_QUALITY = "medium"


class VideoStream:
    def __init__(self, role, remote_ip, port=5600):
        self.role      = role
        self.remote_ip = remote_ip
        self.port      = port   # kept for GStreamer fallback paths
        self.pipeline  = None
        self.loop      = None
        self.appsrc    = None
        self.running   = False
        self._quality  = DEFAULT_QUALITY
        self._ffmpeg_proc = None
        self._ffmpeg_lock = threading.Lock()

        Gst.init(None)

    # ── Camera probing ────────────────────────────────────────────────────────

    def _find_usb_camera(self):
        """Return the first V4L2 video capture device path, or None."""
        for device in sorted(glob.glob("/dev/video*")):
            try:
                import fcntl, struct
                VIDIOC_QUERYCAP = 0x80685600
                with open(device, 'rb') as f:
                    buf = bytearray(104)
                    fcntl.ioctl(f, VIDIOC_QUERYCAP, buf)
                    caps = struct.unpack_from('<I', buf, 84)[0]
                    if caps & 0x1:   # V4L2_CAP_VIDEO_CAPTURE
                        return device
            except (OSError, IOError):
                continue
        return None

    def _camera_supports_h264(self, device):
        """Return True if the V4L2 device advertises a native H.264 format."""
        try:
            result = subprocess.run(
                ["v4l2-ctl", "--device", device, "--list-formats"],
                capture_output=True, text=True, timeout=3,
            )
            return "H264" in result.stdout
        except Exception:
            return False

    # ── Quality control ──────────────────────────────────────────────────────

    def set_quality(self, preset: str) -> bool:
        """Change quality preset and restart ffmpeg. Returns True on success."""
        if preset not in QUALITY_PRESETS:
            return False
        if preset == self._quality:
            return True
        self._quality = preset
        logger.info(f"Quality changed to '{preset}' — restarting ffmpeg")
        with self._ffmpeg_lock:
            if self._ffmpeg_proc and self._ffmpeg_proc.poll() is None:
                self._ffmpeg_proc.terminate()
                try:
                    self._ffmpeg_proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    self._ffmpeg_proc.kill()
        return True

    # ── Car sender — RTSP push to MediaMTX on Mac ─────────────────────────

    def _build_ffmpeg_cmd(self, device: str, native_h264: bool):
        """Build ffmpeg command for current quality preset."""
        preset = QUALITY_PRESETS[self._quality]
        rtsp_url = f"rtsp://{self.remote_ip}:{RTSP_PORT}/{STREAM_NAME}"
        width   = preset["width"]
        height  = preset["height"]
        fps     = preset["fps"]
        bitrate = preset["bitrate"]

        # Force software encoding — hardware cameras often lack periodic keyframes,
        # which breaks WebRTC recovery after packet loss.
        if native_h264:
            input_args  = ["-f", "v4l2", "-input_format", "h264",
                           "-timestamps", "abs",
                           "-video_size", f"{width}x{height}", "-framerate", fps,
                           "-i", device]
            encode_args = ["-use_wallclock_as_timestamps", "1", "-c:v", "copy"]
        else:
            input_args  = ["-fflags", "nobuffer", "-flags", "low_delay",
                           "-f", "v4l2",
                           "-timestamps", "abs",
                           "-video_size", f"{width}x{height}", "-framerate", fps,
                           "-i", device]
            encode_args = ["-c:v", "libx264", "-preset", "ultrafast",
                           "-tune", "zerolatency", "-b:v", f"{bitrate}k",
                           "-g", "15", "-bf", "0", "-threads", "1"]

        logger.info(f"[{self._quality}] {width}x{height} @ {bitrate}kbps → {rtsp_url}")

        return (
            ["ffmpeg", "-hide_banner", "-loglevel", "warning"]
            + input_args + encode_args
            + ["-an", "-f", "rtsp", "-rtsp_transport", "tcp", rtsp_url]
        )

    def _start_rtsp_push(self, device: str, native_h264: bool):
        """Push H.264 from the USB camera to MediaMTX on the base station via RTSP."""
        # Always force software encoding for reliable keyframes
        native_h264 = False

        self.running = True
        while self.running:
            cmd = self._build_ffmpeg_cmd(device, native_h264)
            logger.info(f"RTSP push command: {' '.join(cmd)}")

            with self._ffmpeg_lock:
                proc = subprocess.Popen(
                    cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                )
                self._ffmpeg_proc = proc

            def _drain_ffmpeg(p):
                for line in p.stdout:
                    msg = line.decode(errors="replace").rstrip()
                    if msg:
                        logger.info(f"[ffmpeg] {msg}")

            t = threading.Thread(target=_drain_ffmpeg, args=(proc,), daemon=True)
            t.start()
            ret = proc.wait()
            t.join(timeout=2)

            if not self.running:
                break
            logger.error(f"ffmpeg exited (code {ret}) — restarting in 3s")
            time.sleep(3)

    # ── HTTP control server ──────────────────────────────────────────────────

    def _start_control_server(self):
        """Start a tiny HTTP server for quality control from Pecan."""
        stream = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, fmt, *args):
                logger.debug(f"[ctrl] {fmt % args}")

            def do_OPTIONS(self):
                self.send_response(200)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
                self.send_header('Access-Control-Allow-Headers', 'Content-Type')
                self.end_headers()

            def do_GET(self):
                if self.path == '/video/quality':
                    body = json.dumps({
                        "quality": stream._quality,
                        "presets": QUALITY_PRESETS,
                    }).encode()
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json')
                    self.send_header('Access-Control-Allow-Origin', '*')
                    self.send_header('Content-Length', str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                else:
                    self.send_response(404)
                    self.end_headers()

            def do_POST(self):
                if self.path == '/video/quality':
                    length = int(self.headers.get('Content-Length', 0))
                    data = json.loads(self.rfile.read(length))
                    preset = data.get('quality', '')
                    if stream.set_quality(preset):
                        body = json.dumps({"ok": True, "quality": preset}).encode()
                        self.send_response(200)
                    else:
                        body = json.dumps({"error": f"unknown preset: {preset}"}).encode()
                        self.send_response(400)
                    self.send_header('Content-Type', 'application/json')
                    self.send_header('Access-Control-Allow-Origin', '*')
                    self.send_header('Content-Length', str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                else:
                    self.send_response(404)
                    self.end_headers()

        class ReuseServer(socketserver.TCPServer):
            allow_reuse_address = True

        server = ReuseServer(("0.0.0.0", VIDEO_CONTROL_PORT), Handler)
        logger.info(f"Video control server on port {VIDEO_CONTROL_PORT}")
        server.serve_forever()

    # ── GStreamer source (file simulation / libcamera fallback) ───────────────

    def _build_gst_source(self):
        """Build a GStreamer sender pipeline (used only when no USB camera found)."""
        video_file = os.getenv("VIDEO_FILE")

        if video_file and os.path.exists(video_file) and HAS_OPENCV:
            logger.info(f"File simulation via OpenCV: {video_file}")
            source = (
                "appsrc name=source is-live=true format=3 "
                "caps=video/x-raw,format=BGR,width=1280,height=720,framerate=30/1 ! "
                "videoconvert ! video/x-raw,format=I420"
            )
            self.use_appsrc = True
            self.video_path = video_file
        elif os.path.exists("/usr/bin/libcamera-hello") or os.path.exists(
            "/usr/lib/aarch64-linux-gnu/gstreamer-1.0/libgstlibcamera.so"
        ):
            source = "libcamerasrc ! video/x-raw,width=1280,height=720,framerate=60/1 ! videoconvert"
        else:
            source = "videotestsrc pattern=ball ! video/x-raw,width=1280,height=720,framerate=30/1"
            logger.warning("No camera or file found — using videotestsrc test pattern")

        bitrate_kbps = int(os.getenv("VIDEO_BITRATE", "2000"))
        if os.getenv("USE_HW_ENC", "false") == "true":
            encoder = f'v4l2h264enc extra-controls="controls,video_bitrate={bitrate_kbps * 1000};"'
        else:
            encoder = (
                f"x264enc tune=zerolatency bitrate={bitrate_kbps} "
                f"speed-preset=superfast key-int-max=30"
            )

        return (
            f"{source} ! {encoder} ! "
            f"rtph264pay config-interval=1 pt=96 ! "
            f"udpsink host={self.remote_ip} port={self.port} sync=false"
        )

    # ── Base receiver (local display, rarely used) ────────────────────────────

    def _build_gst_sink(self):
        sink = "fakesink" if os.getenv("HEADLESS", "true") == "true" else "autovideosink"
        return (
            f"udpsrc port={self.port} ! "
            f"application/x-rtp, payload=96 ! "
            f"rtph264depay ! avdec_h264 ! videoconvert ! {sink}"
        )

    # ── GStreamer appsrc feeder (file simulation) ─────────────────────────────

    def appsrc_feeder(self):
        cap = cv2.VideoCapture(self.video_path)
        if not cap.isOpened():
            logger.error(f"Failed to open video file: {self.video_path}")
            return
        fps = 30.0
        while self.running:
            ret, frame = cap.read()
            if not ret:
                cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                continue
            if frame.shape[1] != 1280 or frame.shape[0] != 720:
                frame = cv2.resize(frame, (1280, 720))
            try:
                data = frame.tobytes()
                buf = Gst.Buffer.new_allocate(None, len(data), None)
                buf.fill(0, data)
                self.appsrc.emit("push-buffer", buf)
            except Exception as e:
                logger.error(f"AppSrc push error: {e}")
                break
            time.sleep(1.0 / fps)
        cap.release()

    # ── Entry point ───────────────────────────────────────────────────────────

    def start(self):
        if self.role == "car":
            # Start quality control HTTP server in background
            ctrl_thread = threading.Thread(target=self._start_control_server, daemon=True)
            ctrl_thread.start()

            device = self._find_usb_camera()
            if device:
                native = self._camera_supports_h264(device)
                logger.info(f"USB camera: {device} | native H.264: {native}")
                self._start_rtsp_push(device, native_h264=native)
                return

            # No USB camera — fall through to GStreamer (file sim / libcamera)
            cmd = self._build_gst_source()
        else:
            cmd = self._build_gst_sink()

        try:
            logger.info(f"Starting GStreamer pipeline: {cmd}")
            self.pipeline = Gst.parse_launch(cmd)

            if self.role == "car" and getattr(self, 'use_appsrc', False):
                self.appsrc = self.pipeline.get_by_name("source")
                if not self.appsrc:
                    logger.error("Could not find appsrc element named 'source'")
                    return
                self.running = True
                t = threading.Thread(target=self.appsrc_feeder, daemon=True)
                t.start()

            bus = self.pipeline.get_bus()
            bus.add_signal_watch()
            bus.connect("message", self.on_message)
            self.pipeline.set_state(Gst.State.PLAYING)
            self.loop = GLib.MainLoop()
            self.loop.run()
        except Exception as e:
            logger.error(f"Video stream error: {e}")
            self.stop()

    def stop(self):
        self.running = False
        if self.pipeline:
            self.pipeline.set_state(Gst.State.NULL)
        if self.loop and self.loop.is_running():
            self.loop.quit()

    def on_message(self, bus, message):
        t = message.type
        if t == Gst.MessageType.EOS:
            logger.info("End of stream")
        elif t == Gst.MessageType.ERROR:
            err, debug = message.parse_error()
            logger.error(f"GStreamer error: {err}, {debug}")
            self.stop()


def run_video(role, remote_ip, heartbeat_event=None):
    if heartbeat_event is not None:
        utils.start_heartbeat_thread(heartbeat_event)

    stream = VideoStream(role, remote_ip)
    stream.start()

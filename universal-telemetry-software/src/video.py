import gi
import sys
import os
import glob
import logging
import time
import threading

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

class VideoStream:
    def __init__(self, role, remote_ip, port=5600):
        self.role = role
        self.remote_ip = remote_ip
        self.port = port
        self.pipeline = None
        self.loop = None
        self.appsrc = None
        self.running = False
        
        Gst.init(None)

    def _find_usb_camera(self):
        """Find the first available V4L2 video capture device."""
        for device in sorted(glob.glob("/dev/video*")):
            try:
                # Check if device supports video capture (not metadata)
                import fcntl
                import struct
                VIDIOC_QUERYCAP = 0x80685600
                with open(device, 'rb') as f:
                    buf = bytearray(104)
                    fcntl.ioctl(f, VIDIOC_QUERYCAP, buf)
                    capabilities = struct.unpack_from('<I', buf, 84)[0]
                    # V4L2_CAP_VIDEO_CAPTURE = 0x1
                    if capabilities & 0x1:
                        return device
            except (OSError, IOError):
                continue
        return None

    def build_pipeline_source(self):
        """Constructs the sender pipeline string."""
        video_file = os.getenv("VIDEO_FILE")
        
        # 1. File Simulation Mode (using OpenCV -> AppSrc)
        if video_file and os.path.exists(video_file) and HAS_OPENCV:
            logger.info(f"Using OpenCV to stream file: {video_file}")
            # appsrc expects raw video. We'll send BGR or RGB.
            # videoconvert handles the conversion to YUV for the encoder.
            source = (
                "appsrc name=source is-live=true format=3 " # format=3 is TIME
                "caps=video/x-raw,format=BGR,width=1280,height=720,framerate=30/1 ! "
                "videoconvert ! video/x-raw,format=I420"
            )
            self.use_appsrc = True
            self.video_path = video_file
        else:
            self.use_appsrc = False
            # 2. Live Camera Mode
            # Check for RPi CSI camera
            if os.path.exists("/usr/bin/libcamera-hello") or os.path.exists("/usr/lib/aarch64-linux-gnu/gstreamer-1.0/libgstlibcamera.so"):
                source = "libcamerasrc ! video/x-raw,width=1280,height=720,framerate=60/1 ! videoconvert"
            # 3. USB camera (any /dev/video* device)
            elif self._find_usb_camera():
                device = self._find_usb_camera()
                logger.info(f"USB camera detected: {device}")
                source = f"v4l2src device={device} ! video/x-raw,width=1280,height=720,framerate=30/1 ! videoconvert"
            else:
                # Fallback Test Pattern
                source = "videotestsrc pattern=ball ! video/x-raw,width=1280,height=720,framerate=30/1"
                logger.warning("No camera/file found, using videotestsrc")

        # Encoding (H.264)
        # Configurable bitrate (kbps for software, bps for hardware)
        bitrate_kbps = int(os.getenv("VIDEO_BITRATE", "2000"))
        logger.info(f"Video bitrate: {bitrate_kbps} kbps")
        encoder = f"x264enc tune=zerolatency bitrate={bitrate_kbps} speed-preset=superfast key-int-max=30"

        if os.getenv("USE_HW_ENC", "false") == "true":
            # RPi Hardware Encoder (expects bps)
            encoder = f"v4l2h264enc extra-controls=\"controls,video_bitrate={bitrate_kbps * 1000};\""

        # Full Sender Pipeline
        cmd = (
            f"{source} ! "
            f"{encoder} ! "
            f"rtph264pay config-interval=1 pt=96 ! "
            f"udpsink host={self.remote_ip} port={self.port} sync=false"
        )
        return cmd

    def build_pipeline_sink(self):
        """Constructs the receiver pipeline string."""
        sink = "autovideosink"
        if os.getenv("HEADLESS", "true") == "true":
            sink = "fakesink"

        cmd = (
            f"udpsrc port={self.port} ! "
            f"application/x-rtp, payload=96 ! "
            f"rtph264depay ! "
            f"avdec_h264 ! "
            f"videoconvert ! "
            f"{sink}"
        )
        return cmd

    def appsrc_feeder(self):
        """Thread to feed frames from OpenCV to GStreamer appsrc."""
        cap = cv2.VideoCapture(self.video_path)
        if not cap.isOpened():
            logger.error(f"Failed to open video file: {self.video_path}")
            return

        fps = 30.0
        duration_sec = 1.0 / fps
        
        while self.running:
            ret, frame = cap.read()
            if not ret:
                # Loop: Restart video
                cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                continue

            # Resize if needed to match caps (1280x720)
            # frame = cv2.resize(frame, (1280, 720)) 
            # Assuming test video is already suitable or we let gst handle minor mismatch if caps match data
            # Ideally resize here to match the 1280x720 caps we set.
            if frame.shape[1] != 1280 or frame.shape[0] != 720:
                 frame = cv2.resize(frame, (1280, 720))

            # Push to pipeline
            try:
                # Convert to bytes
                data = frame.tobytes()
                # Create Gst Buffer
                buf = Gst.Buffer.new_allocate(None, len(data), None)
                buf.fill(0, data)
                
                # Push
                self.appsrc.emit("push-buffer", buf)
            except Exception as e:
                logger.error(f"AppSrc push error: {e}")
                break

            # Rate limiting
            time.sleep(duration_sec)

        cap.release()

    def start(self):
        try:
            if self.role == "car":
                cmd = self.build_pipeline_source()
            else:
                cmd = self.build_pipeline_sink()

            logger.info(f"Starting Video Pipeline: {cmd}")
            self.pipeline = Gst.parse_launch(cmd)

            # Setup AppSrc if needed
            if self.role == "car" and getattr(self, 'use_appsrc', False):
                self.appsrc = self.pipeline.get_by_name("source")
                if not self.appsrc:
                    logger.error("Could not find appsrc named 'source'")
                    return
                
                self.running = True
                self.feed_thread = threading.Thread(target=self.appsrc_feeder)
                self.feed_thread.daemon = True
                self.feed_thread.start()

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
            logger.info("End of stream (should not happen in appsrc loop mode)")
        elif t == Gst.MessageType.ERROR:
            err, debug = message.parse_error()
            logger.error(f"Error: {err}, {debug}")
            self.stop()

def run_video(role, remote_ip, heartbeat_event=None):
    if heartbeat_event is not None:
        utils.start_heartbeat_thread(heartbeat_event)

    stream = VideoStream(role, remote_ip)
    stream.start()
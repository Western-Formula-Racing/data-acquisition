import gi
import sys
import os
import logging
import threading
import time

gi.require_version('Gst', '1.0')
from gi.repository import Gst, GLib

logger = logging.getLogger("Audio")
logger.setLevel(logging.INFO)

class AudioTransceiver:
    def __init__(self, remote_ip, port=5601, ptt_active=False):
        self.remote_ip = remote_ip
        self.port = port
        self.ptt_active = ptt_active # If true, microphone is open (or physical button pressed)
        
        self.rx_pipeline = None
        self.tx_pipeline = None
        self.loop = None
        
        Gst.init(None)

    def build_rx_pipeline(self):
        # Receiver: Always listening
        sink = os.getenv("AUDIO_SINK", "autoaudiosink")
        # On RPi or Linux, we might need pulsesink or alsasink explicitly if auto fails
        
        cmd = (
            f"udpsrc port={self.port} ! "
            f"application/x-rtp, media=audio, clock-rate=48000, encoding-name=OPUS, payload=97 ! "
            f"rtpopusdepay ! "
            f"opusdec ! "
            f"audioconvert ! "
            f"{sink} sync=false" 
            # sync=false to reduce latency drift
        )
        logger.info(f"RX Pipeline: {cmd}")
        return Gst.parse_launch(cmd)

    def build_tx_pipeline(self):
        # Sender: Only active if PTT is True
        source = os.getenv("AUDIO_SOURCE", "autoaudiosrc")
        
        cmd = (
            f"{source} ! "
            f"audioconvert ! audio/x-raw,channels=1,rate=48000 ! "
            f"opusenc bitrate=16000 audio-type=voice frame-size=20 ! "
            f"rtpopuspay ! "
            f"udpsink host={self.remote_ip} port={self.port} sync=false"
        )
        logger.info(f"TX Pipeline: {cmd}")
        return Gst.parse_launch(cmd)

    def start(self):
        try:
            # Start RX (Always On)
            self.rx_pipeline = self.build_rx_pipeline()
            self.rx_pipeline.set_state(Gst.State.PLAYING)
            
            # Start TX (If PTT is enabled by default, e.g. Open Mic)
            if self.ptt_active:
                logger.info("PTT Active: Starting TX pipeline")
                self.tx_pipeline = self.build_tx_pipeline()
                self.tx_pipeline.set_state(Gst.State.PLAYING)

            # Main Loop
            self.loop = GLib.MainLoop()
            self.loop.run()
        except Exception as e:
            logger.error(f"Audio error: {e}")
            self.stop()

    def set_ptt(self, active):
        """Dynamic PTT toggle"""
        if active and not self.tx_pipeline:
            logger.info("PTT Pressed: TX Start")
            self.tx_pipeline = self.build_tx_pipeline()
            self.tx_pipeline.set_state(Gst.State.PLAYING)
        elif not active and self.tx_pipeline:
            logger.info("PTT Released: TX Stop")
            self.tx_pipeline.set_state(Gst.State.NULL)
            self.tx_pipeline = None

    def stop(self):
        if self.rx_pipeline:
            self.rx_pipeline.set_state(Gst.State.NULL)
        if self.tx_pipeline:
            self.tx_pipeline.set_state(Gst.State.NULL)
        if self.loop:
            self.loop.quit()

class AudioWebBridge:
    def __init__(self, remote_ip, receive_callback, port=5601):
        self.remote_ip = remote_ip
        self.port = port
        self.receive_callback = receive_callback
        
        self.rx_pipeline = None
        self.tx_pipeline = None
        self.appsrc = None
        self.loop = None
        self.thread = None
        
        Gst.init(None)

    def start(self):
        # TX Pipeline: Web (appsrc) -> Network (udpsink)
        # Input: Raw PCM S16LE 48kHz Mono
        tx_cmd = (
            f"appsrc name=mysource format=time ! "
            f"audio/x-raw,format=S16LE,rate=48000,channels=1,layout=interleaved ! "
            f"audioconvert ! "
            f"queue ! "
            f"opusenc bitrate=16000 audio-type=voice frame-size=20 ! "
            f"rtpopuspay ! "
            f"udpsink host={self.remote_ip} port={self.port} sync=false"
        )
        logger.info(f"Bridge TX Pipeline: {tx_cmd}")
        self.tx_pipeline = Gst.parse_launch(tx_cmd)
        self.appsrc = self.tx_pipeline.get_by_name('mysource')
        
        # RX Pipeline: Network (udpsrc) -> Web (appsink)
        # Output: Raw PCM S16LE 48kHz Mono
        rx_cmd = (
            f"udpsrc port={self.port} ! "
            f"application/x-rtp, media=audio, clock-rate=48000, encoding-name=OPUS, payload=97 ! "
            f"rtpopusdepay ! "
            f"queue ! "
            f"opusdec ! "
            f"audioconvert ! "
            f"audio/x-raw,format=S16LE,rate=48000,channels=1 ! "
            f"appsink name=mysink emit-signals=True sync=false"
        )
        logger.info(f"Bridge RX Pipeline: {rx_cmd}")
        self.rx_pipeline = Gst.parse_launch(rx_cmd)
        
        sink = self.rx_pipeline.get_by_name('mysink')
        sink.connect("new-sample", self.on_sample)
        
        self.tx_pipeline.set_state(Gst.State.PLAYING)
        self.rx_pipeline.set_state(Gst.State.PLAYING)
        
        self.thread = threading.Thread(target=self._run_loop)
        self.thread.start()

    def _run_loop(self):
        self.loop = GLib.MainLoop()
        try:
            self.loop.run()
        except:
            pass

    def on_sample(self, sink):
        sample = sink.emit("pull-sample")
        buf = sample.get_buffer()
        success, map_info = buf.map(Gst.MapFlags.READ)
        if success:
            data = bytes(map_info.data)
            buf.unmap(map_info)
            if self.receive_callback:
                self.receive_callback(data)
        return Gst.FlowReturn.OK

    def push_audio(self, data):
        """Push raw PCM bytes from Web to GStreamer pipeline"""
        if self.appsrc:
            # Create a GStreamer buffer
            buf = Gst.Buffer.new_allocate(None, len(data), None)
            buf.fill(0, data)
            self.appsrc.emit("push-buffer", buf)

    def stop(self):
        if self.rx_pipeline:
            self.rx_pipeline.set_state(Gst.State.NULL)
        if self.tx_pipeline:
            self.tx_pipeline.set_state(Gst.State.NULL)
        if self.loop:
            self.loop.quit()

def run_audio(role, remote_ip, heartbeat_event=None):
    # For now, read PTT from ENV. In real usage, this would be a GPIO callback.
    ptt_initial = os.getenv("PTT_ENABLED", "false").lower() == "true"

    # Heartbeat thread for LED status
    if heartbeat_event is not None:
        def _heartbeat():
            while True:
                heartbeat_event.set()
                time.sleep(1)
        t = threading.Thread(target=_heartbeat, daemon=True)
        t.start()

    transceiver = AudioTransceiver(remote_ip, ptt_active=ptt_initial)
    transceiver.start()

"""
LED controller for the PoE injection board.

Pin assignments (BCM numbering):
  CAN activity   Blue    GPIO 3
  CAN telemetry  Yellow  GPIO 6   – DATA LAN jack (PCB label)
  WebSocket      Green   GPIO 10  – DATA LAN jack (PCB label)
  Audio          Yellow  GPIO 7   – RADIO LAN jack (PCB label)
  Video          Green   GPIO 9   – RADIO LAN jack (PCB label)

CAN LED behaviour (blue):
  Off            Not in car mode (base station)
  Double-flash   Car mode, idle – two quick flashes then off for ~1 s
  Solid          Car mode, CAN data flowing

Status LEDs (telemetry, websocket, audio, video):
  Solid     Service process is alive and has checked in recently
  Off       Service not running or not responding

The controller runs in its own process; call run_leds() from main.py.
"""

import time
import logging

logger = logging.getLogger(__name__)

# ── GPIO pin numbers (BCM) ────────────────────────────────────────────────────
PIN_CAN_BLUE    = 3

PIN_TELEMETRY   = 6    # Yellow – DATA LAN jack – CAN telemetry process
PIN_WEBSOCKET   = 10   # Green  – DATA LAN jack – WebSocket bridge
PIN_AUDIO       = 7    # Yellow – RADIO LAN jack – audio streaming
PIN_VIDEO       = 9    # Green  – RADIO LAN jack – video streaming

ALL_PINS = (PIN_CAN_BLUE, PIN_TELEMETRY, PIN_WEBSOCKET, PIN_AUDIO, PIN_VIDEO)

# ── Timing constants ──────────────────────────────────────────────────────────
CAN_TIMEOUT      = 1.0   # seconds without CAN data before switching to idle pattern
STATUS_TIMEOUT   = 3.0   # seconds without a heartbeat before status LED goes off
POLL_INTERVAL    = 0.05  # main loop tick (50 ms)

# CAN idle pattern: two quick flashes then pause
# Each flash is FLASH_ON long, gap between flashes is FLASH_GAP, pause is FLASH_PAUSE
CAN_FLASH_ON     = 0.08
CAN_FLASH_GAP    = 0.12
CAN_FLASH_PAUSE  = 1.0
# Total cycle: on-gap-on-pause = 0.08+0.12+0.08+1.0 = 1.28s
CAN_IDLE_CYCLE   = [
    (True,  CAN_FLASH_ON),    # flash 1 on
    (False, CAN_FLASH_GAP),   # flash 1 off
    (True,  CAN_FLASH_ON),    # flash 2 on
    (False, CAN_FLASH_PAUSE), # pause
]


# ─────────────────────────────────────────────────────────────────────────────
# GPIO abstraction (graceful fallback when RPi.GPIO is not available)
# ─────────────────────────────────────────────────────────────────────────────

class _GPIOBackend:
    """Thin wrapper so the rest of the code doesn't care about import errors."""

    def __init__(self):
        self._gpio = None
        try:
            import RPi.GPIO as GPIO
            GPIO.setmode(GPIO.BCM)
            GPIO.setwarnings(False)
            for pin in ALL_PINS:
                GPIO.setup(pin, GPIO.OUT, initial=GPIO.LOW)
            self._gpio = GPIO
            logger.info("RPi.GPIO initialised (BCM mode)")
        except ImportError:
            logger.warning("RPi.GPIO not available – running in stub mode (no hardware output)")
        except Exception as e:
            logger.warning(f"GPIO init failed: {e} – running in stub mode")

    def set(self, pin: int, high: bool):
        if self._gpio is None:
            return
        self._gpio.output(pin, self._gpio.HIGH if high else self._gpio.LOW)

    def cleanup(self):
        if self._gpio is not None:
            try:
                self._gpio.cleanup()
            except Exception:
                pass


# ─────────────────────────────────────────────────────────────────────────────
# Main LED controller loop
# ─────────────────────────────────────────────────────────────────────────────

def led_controller(role, can_event, telemetry_event, websocket_event,
                   audio_event, video_event):
    """
    Long-running loop that drives the LEDs.

    Parameters
    ----------
    role:
        "car" or "base".  CAN blue LED is only active in car mode.
    can_event:
        Set by the CAN reader on every received frame.
    telemetry_event, websocket_event, audio_event, video_event:
        Heartbeat events set periodically by each service to indicate it is
        alive.  The LED controller clears them after each check; if not
        re-set within STATUS_TIMEOUT the corresponding LED turns off.
    """
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    )

    is_car = (role == "car")
    gpio = _GPIOBackend()

    # CAN LED state
    last_can_rx    = 0.0
    can_active     = False   # True while CAN data is flowing
    can_led_on     = False
    idle_step      = 0       # index into CAN_IDLE_CYCLE
    idle_step_time = 0.0     # when current idle step started

    # Track last heartbeat time for each status LED
    status_leds = {
        PIN_TELEMETRY: {"event": telemetry_event, "last": 0.0, "on": False},
        PIN_WEBSOCKET: {"event": websocket_event, "last": 0.0, "on": False},
        PIN_AUDIO:     {"event": audio_event,     "last": 0.0, "on": False},
        PIN_VIDEO:     {"event": video_event,     "last": 0.0, "on": False},
    }

    logger.info(f"LED controller started (role={role})")

    try:
        while True:
            now = time.monotonic()

            # ── CAN LED ──────────────────────────────────────────────────
            if not is_car:
                # Base mode: LED always off
                if can_led_on:
                    can_led_on = False
                    gpio.set(PIN_CAN_BLUE, False)
            else:
                # Consume any CAN event
                if can_event.is_set():
                    can_event.clear()
                    last_can_rx = now

                was_active = can_active
                can_active = (last_can_rx > 0 and
                              now - last_can_rx <= CAN_TIMEOUT)

                if can_active:
                    # Data flowing: solid on
                    if not can_led_on:
                        can_led_on = True
                        gpio.set(PIN_CAN_BLUE, True)
                else:
                    # Idle: double-flash pattern
                    if was_active:
                        # Just went idle — reset pattern
                        idle_step = 0
                        idle_step_time = now

                    desired, duration = CAN_IDLE_CYCLE[idle_step]
                    if now - idle_step_time >= duration:
                        idle_step = (idle_step + 1) % len(CAN_IDLE_CYCLE)
                        idle_step_time = now
                        desired = CAN_IDLE_CYCLE[idle_step][0]

                    if desired != can_led_on:
                        can_led_on = desired
                        gpio.set(PIN_CAN_BLUE, desired)

            # ── Status LEDs (solid when service is alive) ────────────────
            for pin, state in status_leds.items():
                if state["event"].is_set():
                    state["event"].clear()
                    state["last"] = now
                    if not state["on"]:
                        state["on"] = True
                        gpio.set(pin, True)
                elif state["on"] and now - state["last"] > STATUS_TIMEOUT:
                    state["on"] = False
                    gpio.set(pin, False)

            time.sleep(POLL_INTERVAL)

    except KeyboardInterrupt:
        pass
    finally:
        for pin in ALL_PINS:
            gpio.set(pin, False)
        gpio.cleanup()
        logger.info("LED controller stopped")


def run_leds(role, can_event, telemetry_event, websocket_event,
             audio_event, video_event):
    """Entry point called from main.py."""
    led_controller(role, can_event, telemetry_event, websocket_event,
                   audio_event, video_event)

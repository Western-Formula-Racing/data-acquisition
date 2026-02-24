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

PoE error override:
  When the PoE switch is off (poe_ok_event cleared), ALL LEDs flash in
  unison (~0.5 s on / 0.5 s off), overriding normal behaviour.

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

# PoE error: all LEDs flash in unison
POE_FLASH_ON     = 0.5
POE_FLASH_OFF    = 0.5


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
# LED state machine
# ─────────────────────────────────────────────────────────────────────────────

class LEDStateMachine:
    """
    Pure state-machine logic for LED control.  Call tick() once per loop
    iteration; it returns a dict {pin: bool} of GPIO changes to apply.
    """

    def __init__(self, is_car):
        self.is_car = is_car

        # CAN LED state
        self.last_can_rx    = 0.0
        self.can_active     = False
        self.can_led_on     = False
        self.idle_step      = 0
        self.idle_step_time = 0.0

        # PoE error flash state
        self.poe_flash_on   = False
        self.poe_flash_time = 0.0

        # Status LED state: {pin: {"last": float, "on": bool}}
        self.status_leds = {}
        for pin in (PIN_TELEMETRY, PIN_WEBSOCKET, PIN_AUDIO, PIN_VIDEO):
            self.status_leds[pin] = {"last": 0.0, "on": False}

    def tick(self, now, poe_ok, can_rx, status_heartbeats):
        """
        Advance one tick and return GPIO changes.

        Parameters
        ----------
        now : float
            Current monotonic time.
        poe_ok : bool
            True if PoE switch is ON.
        can_rx : bool
            True if a CAN frame was received since last tick.
        status_heartbeats : dict[int, bool]
            {pin: True} for each status LED that received a heartbeat this tick.

        Returns
        -------
        dict[int, bool]
            Pin changes to apply: {pin_number: on/off}.
        """
        changes = {}

        # ── PoE error override ───────────────────────────────────────────
        if not poe_ok:
            duration = POE_FLASH_ON if self.poe_flash_on else POE_FLASH_OFF
            if now - self.poe_flash_time >= duration:
                self.poe_flash_on = not self.poe_flash_on
                self.poe_flash_time = now
                for pin in ALL_PINS:
                    changes[pin] = self.poe_flash_on
            return changes

        # Exiting PoE error — reset
        if self.poe_flash_on:
            self.poe_flash_on = False
            self.can_led_on = False
            for pin in ALL_PINS:
                changes[pin] = False

        # ── CAN LED ──────────────────────────────────────────────────────
        if not self.is_car:
            if self.can_led_on:
                self.can_led_on = False
                changes[PIN_CAN_BLUE] = False
        else:
            if can_rx:
                self.last_can_rx = now

            was_active = self.can_active
            self.can_active = (self.last_can_rx > 0 and
                               now - self.last_can_rx <= CAN_TIMEOUT)

            if self.can_active:
                if not self.can_led_on:
                    self.can_led_on = True
                    changes[PIN_CAN_BLUE] = True
            else:
                # Idle: double-flash pattern
                if was_active:
                    self.idle_step = 0
                    self.idle_step_time = now

                desired, duration = CAN_IDLE_CYCLE[self.idle_step]
                if now - self.idle_step_time >= duration:
                    self.idle_step = (self.idle_step + 1) % len(CAN_IDLE_CYCLE)
                    self.idle_step_time = now
                    desired = CAN_IDLE_CYCLE[self.idle_step][0]

                if desired != self.can_led_on:
                    self.can_led_on = desired
                    changes[PIN_CAN_BLUE] = desired

        # ── Status LEDs ──────────────────────────────────────────────────
        for pin, state in self.status_leds.items():
            if status_heartbeats.get(pin, False):
                state["last"] = now
                if not state["on"]:
                    state["on"] = True
                    changes[pin] = True
            elif state["on"] and now - state["last"] > STATUS_TIMEOUT:
                state["on"] = False
                changes[pin] = False

        return changes


# ─────────────────────────────────────────────────────────────────────────────
# Main LED controller loop
# ─────────────────────────────────────────────────────────────────────────────

def led_controller(role, poe_ok_event, can_event, telemetry_event,
                   websocket_event, audio_event, video_event):
    """
    Long-running loop that drives the LEDs.

    Parameters
    ----------
    role:
        "car" or "base".  CAN blue LED is only active in car mode.
    poe_ok_event:
        Set when PoE switch is ON.  When cleared, all LEDs flash as error.
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

    gpio = _GPIOBackend()
    sm = LEDStateMachine(is_car=(role == "car"))

    # Map heartbeat events to their status LED pins
    heartbeat_events = {
        PIN_TELEMETRY: telemetry_event,
        PIN_WEBSOCKET: websocket_event,
        PIN_AUDIO:     audio_event,
        PIN_VIDEO:     video_event,
    }

    logger.info(f"LED controller started (role={role})")

    try:
        while True:
            now = time.monotonic()

            # Read and clear events
            can_rx = can_event.is_set()
            if can_rx:
                can_event.clear()

            status_hb = {}
            for pin, evt in heartbeat_events.items():
                if evt.is_set():
                    evt.clear()
                    status_hb[pin] = True

            # Advance state machine
            changes = sm.tick(now, poe_ok_event.is_set(), can_rx, status_hb)

            # Apply GPIO changes
            for pin, high in changes.items():
                gpio.set(pin, high)

            time.sleep(POLL_INTERVAL)

    except KeyboardInterrupt:
        pass
    finally:
        for pin in ALL_PINS:
            gpio.set(pin, False)
        gpio.cleanup()
        logger.info("LED controller stopped")


def run_leds(role, poe_ok_event, can_event, telemetry_event, websocket_event,
             audio_event, video_event):
    """Entry point called from main.py."""
    led_controller(role, poe_ok_event, can_event, telemetry_event,
                   websocket_event, audio_event, video_event)

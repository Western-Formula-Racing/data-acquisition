"""
PoE enable and switch monitor for the PoE injection board.

GPIO assignments (BCM numbering):
  GPIO 27  OUTPUT  PoE Enable  – drives MOSFET gate (BSS316NH6327XTSA1)
  GPIO 25  INPUT   PoE Read    – reads downstream side of physical switch

Hardware topology:
  GPIO 27 ──► physical switch ──► MOSFET gate ──► GPIO 25

  When software sets GPIO 27 HIGH and the physical switch is ON,
  GPIO 25 reads HIGH and PoE power flows to the downstream device.

  If GPIO 27 is HIGH but GPIO 25 reads LOW, the physical switch is OFF
  and the user should be warned (all LEDs flash via poe_ok_event).

Runs in its own process; call run_poe() from main.py.
"""

import time
import logging

logger = logging.getLogger(__name__)

PIN_POE_ENABLE = 27   # OUTPUT – drive HIGH to request PoE
PIN_POE_READ   = 25   # INPUT  – reads HIGH when switch is ON and power flows

POLL_INTERVAL  = 1.0  # seconds between switch checks


def run_poe(poe_ok_event):
    """
    Enable PoE output and continuously monitor the physical switch.

    Parameters
    ----------
    poe_ok_event:
        multiprocessing.Event.  Set when PoE is OK (switch on),
        cleared when the switch is detected as off.
    """
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    )

    gpio = None
    try:
        import RPi.GPIO as GPIO
        GPIO.setmode(GPIO.BCM)
        GPIO.setwarnings(False)
        GPIO.setup(PIN_POE_ENABLE, GPIO.OUT, initial=GPIO.HIGH)
        GPIO.setup(PIN_POE_READ, GPIO.IN, pull_up_down=GPIO.PUD_DOWN)
        gpio = GPIO
        logger.info("PoE enabled (GPIO %d HIGH), monitoring switch on GPIO %d",
                     PIN_POE_ENABLE, PIN_POE_READ)
    except ImportError:
        logger.warning("RPi.GPIO not available – PoE monitor running in stub mode")
    except Exception as e:
        logger.warning("PoE GPIO init failed: %s – running in stub mode", e)

    # In stub mode assume PoE is fine
    if gpio is None:
        poe_ok_event.set()
        try:
            while True:
                time.sleep(POLL_INTERVAL)
        except KeyboardInterrupt:
            pass
        return

    try:
        while True:
            switch_on = gpio.input(PIN_POE_READ) == gpio.HIGH
            if switch_on:
                if not poe_ok_event.is_set():
                    poe_ok_event.set()
                    logger.info("PoE switch ON – power flowing")
            else:
                if poe_ok_event.is_set():
                    poe_ok_event.clear()
                    logger.warning("PoE switch OFF – enable is HIGH but read is LOW")
            time.sleep(POLL_INTERVAL)
    except KeyboardInterrupt:
        pass
    finally:
        # Leave PoE enable HIGH on shutdown (hardware default is safer with power on)
        if gpio is not None:
            try:
                gpio.cleanup([PIN_POE_READ])  # only clean up input; leave enable HIGH
            except Exception:
                pass
        logger.info("PoE monitor stopped")

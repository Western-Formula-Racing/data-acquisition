"""Unit tests for LED state machine and PoE monitor logic."""

import pytest
from src.leds import (
    LEDStateMachine,
    PIN_CAN_BLUE, PIN_TELEMETRY, PIN_WEBSOCKET, PIN_AUDIO, PIN_VIDEO,
    ALL_PINS, CAN_TIMEOUT, STATUS_TIMEOUT,
    CAN_FLASH_ON, CAN_FLASH_GAP, CAN_FLASH_PAUSE,
    POE_FLASH_ON, POE_FLASH_OFF,
)

NO_HEARTBEATS = {}


# ─────────────────────────────────────────────────────────────────────────────
# PoE error override
# ─────────────────────────────────────────────────────────────────────────────

class TestPoEErrorOverride:
    """When PoE switch is off, ALL LEDs flash in unison, overriding everything."""

    def test_poe_error_flashes_all_leds_on(self):
        sm = LEDStateMachine(is_car=True)
        # First tick with poe_ok=False after enough time to trigger flash
        changes = sm.tick(now=1.0, poe_ok=False, can_rx=False,
                          status_heartbeats=NO_HEARTBEATS)
        assert all(changes.get(pin) is True for pin in ALL_PINS)

    def test_poe_error_flashes_off_after_duration(self):
        sm = LEDStateMachine(is_car=True)
        sm.tick(now=1.0, poe_ok=False, can_rx=False,
                status_heartbeats=NO_HEARTBEATS)
        # Advance past POE_FLASH_ON duration
        changes = sm.tick(now=1.0 + POE_FLASH_ON + 0.01, poe_ok=False,
                          can_rx=False, status_heartbeats=NO_HEARTBEATS)
        assert all(changes.get(pin) is False for pin in ALL_PINS)

    def test_poe_error_ignores_can_and_heartbeats(self):
        sm = LEDStateMachine(is_car=True)
        heartbeats = {PIN_TELEMETRY: True, PIN_AUDIO: True}
        changes = sm.tick(now=1.0, poe_ok=False, can_rx=True,
                          status_heartbeats=heartbeats)
        # Should only contain flash state, not individual LED logic
        assert all(changes.get(pin) is True for pin in ALL_PINS)

    def test_poe_recovery_resets_all_leds(self):
        sm = LEDStateMachine(is_car=True)
        # Enter PoE error
        sm.tick(now=1.0, poe_ok=False, can_rx=False,
                status_heartbeats=NO_HEARTBEATS)
        # Recover
        changes = sm.tick(now=2.0, poe_ok=True, can_rx=False,
                          status_heartbeats=NO_HEARTBEATS)
        assert all(changes.get(pin) is False for pin in ALL_PINS)

    def test_poe_no_change_within_flash_period(self):
        sm = LEDStateMachine(is_car=True)
        sm.tick(now=1.0, poe_ok=False, can_rx=False,
                status_heartbeats=NO_HEARTBEATS)
        # Tick again within flash period — no changes
        changes = sm.tick(now=1.0 + 0.01, poe_ok=False, can_rx=False,
                          status_heartbeats=NO_HEARTBEATS)
        assert changes == {}


# ─────────────────────────────────────────────────────────────────────────────
# CAN LED — base mode
# ─────────────────────────────────────────────────────────────────────────────

class TestCANLedBase:
    """In base mode, CAN blue LED is always off."""

    def test_can_led_always_off_in_base_mode(self):
        sm = LEDStateMachine(is_car=False)
        changes = sm.tick(now=1.0, poe_ok=True, can_rx=True,
                          status_heartbeats=NO_HEARTBEATS)
        assert changes.get(PIN_CAN_BLUE) is None  # no change (already off)

    def test_can_led_turns_off_if_somehow_on(self):
        sm = LEDStateMachine(is_car=False)
        sm.can_led_on = True  # force an inconsistent state
        changes = sm.tick(now=1.0, poe_ok=True, can_rx=False,
                          status_heartbeats=NO_HEARTBEATS)
        assert changes[PIN_CAN_BLUE] is False


# ─────────────────────────────────────────────────────────────────────────────
# CAN LED — car mode, data flowing
# ─────────────────────────────────────────────────────────────────────────────

class TestCANLedCarActive:
    """In car mode with CAN data flowing, blue LED is solid on."""

    def test_can_rx_turns_led_on(self):
        sm = LEDStateMachine(is_car=True)
        changes = sm.tick(now=1.0, poe_ok=True, can_rx=True,
                          status_heartbeats=NO_HEARTBEATS)
        assert changes[PIN_CAN_BLUE] is True

    def test_can_rx_stays_on_while_active(self):
        sm = LEDStateMachine(is_car=True)
        sm.tick(now=1.0, poe_ok=True, can_rx=True,
                status_heartbeats=NO_HEARTBEATS)
        # Another tick within timeout, no new rx
        changes = sm.tick(now=1.0 + CAN_TIMEOUT * 0.5, poe_ok=True,
                          can_rx=False, status_heartbeats=NO_HEARTBEATS)
        # No change — LED should remain on
        assert PIN_CAN_BLUE not in changes

    def test_can_led_solid_through_continuous_rx(self):
        sm = LEDStateMachine(is_car=True)
        sm.tick(now=1.0, poe_ok=True, can_rx=True,
                status_heartbeats=NO_HEARTBEATS)
        # Continuous CAN frames
        for t in [1.1, 1.2, 1.3, 1.5, 2.0]:
            changes = sm.tick(now=t, poe_ok=True, can_rx=True,
                              status_heartbeats=NO_HEARTBEATS)
            assert changes.get(PIN_CAN_BLUE) is None  # no change, stays on


# ─────────────────────────────────────────────────────────────────────────────
# CAN LED — car mode, idle (double-flash pattern)
# ─────────────────────────────────────────────────────────────────────────────

class TestCANLedCarIdle:
    """In car mode with no CAN data, blue LED does double-flash pattern."""

    def test_idle_starts_with_flash_on(self):
        sm = LEDStateMachine(is_car=True)
        # Seed idle_step_time so the pattern starts cleanly
        sm.idle_step_time = 1.0
        changes = sm.tick(now=1.0, poe_ok=True, can_rx=False,
                          status_heartbeats=NO_HEARTBEATS)
        assert changes[PIN_CAN_BLUE] is True  # first flash on

    def test_idle_first_flash_off(self):
        sm = LEDStateMachine(is_car=True)
        sm.idle_step_time = 1.0
        sm.tick(now=1.0, poe_ok=True, can_rx=False,
                status_heartbeats=NO_HEARTBEATS)
        # After CAN_FLASH_ON, should go off
        changes = sm.tick(now=1.0 + CAN_FLASH_ON + 0.001, poe_ok=True,
                          can_rx=False, status_heartbeats=NO_HEARTBEATS)
        assert changes[PIN_CAN_BLUE] is False

    def test_idle_second_flash_on(self):
        sm = LEDStateMachine(is_car=True)
        sm.tick(now=1.0, poe_ok=True, can_rx=False,
                status_heartbeats=NO_HEARTBEATS)
        t = 1.0 + CAN_FLASH_ON + 0.001
        sm.tick(now=t, poe_ok=True, can_rx=False,
                status_heartbeats=NO_HEARTBEATS)
        # After gap, second flash on
        changes = sm.tick(now=t + CAN_FLASH_GAP + 0.001, poe_ok=True,
                          can_rx=False, status_heartbeats=NO_HEARTBEATS)
        assert changes[PIN_CAN_BLUE] is True

    def test_idle_pause_after_second_flash(self):
        sm = LEDStateMachine(is_car=True)
        t = 1.0
        sm.tick(now=t, poe_ok=True, can_rx=False,
                status_heartbeats=NO_HEARTBEATS)
        t += CAN_FLASH_ON + 0.001
        sm.tick(now=t, poe_ok=True, can_rx=False,
                status_heartbeats=NO_HEARTBEATS)
        t += CAN_FLASH_GAP + 0.001
        sm.tick(now=t, poe_ok=True, can_rx=False,
                status_heartbeats=NO_HEARTBEATS)
        # After second flash, pause (off)
        t += CAN_FLASH_ON + 0.001
        changes = sm.tick(now=t, poe_ok=True, can_rx=False,
                          status_heartbeats=NO_HEARTBEATS)
        assert changes[PIN_CAN_BLUE] is False

    def test_transition_from_active_to_idle(self):
        sm = LEDStateMachine(is_car=True)
        # Active
        sm.tick(now=1.0, poe_ok=True, can_rx=True,
                status_heartbeats=NO_HEARTBEATS)
        assert sm.can_led_on is True
        # Timeout — go idle
        changes = sm.tick(now=1.0 + CAN_TIMEOUT + 0.01, poe_ok=True,
                          can_rx=False, status_heartbeats=NO_HEARTBEATS)
        # Idle resets pattern; first step is flash on — but LED was already on
        # so it stays on (no change) until first flash duration passes
        # Then it goes off
        assert sm.can_active is False


# ─────────────────────────────────────────────────────────────────────────────
# Status LEDs
# ─────────────────────────────────────────────────────────────────────────────

class TestStatusLEDs:
    """Status LEDs turn on with heartbeat, off after timeout."""

    def test_heartbeat_turns_led_on(self):
        sm = LEDStateMachine(is_car=False)
        changes = sm.tick(now=1.0, poe_ok=True, can_rx=False,
                          status_heartbeats={PIN_TELEMETRY: True})
        assert changes[PIN_TELEMETRY] is True

    def test_repeated_heartbeat_no_change(self):
        sm = LEDStateMachine(is_car=False)
        sm.tick(now=1.0, poe_ok=True, can_rx=False,
                status_heartbeats={PIN_TELEMETRY: True})
        changes = sm.tick(now=2.0, poe_ok=True, can_rx=False,
                          status_heartbeats={PIN_TELEMETRY: True})
        assert PIN_TELEMETRY not in changes  # already on

    def test_led_off_after_timeout(self):
        sm = LEDStateMachine(is_car=False)
        sm.tick(now=1.0, poe_ok=True, can_rx=False,
                status_heartbeats={PIN_AUDIO: True})
        # No heartbeat, past timeout
        changes = sm.tick(now=1.0 + STATUS_TIMEOUT + 0.1, poe_ok=True,
                          can_rx=False, status_heartbeats=NO_HEARTBEATS)
        assert changes[PIN_AUDIO] is False

    def test_led_stays_on_within_timeout(self):
        sm = LEDStateMachine(is_car=False)
        sm.tick(now=1.0, poe_ok=True, can_rx=False,
                status_heartbeats={PIN_VIDEO: True})
        changes = sm.tick(now=1.0 + STATUS_TIMEOUT * 0.5, poe_ok=True,
                          can_rx=False, status_heartbeats=NO_HEARTBEATS)
        assert PIN_VIDEO not in changes  # still on, no change

    def test_multiple_status_leds_independent(self):
        sm = LEDStateMachine(is_car=False)
        sm.tick(now=1.0, poe_ok=True, can_rx=False,
                status_heartbeats={PIN_TELEMETRY: True, PIN_WEBSOCKET: True})
        # Only telemetry heartbeat continues
        sm.tick(now=2.0, poe_ok=True, can_rx=False,
                status_heartbeats={PIN_TELEMETRY: True})
        # Websocket times out, telemetry stays
        changes = sm.tick(now=1.0 + STATUS_TIMEOUT + 0.1, poe_ok=True,
                          can_rx=False,
                          status_heartbeats={PIN_TELEMETRY: True})
        assert changes[PIN_WEBSOCKET] is False
        assert PIN_TELEMETRY not in changes  # still on


# ─────────────────────────────────────────────────────────────────────────────
# Combined scenarios
# ─────────────────────────────────────────────────────────────────────────────

class TestCombined:
    """Test interactions between CAN, status, and PoE logic."""

    def test_car_mode_all_active(self):
        sm = LEDStateMachine(is_car=True)
        all_hb = {PIN_TELEMETRY: True, PIN_WEBSOCKET: True,
                  PIN_AUDIO: True, PIN_VIDEO: True}
        changes = sm.tick(now=1.0, poe_ok=True, can_rx=True,
                          status_heartbeats=all_hb)
        assert changes[PIN_CAN_BLUE] is True
        assert changes[PIN_TELEMETRY] is True
        assert changes[PIN_WEBSOCKET] is True
        assert changes[PIN_AUDIO] is True
        assert changes[PIN_VIDEO] is True

    def test_base_mode_no_can_with_status(self):
        sm = LEDStateMachine(is_car=False)
        changes = sm.tick(now=1.0, poe_ok=True, can_rx=True,
                          status_heartbeats={PIN_WEBSOCKET: True})
        assert PIN_CAN_BLUE not in changes  # base mode, stays off
        assert changes[PIN_WEBSOCKET] is True

    def test_poe_error_then_recovery_then_normal(self):
        sm = LEDStateMachine(is_car=True)
        # PoE error
        changes = sm.tick(now=1.0, poe_ok=False, can_rx=False,
                          status_heartbeats=NO_HEARTBEATS)
        assert all(changes.get(pin) is True for pin in ALL_PINS)

        # Recovery
        changes = sm.tick(now=2.0, poe_ok=True, can_rx=False,
                          status_heartbeats=NO_HEARTBEATS)
        assert all(changes.get(pin) is False for pin in ALL_PINS)

        # Normal CAN activity resumes
        changes = sm.tick(now=2.1, poe_ok=True, can_rx=True,
                          status_heartbeats={PIN_TELEMETRY: True})
        assert changes[PIN_CAN_BLUE] is True
        assert changes[PIN_TELEMETRY] is True

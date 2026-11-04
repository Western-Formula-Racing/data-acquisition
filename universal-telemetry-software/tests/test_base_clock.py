"""A base station without internet must not overwrite the car's clock."""

import pytest

from src import data, utils


@pytest.mark.parametrize(
    "requires_sync, synced, allowed",
    [
        (False, False, True),  # laptop stacks: unchanged
        (False, None, True),
        (True, True, True),  # Pi base with internet
        (True, False, False),  # Pi base at the track
        (True, None, False),  # can't tell: don't risk a good clock on the car
    ],
)
def test_base_clock_may_set_car(monkeypatch, requires_sync, synced, allowed):
    monkeypatch.setattr(utils, "clock_is_ntp_synced", lambda: synced)

    assert data.base_clock_may_set_car(requires_sync) is allowed


class _FakeLibc:
    def __init__(self, state):
        self.state = state

    def adjtimex(self, _buffer):
        if isinstance(self.state, Exception):
            raise self.state
        return self.state


@pytest.mark.parametrize(
    "state, expected",
    [
        (0, True),  # TIME_OK
        (5, False),  # TIME_ERROR: unsynchronized
        (-1, None),  # the call failed
        (AttributeError("no adjtimex"), None),  # not Linux
    ],
)
def test_clock_is_ntp_synced_reads_the_kernel_state(monkeypatch, state, expected):
    monkeypatch.setattr(utils.ctypes, "CDLL", lambda _name: _FakeLibc(state))

    assert utils.clock_is_ntp_synced() is expected

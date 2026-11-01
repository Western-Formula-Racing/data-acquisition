"""
Unit test for retransmission request-slice behavior.

Reproduces the gap-detection + missing_reporter request-slice logic
from data.py without needing sockets, Redis, or Docker.

The request slice uses sorted()[:100] (oldest first) so that gaps
closest to aging out of the car's 60s ring buffer get priority.
"""
import pytest


def simulate_gap_detection(seq_stream: list[int]):
    """Replay the base receiver's gap-detection state machine.

    Returns the final (missing_seqs, expected_seq) after processing all seqs.
    This mirrors data.py lines 618-655 exactly.
    """
    expected_seq = None
    missing_seqs: set[int] = set()

    for seq in seq_stream:
        if expected_seq is None:
            expected_seq = seq
        if expected_seq is not None and seq < expected_seq - 1000:
            expected_seq = seq
            missing_seqs.clear()
        if seq > expected_seq:
            for s in range(expected_seq, seq):
                missing_seqs.add(s)
                if len(missing_seqs) > 1000:
                    oldest = min(missing_seqs)
                    missing_seqs.remove(oldest)
        elif seq < expected_seq:
            if seq in missing_seqs:
                missing_seqs.remove(seq)
            else:
                continue
        expected_seq = max(expected_seq, seq + 1)

    return missing_seqs, expected_seq


def simulate_request_slice(missing_seqs: set[int]) -> list[int]:
    """The exact line from missing_reporter: sorted(list(missing_seqs))[:100]"""
    return sorted(list(missing_seqs))[:100]


class TestOldestFirstRecovery:
    """Verify oldest-first request slice prevents starvation."""

    def test_small_gap_all_requested(self):
        """<=100 missing seqs: everything gets requested."""
        missing = set(range(10, 60))
        requested = simulate_request_slice(missing)
        assert set(requested) == missing

    def test_large_gap_oldest_requested_first(self):
        """>100 missing: oldest 100 are requested, not newest."""
        missing = set(range(10, 210))  # 200 missing
        requested = simulate_request_slice(missing)

        assert len(requested) == 100
        assert set(requested) == set(range(10, 110))

    def test_single_burst_self_heals(self):
        """A burst of 200 missing seqs recovers fully in 2 cycles."""
        missing = set(range(10, 210))

        # Cycle 1: oldest 100 recovered
        requested = simulate_request_slice(missing)
        assert set(requested) == set(range(10, 110))
        missing -= set(requested)

        # Cycle 2: remaining 100 recovered
        requested = simulate_request_slice(missing)
        assert set(requested) == set(range(110, 210))
        missing -= set(requested)
        assert len(missing) == 0

    def test_sustained_loss_old_gaps_still_recovered(self):
        """
        Under sustained loss (>100 new gaps per cycle), oldest-first
        ensures old gaps are recovered before they age out of the
        car's ring buffer.
        """
        missing = set(range(100, 150))  # 50 old gaps
        next_seq = 200

        for cycle in range(3):
            for s in range(next_seq, next_seq + 120):
                missing.add(s)
            next_seq += 140

            requested = simulate_request_slice(missing)
            missing -= set(requested)

        old_remaining = missing & set(range(100, 150))
        assert len(old_remaining) == 0, (
            "Oldest-first should recover old gaps even under sustained loss"
        )

    def test_sustained_loss_newest_delayed_not_lost(self):
        """
        Under sustained loss, newest gaps are delayed (not requested
        immediately) but eventually get their turn as older ones clear.
        """
        missing = set(range(100, 150))  # 50 old
        next_seq = 200
        all_ever_missing: set[int] = set(missing)

        for cycle in range(10):
            new_gaps = set(range(next_seq, next_seq + 120))
            missing |= new_gaps
            all_ever_missing |= new_gaps
            next_seq += 140

            requested = simulate_request_slice(missing)
            missing -= set(requested)

        # The set grows but oldest are always drained first.
        # With 120 new per cycle and 100 recovered, net growth is 20/cycle.
        # After 10 cycles: 200 remaining (all from recent cycles).
        # None of the old (100-149) should remain.
        old_remaining = missing & set(range(100, 150))
        assert len(old_remaining) == 0

    def test_1000_cap_evicts_oldest(self):
        """
        The missing set cap at 1000 still evicts the oldest seqs.
        This is a separate mechanism from the request slice.
        """
        stream = [0, 1501]
        missing, _ = simulate_gap_detection(stream)

        assert len(missing) <= 1000
        assert min(missing) == 501


class TestRecoveryRemovesFromMissing:
    """Verify that successful recovery correctly shrinks the missing set."""

    def test_recovery_removes_seq(self):
        missing = set(range(10, 20))
        missing.remove(15)
        assert 15 not in missing
        assert len(missing) == 9

    def test_full_recovery_empties_set(self):
        missing = set(range(10, 20))
        for seq in range(10, 20):
            missing.discard(seq)
        assert len(missing) == 0

"""Unit tests for soc_model (data-derived SOC/ETA). Run: python3 -m unittest -v"""

import time
import unittest

from soc_model import estimate_soc_and_eta, _soc_from_voltage, _CV_TAPER


def _series(start_v, end_v, n=6, span_s=600, **extra):
    """Build a chronological history ramping min_cell_v from start to end."""
    now = time.time()
    out = []
    for i in range(n):
        v = start_v + (end_v - start_v) * i / (n - 1)
        out.append({
            "t": now - span_s + i * (span_s / (n - 1)),
            "current_a": -3276, "pack_v": None, "soc": 0,   # dead sentinels
            "min_cell_v": round(v, 4), "avg_cell_v": round(v + 0.02, 4),
            "max_cell_v": round(v + 0.05, 4), **extra,
        })
    return out


class TestOcvCurve(unittest.TestCase):
    def test_monotonic_and_bounded(self):
        prev = -1
        for mv in range(280, 430, 2):
            soc = _soc_from_voltage(mv / 100)
            self.assertGreaterEqual(soc, 0.0)
            self.assertLessEqual(soc, 100.0)
            self.assertGreaterEqual(soc + 1e-9, prev)  # non-decreasing
            prev = soc

    def test_anchors(self):
        self.assertEqual(_soc_from_voltage(2.5), 0.0)
        self.assertEqual(_soc_from_voltage(4.3), 100.0)
        self.assertAlmostEqual(_soc_from_voltage(3.85), 50.0, delta=2.0)


class TestPhaseAndEta(unittest.TestCase):
    def test_empty_history(self):
        out = estimate_soc_and_eta([])
        self.assertEqual(out["phase"], "idle")
        self.assertIsNone(out["eta_min_to_full"])

    def test_rising_midband_is_cc_with_eta(self):
        out = estimate_soc_and_eta(_series(3.80, 3.88))
        self.assertEqual(out["phase"], "CC")
        self.assertIsNotNone(out["eta_min_to_full"])
        self.assertGreater(out["eta_min_to_full"], 0)
        self.assertEqual(out["method"], "ocv-mincell")  # dead BMS soc ignored

    def test_rising_near_top_is_cv_and_slower(self):
        cc = estimate_soc_and_eta(_series(3.80, 3.88))
        cv = estimate_soc_and_eta(_series(4.00, 4.05))
        self.assertEqual(cv["phase"], "CV")
        # CV taper makes per-percent time longer near the top.
        self.assertGreater(_CV_TAPER(98.0), _CV_TAPER(50.0))

    def test_falling_is_idle_no_eta(self):
        out = estimate_soc_and_eta(_series(3.95, 3.80))
        self.assertEqual(out["phase"], "idle")
        self.assertIsNone(out["eta_min_to_full"])

    def test_full_when_topped_out(self):
        out = estimate_soc_and_eta(_series(4.10, 4.12))
        self.assertEqual(out["phase"], "full")
        self.assertEqual(out["eta_min_to_full"], 0.0)

    def test_real_bms_soc_preferred_when_valid(self):
        out = estimate_soc_and_eta(_series(3.80, 3.88, soc=72.0))
        self.assertEqual(out["method"], "bms")
        self.assertAlmostEqual(out["soc_pct"], 72.0, delta=0.1)


if __name__ == "__main__":
    unittest.main()

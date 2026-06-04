"""Unit tests for charge_dashboard (renderer, session manager, HTTP receiver).
Run: python3 -m unittest -v"""

import json
import unittest
import urllib.error
import urllib.request

import charge_dashboard as cd


def _module(mid, base, low_at=None):
    cells = [round(base, 3)] * 20
    if low_at is not None:
        cells[low_at] = round(base - 0.20, 3)
    return {
        "id": mid, "cells": cells,
        "avg": round(sum(cells) / 20, 2), "min": round(min(cells), 2),
        "max": round(max(cells), 2),
        "delta_mv": round((max(cells) - min(cells)) * 1000), "tmax": 38.0,
    }


def _snap(session="s1"):
    mods = [_module(m, 3.85, low_at=(9 if m == "M3" else None))
            for m in ("M1", "M2", "M3", "M4", "M5")]
    allc = [c for m in mods for c in m["cells"]]
    return {
        "session": session, "elapsed_s": 872, "current_a": None, "pack_v": sum(allc),
        "avg_v": sum(allc) / len(allc), "delta_mv": 200, "soc": None,
        "min_cell": {"v": min(allc), "label": "M3·C10"},
        "max_cell": {"v": max(allc), "label": "M1·C1"},
        "max_temp": {"c": 41.2, "label": "M4·T7"}, "min_temp": {"c": 29.8},
        "alerts": {"voltdelta": "warn", "temp": "ok", "bal": "ok", "low": "ok"},
        "modules": mods,
    }


class TestFormatters(unittest.TestCase):
    def test_bar_bounds_and_fill(self):
        self.assertEqual(cd._bar(0, 10), "░" * 10)
        self.assertEqual(cd._bar(100, 10), "▓" * 10)
        self.assertEqual(cd._bar(50, 10).count("▓"), 5)
        self.assertEqual(len(cd._bar(150, 20)), 20)  # clamps, fixed width

    def test_spark_marks_dragging_cell_low(self):
        cells = [3.85] * 20
        cells[9] = 3.65
        s = cd._spark(cells, lo=3.65, hi=3.85)
        self.assertEqual(len(s), 20)
        self.assertEqual(s[9], "▁")          # min → lowest block
        self.assertEqual(s[0], cd._BLOCKS[-1])  # max → highest block

    def test_eta_str(self):
        self.assertEqual(cd._eta_str(None), "—")
        self.assertIn("m to full", cd._eta_str(37.0))
        self.assertIn("h to full", cd._eta_str(150.0))


class TestRender(unittest.TestCase):
    def test_render_contains_expected_sections(self):
        derived = {"soc_pct": 68.0, "phase": "CC", "eta_min_to_full": 37.0}
        text = cd.render_dashboard(_snap(), derived, 37.0, "charging")
        self.assertIn("🔋", text)
        self.assertIn("*Charging*", text)
        self.assertIn("```", text)
        self.assertIn("SoC", text)
        self.assertIn("CC", text)          # phase shown instead of dead amperage
        self.assertNotIn(" A  ·", text)    # no amperage column
        for mid in ("M1", "M2", "M3", "M4", "M5"):
            self.assertIn(mid, text)
        self.assertIn("▁", text)           # dragging M3 cell rendered low


class FakeWeb:
    def __init__(self):
        self.posts, self.updates = [], []

    def chat_postMessage(self, channel, text, mrkdwn=True):
        self.posts.append((channel, text))
        return {"ts": "1700000000.000100"}

    def chat_update(self, channel, ts, text, mrkdwn=True):
        self.updates.append((channel, ts, text))
        return {"ok": True}


class TestSessionManager(unittest.TestCase):
    def test_posts_once_then_updates_in_place(self):
        web = FakeWeb()
        dash = cd.ChargeDashboard(web, default_channel="C123")
        dash.handle(_snap("sess-A"))
        dash.handle(_snap("sess-A"))
        dash.handle(_snap("sess-A"))
        self.assertEqual(len(web.posts), 1)       # one message created
        self.assertEqual(len(web.updates), 2)     # edited in place thereafter
        self.assertEqual(web.updates[0][1], "1700000000.000100")  # same ts

    def test_missing_session_id_is_ignored(self):
        web = FakeWeb()
        dash = cd.ChargeDashboard(web, default_channel="C123")
        dash.handle({"modules": []})  # no "session"
        self.assertEqual(web.posts, [])


class TestHttpReceiver(unittest.TestCase):
    def setUp(self):
        self.web = FakeWeb()
        self.dash = cd.ChargeDashboard(self.web, default_channel="C123")
        self.server = cd.start_http_server(self.dash, port=0, token="secret")
        self.port = self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def _post(self, path, body, token=None):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["X-Charge-Token"] = token
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}{path}",
            data=json.dumps(body).encode(), headers=headers, method="POST",
        )
        return urllib.request.urlopen(req, timeout=5)

    def test_healthz(self):
        resp = urllib.request.urlopen(f"http://127.0.0.1:{self.port}/healthz", timeout=5)
        self.assertEqual(resp.status, 200)

    def test_authorized_post_accepted(self):
        resp = self._post("/charging/state", _snap("http-A"), token="secret")
        self.assertEqual(resp.status, 200)
        self.assertEqual(len(self.web.posts), 1)

    def test_wrong_token_rejected(self):
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            self._post("/charging/state", _snap("http-B"), token="nope")
        self.assertEqual(ctx.exception.code, 401)
        self.assertEqual(self.web.posts, [])


if __name__ == "__main__":
    unittest.main()

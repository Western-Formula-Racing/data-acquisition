import re
import subprocess
from pathlib import Path


STATUS_PAGE = Path(__file__).resolve().parents[1] / "status" / "index.html"


def test_link_health_mosaic_advances_one_second_without_new_stats(tmp_path):
    html = STATUS_PAGE.read_text()
    script = re.search(r"<script>(.*?)</script>", html, re.S).group(1)
    runner = tmp_path / "mosaic_test.js"
    runner.write_text(
        """
const vm = require('vm');
const script = process.argv[2];
const intervalCallbacks = [];
const timeoutCallbacks = [];
const fills = [];
let now = 1000;
class FakeDate extends Date {
  static now() { return now; }
}
const elements = new Map();
const canvas = {
  offsetWidth: 600,
  offsetHeight: 180,
  width: 0,
  height: 0,
  getContext() {
    return {
      clearRect() {},
      fillRect(x, y, width, height) { fills.push({ x, y, width, height, color: this.fillStyle }); },
      fillStyle: '',
    };
  },
};

function element(id) {
  if (id === 'healthMosaic') return canvas;
  if (!elements.has(id)) {
    elements.set(id, {
      textContent: '',
      value: '',
      style: {},
      className: '',
      classList: { toggle() {}, add() {}, remove() {} },
      addEventListener() {},
    });
  }
  return elements.get(id);
}

const context = {
  console,
  Date: FakeDate,
  JSON,
  Math,
  Map,
  WebSocket: function() {},
  fetch: async () => ({ json: async () => ({}), ok: true }),
  setTimeout(fn, ms) { timeoutCallbacks.push({ fn, ms }); return timeoutCallbacks.length; },
  setInterval(fn, ms) { intervalCallbacks.push({ fn, ms }); return intervalCallbacks.length; },
  window: { location: { hostname: 'localhost' }, addEventListener() {} },
  document: {
    getElementById: element,
    querySelector: () => element('query'),
  },
  navigator: { clipboard: { writeText: async () => {} } },
};
context.globalThis = context;
context.window.setInterval = context.setInterval;
context.window.setTimeout = context.setTimeout;

vm.createContext(context);
vm.runInContext(script, context);
context.updateStats({ second_buffer: Array(60).fill(1), car_alive: true, received: 50, missing: 0, recovered: 0, messages: 0 });
const before = vm.runInContext('secondBuffer.slice()', context);

const oneSecondTick = intervalCallbacks.find(callback => callback.ms === 1000);
if (!oneSecondTick) throw new Error('missing one-second mosaic timer');
fills.length = 0;
oneSecondTick.fn();

const after = vm.runInContext('secondBuffer.slice()', context);
if (before.length !== 60) throw new Error(`expected 60 cells before tick, got ${before.length}`);
if (after.length !== 60) throw new Error(`expected 60 cells after tick, got ${after.length}`);
if (!after.every(value => value === 1)) throw new Error('existing second buffer was not preserved');
if (fills.length !== 60) throw new Error(`expected 60 drawn columns, got ${fills.length}`);
if (fills[59].color !== '#374151') throw new Error(`newest column should pulse visibly, got ${fills[59].color}`);
const pulseClear = timeoutCallbacks.find(callback => callback.ms === 180);
if (!pulseClear) throw new Error('pulse should schedule a redraw when it expires');
now = 1200;
fills.length = 0;
pulseClear.fn();
if (fills[59].color !== '#4ade80') throw new Error(`pulse should clear back to ok color after expiry, got ${fills[59].color}`);
"""
    )

    result = subprocess.run(
        ["node", str(runner), script],
        text=True,
        capture_output=True,
    )

    assert result.returncode == 0, result.stderr

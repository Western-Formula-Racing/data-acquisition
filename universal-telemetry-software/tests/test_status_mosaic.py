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
context.updateStats({ status_buffer: Array(50).fill(1), received: 50, missing: 0, recovered: 0, messages: 0 });
const before = vm.runInContext('packetHistory.slice()', context);

const oneSecondTick = intervalCallbacks.find(callback => callback.ms === 1000);
if (!oneSecondTick) throw new Error('missing one-second mosaic timer');
oneSecondTick.fn();

const after = vm.runInContext('packetHistory', context);
if (before.length !== 50) throw new Error(`expected 50 cells before tick, got ${before.length}`);
if (after.length !== 100) throw new Error(`expected 100 cells after tick, got ${after.length}`);
if (!after.slice(0, 50).every(value => value === 1)) throw new Error('existing packet history was not preserved');
if (!after.slice(50).every(value => value === undefined)) throw new Error('new second should be idle cells');
if (!fills.slice(-50).every(fill => fill.color === '#374151')) throw new Error('newest idle column should pulse visibly');
const pulseClear = timeoutCallbacks.find(callback => callback.ms === 180);
if (!pulseClear) throw new Error('pulse should schedule a redraw when it expires');
now = 1200;
fills.length = 0;
pulseClear.fn();
if (fills.slice(-50).some(fill => fill.color === '#374151')) throw new Error('pulse should clear after expiry');
"""
    )

    result = subprocess.run(
        ["node", str(runner), script],
        text=True,
        capture_output=True,
    )

    assert result.returncode == 0, result.stderr

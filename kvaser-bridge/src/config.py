import json
import platform
from pathlib import Path

# ---------------------------------------------------------------------------
# CAN bitrate options
# ---------------------------------------------------------------------------
BITRATE_OPTIONS = [10_000, 20_000, 50_000, 100_000, 125_000, 250_000, 500_000, 800_000, 1_000_000]
BITRATE_LABELS  = ['10k', '20k', '50k', '100k', '125k', '250k', '500k', '800k', '1M']

DEFAULT_BITRATE  = 500_000
DEFAULT_CHANNEL  = 0

# ---------------------------------------------------------------------------
# CAN interface (auto-selected per platform)
# ---------------------------------------------------------------------------
# Linux uses socketcan (kernel driver, no CANlib needed)
# Windows uses kvaser (requires Kvaser CANlib SDK)
DEFAULT_CAN_INTERFACE = 'socketcan' if platform.system() == 'Linux' else 'kvaser'
# socketcan channel name (e.g. 'can0'); kvaser uses integer channel index
DEFAULT_SOCKETCAN_CHANNEL = 'can0'

# ---------------------------------------------------------------------------
# WebSocket server (bridge runs its own server, dashboard connects to it)
# ---------------------------------------------------------------------------
DEFAULT_WS_PORT = 9080

# ---------------------------------------------------------------------------
# Config file location
# ---------------------------------------------------------------------------
def _config_dir() -> Path:
    if platform.system() == 'Windows':
        base = Path.home() / 'AppData' / 'Roaming'
    else:
        base = Path.home() / '.config'
    return base / 'kvaser-bridge'

CONFIG_PATH = _config_dir() / 'config.json'

_DEFAULTS = {
    'channel': DEFAULT_CHANNEL,
    'bitrate': DEFAULT_BITRATE,
    'ws_port': DEFAULT_WS_PORT,
}

def load() -> dict:
    try:
        with open(CONFIG_PATH) as f:
            data = json.load(f)
        return {**_DEFAULTS, **data}
    except Exception:
        return dict(_DEFAULTS)

def save(cfg: dict) -> None:
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(CONFIG_PATH, 'w') as f:
        json.dump(cfg, f, indent=2)

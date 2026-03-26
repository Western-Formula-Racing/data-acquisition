"""
Kvaser Bridge modern TUI using Textual.

Provides:
  - Tabbed interface
  - Editable text boxes for channel/bitrate/port
  - Action buttons (Apply/Start-Stop/Quit)
  - Live status + event log
"""

from __future__ import annotations

import asyncio
import importlib
import socket
from typing import Any, Callable

import config
from bridge import Bridge, BridgeState

def _create_modern_tui_app(*, bridge: Bridge, loop: asyncio.AbstractEventLoop, num_channels: int,
                           initial_channel: int, initial_bitrate: int, initial_ws_port: int,
                           initial_can_interface: str = '') -> Any:
    try:
        App = importlib.import_module('textual.app').App
        Horizontal = importlib.import_module('textual.containers').Horizontal
        Vertical = importlib.import_module('textual.containers').Vertical
        widgets = importlib.import_module('textual.widgets')
    except ModuleNotFoundError as exc:
        raise RuntimeError(
            'Textual is required for --tui mode. Install dependencies with: pip install -r requirements.txt'
        ) from exc

    Button = widgets.Button
    Footer = widgets.Footer
    Header = widgets.Header
    Input = widgets.Input
    Label = widgets.Label
    RichLog = widgets.RichLog
    Static = widgets.Static
    TabbedContent = widgets.TabbedContent
    TabPane = widgets.TabPane

    class ModernBridgeTui(App):
        CSS = """
        Screen {
            background: #120c06;
            color: #f8d8b4;
        }

        Header {
            background: #2b1407;
            color: #ffb058;
            text-style: bold;
        }

        Footer {
            background: #2b1407;
            color: #ffd7a6;
        }

        TabbedContent {
            border: round #ff8f1f;
            background: #1a0f08;
            padding: 0 1;
        }

        TabPane {
            padding: 1 1;
        }

        .title {
            color: #ff9f35;
            text-style: bold;
            margin: 0 0 1 0;
        }

        Input {
            border: tall #c66a1c;
            background: #211208;
            color: #ffe1c0;
            margin: 0 0 1 0;
        }

        Button {
            margin-right: 1;
        }

        Button.-primary {
            background: #b45309;
            color: #fff3e4;
            text-style: bold;
        }

        #btn-toggle {
            background: #ea580c;
            color: #fff3e4;
        }

        #btn-quit {
            background: #7f1d1d;
            color: #ffd9d9;
        }

        #control-message {
            color: #ffd7a6;
            border: round #7c4a1f;
            background: #1e120b;
            padding: 0 1;
            margin-top: 1;
            min-height: 3;
        }

        #status-summary {
            border: round #ff8f1f;
            background: #1e1108;
            color: #ffd7a6;
            padding: 0 1;
            margin-bottom: 1;
        }

        #event-log {
            border: round #8f4e1d;
            background: #1a1009;
            color: #ffd7a6;
        }
        """

        BINDINGS = [
            ('q', 'quit_app', 'Quit'),
            ('ctrl+c', 'quit_app', 'Quit'),
            ('s', 'toggle_bridge', 'Start/Stop'),
        ]

        def __init__(self) -> None:
            super().__init__()
            self._bridge = bridge
            self._loop = loop
            self._num_channels = max(1, num_channels)
            self._channel = max(0, min(initial_channel, self._num_channels - 1))
            self._bitrate = initial_bitrate
            self._ws_port = initial_ws_port
            self._can_interface = initial_can_interface or config.DEFAULT_CAN_INTERFACE
            self._host = self._resolve_local_ip()
            self._last_snapshot = None

        def compose(self):
            yield Header(show_clock=True)
            with TabbedContent(id='tabs'):
                with TabPane('Control', id='tab-control'):
                    with Vertical():
                        yield Label('Orange Blaze Control Deck', classes='title')
                        yield Input(value=self._can_interface, placeholder='CAN interface (e.g. vcan, socketcan)', id='input-interface')
                        yield Input(value=str(self._channel), placeholder='CAN channel index', id='input-channel')
                        yield Input(value=str(self._bitrate), placeholder='CAN bitrate (e.g. 500000)', id='input-bitrate')
                        yield Input(value=str(self._ws_port), placeholder='WebSocket port', id='input-ws-port')
                        with Horizontal():
                            yield Button('Apply Settings', id='btn-apply', classes='-primary')
                            yield Button('Start Bridge', id='btn-toggle')
                            yield Button('Quit', id='btn-quit')
                        yield Static('', id='control-message')
                with TabPane('Status', id='tab-status'):
                    yield Label('Live Telemetry Status', classes='title')
                    yield Static('', id='status-summary')
                    yield RichLog(id='event-log', wrap=True, markup=True, highlight=True)
                with TabPane('Help', id='tab-help'):
                    yield Label('Keyboard + Usage', classes='title')
                    yield Static(
                        'Shortcuts:\n'
                        '- [b]s[/b]: start/stop bridge\n'
                        '- [b]q[/b]: quit\n\n'
                        'Workflow:\n'
                        '1) Set channel, bitrate, and WS port in Control tab\n'
                        '2) Press Apply Settings\n'
                        '3) Press Start Bridge\n\n'
                        'Connect URL:\n'
                        f'wss://{self._host}:{self._ws_port}',
                    )
            yield Footer()

        def on_mount(self) -> None:
            self.set_interval(0.25, self._refresh_status)
            self._set_control_message('Ready. Configure settings and start the bridge.')
            self._refresh_status()

        def on_button_pressed(self, event):
            bid = event.button.id
            if bid == 'btn-apply':
                self._apply_settings()
            elif bid == 'btn-toggle':
                self._toggle_bridge()
            elif bid == 'btn-quit':
                self.action_quit_app()

        def action_toggle_bridge(self) -> None:
            self._toggle_bridge()

        def action_quit_app(self) -> None:
            self.exit()

        def _toggle_bridge(self) -> None:
            status = self._bridge.get_status()
            if status.state == BridgeState.OPEN:
                asyncio.run_coroutine_threadsafe(self._bridge.stop(), self._loop)
                self._set_control_message('Stopping bridge...')
                return

            if not self._apply_settings(silent=True):
                return
            asyncio.run_coroutine_threadsafe(self._bridge.start(), self._loop)
            self._set_control_message('Starting bridge...')

        def _apply_settings(self, silent: bool = False) -> bool:
            status = self._bridge.get_status()
            if status.state == BridgeState.OPEN:
                if not silent:
                    self._set_control_message('Stop the bridge before applying config changes.')
                return False

            iface = self.query_one('#input-interface', Input).value.strip()
            if iface not in config.SUPPORTED_CAN_INTERFACES:
                valid = ', '.join(sorted(config.SUPPORTED_CAN_INTERFACES))
                self._set_control_message(f'Unknown interface. Use one of: {valid}')
                return False

            try:
                channel = int(self.query_one('#input-channel', Input).value.strip())
                bitrate = int(self.query_one('#input-bitrate', Input).value.strip())
                ws_port = int(self.query_one('#input-ws-port', Input).value.strip())
            except ValueError:
                self._set_control_message('Invalid input. Channel/bitrate/port must be integers.')
                return False

            if channel < 0 or channel >= self._num_channels:
                self._set_control_message(f'Channel must be between 0 and {self._num_channels - 1}.')
                return False

            if bitrate not in config.BITRATE_OPTIONS:
                options = ', '.join(str(x) for x in config.BITRATE_OPTIONS)
                self._set_control_message(f'Unsupported bitrate. Use one of: {options}')
                return False

            if ws_port < 1 or ws_port > 65535:
                self._set_control_message('WS port must be between 1 and 65535.')
                return False

            self._can_interface = iface
            self._channel = channel
            self._bitrate = bitrate
            self._ws_port = ws_port

            self._bridge.set_can_interface(iface)
            self._bridge.set_channel(channel)
            self._bridge.set_bitrate(bitrate)
            self._bridge.set_ws_port(ws_port)

            self._set_control_message('Settings applied.')
            return True

        def _refresh_status(self) -> None:
            status = self._bridge.get_status()
            snapshot = (
                status.state,
                status.frames_rx,
                status.frames_tx,
                status.clients,
                status.error_msg,
                self._ws_port,
            )

            toggle = self.query_one('#btn-toggle', Button)
            if status.state == BridgeState.OPEN:
                toggle.label = 'Stop Bridge'
            else:
                toggle.label = 'Start Bridge'

            scheme = 'wss' if status.tls else 'ws'
            state_line = (
                f'State: {status.state.name}\n'
                f'Interface: {status.can_interface}\n'
                f'Frames RX: {status.frames_rx}  TX: {status.frames_tx}\n'
                f'Clients: {status.clients}\n'
                f'Connect URL: {scheme}://{self._host}:{self._ws_port}\n'
                f'Last Error: {status.error_msg or "-"}'
            )
            self.query_one('#status-summary', Static).update(state_line)

            if snapshot != self._last_snapshot:
                log = self.query_one('#event-log', RichLog)
                log.write(
                    f'[orange1]{status.state.name}[/] '
                    f'iface={status.can_interface} '
                    f'rx={status.frames_rx} tx={status.frames_tx} clients={status.clients} '
                    f'error={status.error_msg or "-"}'
                )
                self._last_snapshot = snapshot

        def _set_control_message(self, message: str) -> None:
            self.query_one('#control-message', Static).update(message)

        def _resolve_local_ip(self) -> str:
            try:
                sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                sock.connect(('8.8.8.8', 80))
                ip = sock.getsockname()[0]
                sock.close()
                return ip
            except Exception:
                return 'localhost'

    return ModernBridgeTui()


class TuiApp:
    def __init__(
        self,
        bridge: Bridge,
        loop: asyncio.AbstractEventLoop,
        num_channels: int,
        initial_channel: int,
        initial_bitrate: int,
        initial_ws_port: int,
        on_quit: Callable[[], None],
        can_interface: str = '',
    ) -> None:
        self._quit_cb = on_quit
        self._app = _create_modern_tui_app(
            bridge=bridge,
            loop=loop,
            num_channels=num_channels,
            initial_channel=initial_channel,
            initial_bitrate=initial_bitrate,
            initial_ws_port=initial_ws_port,
            initial_can_interface=can_interface,
        )

    def run(self) -> None:
        try:
            self._app.run()
        finally:
            self._quit_cb()

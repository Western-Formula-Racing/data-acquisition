"""
Kvaser Bridge GUI using tkinter (stdlib, no extra deps).

Small window with channel/bitrate/port config, start/stop, and status.
"""

from __future__ import annotations
import asyncio
import logging
import socket
import subprocess
import tkinter as tk
from tkinter import messagebox, ttk
from typing import Callable
import webbrowser

import platform as _platform

import config
from bridge import Bridge, BridgeState, BridgeStatus, CERT_FILE


def _platform_interfaces() -> list[str]:
    sys = _platform.system()
    if sys == 'Linux':
        return ['socketcan', 'vcan']
    if sys == 'Darwin':
        return ['maccan']
    return ['kvaser']

log = logging.getLogger(__name__)

_STATE_LABELS = {
    BridgeState.IDLE:  'Idle',
    BridgeState.OPEN:  'Active',
    BridgeState.ERROR: 'Error',
}

_STATE_COLORS = {
    BridgeState.IDLE:  '#888888',
    BridgeState.OPEN:  '#22c55e',
    BridgeState.ERROR: '#ef4444',
}


class TrayApp:
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
        self._bridge   = bridge
        self._loop     = loop
        self._quit_cb  = on_quit

        self._num_channels = max(num_channels, 1)

        self._root = tk.Tk()
        self._root.title('Kvaser Bridge')
        self._root.resizable(False, False)
        self._root.protocol('WM_DELETE_WINDOW', self._quit)

        # -- Variables --
        self._interface_var = tk.StringVar(value=can_interface or config.DEFAULT_CAN_INTERFACE)
        self._channel_var = tk.IntVar(value=initial_channel)
        self._bitrate_var = tk.IntVar(value=initial_bitrate)
        self._ws_port_var = tk.IntVar(value=initial_ws_port)
        self._status_text = tk.StringVar(value='Idle')
        self._rx_text     = tk.StringVar(value='0')
        self._tx_text     = tk.StringVar(value='0')
        self._clients_text = tk.StringVar(value='0')

        self._build_ui()

        bridge.on_status_change = self._on_status_change

    def _build_ui(self) -> None:
        root = self._root
        pad = {'padx': 8, 'pady': 4}

        # -- Config frame --
        cfg_frame = ttk.LabelFrame(root, text='Configuration')
        cfg_frame.pack(fill='x', **pad)

        # Interface
        ttk.Label(cfg_frame, text='Interface:').grid(row=0, column=0, sticky='w', padx=4, pady=2)
        iface_combo = ttk.Combobox(
            cfg_frame,
            textvariable=self._interface_var,
            values=_platform_interfaces(),
            state='readonly',
            width=20,
        )
        iface_combo.grid(row=0, column=1, padx=4, pady=2, sticky='ew')
        iface_combo.bind('<<ComboboxSelected>>', self._on_interface_change)
        self._iface_combo = iface_combo

        # Channel
        ttk.Label(cfg_frame, text='Channel:').grid(row=1, column=0, sticky='w', padx=4, pady=2)
        ch_combo = ttk.Combobox(
            cfg_frame,
            textvariable=self._channel_var,
            values=list(range(self._num_channels)),
            state='readonly',
            width=20,
        )
        ch_combo.grid(row=1, column=1, padx=4, pady=2, sticky='ew')
        ch_combo.bind('<<ComboboxSelected>>', self._on_channel_change)

        # Bitrate
        ttk.Label(cfg_frame, text='Bitrate:').grid(row=2, column=0, sticky='w', padx=4, pady=2)
        br_combo = ttk.Combobox(
            cfg_frame,
            values=config.BITRATE_LABELS,
            state='readonly',
            width=20,
        )
        try:
            idx = config.BITRATE_OPTIONS.index(self._bitrate_var.get())
            br_combo.current(idx)
        except ValueError:
            br_combo.current(6)  # 500k default
        br_combo.grid(row=2, column=1, padx=4, pady=2, sticky='ew')
        br_combo.bind('<<ComboboxSelected>>', lambda e: self._on_bitrate_change(br_combo))
        self._br_combo = br_combo

        # WS Port
        ttk.Label(cfg_frame, text='WS Port:').grid(row=3, column=0, sticky='w', padx=4, pady=2)
        ws_entry = ttk.Entry(cfg_frame, textvariable=self._ws_port_var, width=22)
        ws_entry.grid(row=3, column=1, padx=4, pady=2, sticky='ew')
        ws_entry.bind('<FocusOut>', self._on_ws_port_change)
        ws_entry.bind('<Return>', self._on_ws_port_change)
        self._ws_entry = ws_entry

        cfg_frame.columnconfigure(1, weight=1)
        self._ch_combo = ch_combo

        # Disable channel/bitrate for interfaces that don't use them
        self._update_hw_controls_state()

        # -- Status frame --
        status_frame = ttk.LabelFrame(root, text='Status')
        status_frame.pack(fill='x', **pad)

        self._indicator = tk.Canvas(status_frame, width=16, height=16, highlightthickness=0)
        self._indicator.grid(row=0, column=0, padx=4, pady=2)
        self._dot = self._indicator.create_oval(2, 2, 14, 14, fill='#888888')

        ttk.Label(status_frame, textvariable=self._status_text).grid(row=0, column=1, sticky='w')

        ttk.Label(status_frame, text='RX Frames:').grid(row=1, column=0, sticky='w', padx=4, pady=2)
        ttk.Label(status_frame, textvariable=self._rx_text).grid(row=1, column=1, sticky='w')

        ttk.Label(status_frame, text='TX Frames:').grid(row=2, column=0, sticky='w', padx=4, pady=2)
        ttk.Label(status_frame, textvariable=self._tx_text).grid(row=2, column=1, sticky='w')

        ttk.Label(status_frame, text='Clients:').grid(row=3, column=0, sticky='w', padx=4, pady=2)
        ttk.Label(status_frame, textvariable=self._clients_text).grid(row=3, column=1, sticky='w')

        # Connect URL (read-only, copyable)
        ttk.Label(status_frame, text='Connect to:').grid(row=4, column=0, sticky='w', padx=4, pady=2)
        self._url_var = tk.StringVar(value=self._get_ws_url())
        url_entry = ttk.Entry(status_frame, textvariable=self._url_var, state='readonly', width=28)
        url_entry.grid(row=4, column=1, padx=4, pady=2, sticky='ew')
        ttk.Button(status_frame, text='Copy', command=self._copy_url, width=5).grid(row=4, column=2, padx=2)
        self._url_entry = url_entry

        # Trust cert helper
        ttk.Label(status_frame, text='First time?').grid(row=5, column=0, sticky='w', padx=4, pady=2)
        trust_box = ttk.Frame(status_frame)
        trust_box.grid(row=5, column=1, columnspan=2, sticky='w', padx=4, pady=2)
        if _platform.system() == 'Windows':
            # One-click install into the current-user trusted-root store (no admin,
            # no browser warning). Chrome/Edge read this store.
            ttk.Button(trust_box, text='Trust Certificate (Automatic)',
                       command=self._trust_cert_auto).pack(side='left')
            ttk.Button(trust_box, text='Manual…',
                       command=self._open_cert_trust, width=8).pack(side='left', padx=(4, 0))
            warn_text = ('One click trusts this PC for Chrome/Edge — no admin needed.\n'
                         'Use "Manual…" only for Firefox or if the automatic step fails.')
        else:
            ttk.Button(trust_box, text='Trust Certificate',
                       command=self._open_cert_trust).pack(side='left')
            warn_text = ('Same browser as the dashboard: click Advanced -> Proceed,\n'
                         'then wait for the green "Certificate trusted" page.')

        # Warning label
        warn = ttk.Label(
            status_frame,
            text=warn_text,
            foreground='#b45309',
            wraplength=240,
            justify='left',
        )
        warn.grid(row=6, column=0, columnspan=3, sticky='w', padx=4, pady=(0, 4))

        # -- Buttons --
        btn_frame = ttk.Frame(root)
        btn_frame.pack(fill='x', **pad)

        self._start_btn = ttk.Button(btn_frame, text='Start Bridge', command=self._start)
        self._start_btn.pack(side='left', padx=4)

        self._stop_btn = ttk.Button(btn_frame, text='Stop Bridge', command=self._stop, state='disabled')
        self._stop_btn.pack(side='left', padx=4)

        ttk.Button(btn_frame, text='Quit', command=self._quit).pack(side='right', padx=4)

    # ------------------------------------------------------------------
    # Public
    # ------------------------------------------------------------------

    def run(self) -> None:
        self._root.mainloop()

    # ------------------------------------------------------------------
    # Status updates
    # ------------------------------------------------------------------

    def _on_status_change(self, status: BridgeStatus) -> None:
        self._root.after(0, self._update_ui, status)

    def _update_ui(self, status: BridgeStatus) -> None:
        running = status.state == BridgeState.OPEN

        self._status_text.set(_STATE_LABELS.get(status.state, '?'))
        self._rx_text.set(str(status.frames_rx))
        self._tx_text.set(str(status.frames_tx))
        self._clients_text.set(str(status.clients))

        color = _STATE_COLORS.get(status.state, '#888888')
        self._indicator.itemconfigure(self._dot, fill=color)

        if status.state == BridgeState.ERROR and status.error_msg:
            self._status_text.set(f'Error: {status.error_msg[:50]}')

        self._start_btn.configure(state='disabled' if running else 'normal')
        self._stop_btn.configure(state='normal' if running else 'disabled')
        self._iface_combo.configure(state='disabled' if running else 'readonly')
        self._ws_entry.configure(state='disabled' if running else 'normal')
        # Channel/bitrate disabled when bridge is running OR interface doesn't use them
        self._update_hw_controls_state(running)

    # ------------------------------------------------------------------
    # Actions
    # ------------------------------------------------------------------

    def _on_interface_change(self, event) -> None:
        iface = self._interface_var.get()
        self._bridge.set_can_interface(iface)
        self._update_hw_controls_state()

    def _update_hw_controls_state(self, bridge_running: bool = False) -> None:
        """Disable channel/bitrate when interface doesn't use them, or bridge is running."""
        iface = self._interface_var.get()
        # Channel selector: not applicable for vcan/socketcan (no hardware channel index)
        no_ch = iface in ('vcan', 'socketcan')
        ch_state = 'disabled' if (bridge_running or no_ch) else 'readonly'
        self._ch_combo.configure(state=ch_state)
        # Bitrate selector: not applicable for vcan; socketcan still needs a bitrate for ip link set
        no_br = iface == 'vcan'
        br_state = 'disabled' if (bridge_running or no_br) else 'readonly'
        self._br_combo.configure(state=br_state)

    def _on_channel_change(self, event) -> None:
        self._bridge.set_channel(self._channel_var.get())

    def _on_bitrate_change(self, combo) -> None:
        idx = combo.current()
        if 0 <= idx < len(config.BITRATE_OPTIONS):
            br = config.BITRATE_OPTIONS[idx]
            self._bitrate_var.set(br)
            self._bridge.set_bitrate(br)

    def _get_ws_url(self) -> str:
        # Loopback: the bridge runs on the same machine as the dashboard browser,
        # and the bundled certificate's SAN is IP:127.0.0.1, so the connection
        # must use 127.0.0.1 (not the LAN IP or `localhost`) for the cert to match.
        scheme = 'wss' if self._bridge.get_status().tls else 'ws'
        return f'{scheme}://127.0.0.1:{self._ws_port_var.get()}'

    def _get_https_url(self) -> str:
        """HTTPS URL for the cert trust page (same host/port as WSS)."""
        wss = self._url_var.get()
        return wss.replace('wss://', 'https://', 1)

    def _trust_cert_auto(self) -> None:
        """Install the bridge cert into the current-user trusted-root store (Windows).

        Uses `certutil -addstore -user Root`, which writes to HKCU and needs no
        admin rights. Chrome and Edge read this store, so afterwards the dashboard
        connects over wss://127.0.0.1 with no browser warning at all.
        """
        cert = str(CERT_FILE)
        try:
            # CREATE_NO_WINDOW (0x08000000) keeps a console flash from appearing.
            proc = subprocess.run(
                ['certutil', '-addstore', '-user', '-f', 'Root', cert],
                capture_output=True, text=True,
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
            )
        except FileNotFoundError:
            messagebox.showerror(
                'Trust Certificate',
                'Could not find "certutil" (Windows built-in). '
                'Use the "Manual…" button instead.',
                parent=self._root,
            )
            return
        except Exception as e:
            messagebox.showerror('Trust Certificate', f'Failed to run certutil:\n{e}', parent=self._root)
            return

        if proc.returncode == 0:
            messagebox.showinfo(
                'Trust Certificate',
                'Certificate installed for Chrome and Edge on this PC.\n\n'
                'Reload (or reconnect) the PECAN dashboard — it will connect with '
                'no security warning.\n\n'
                'Note: Firefox keeps its own store; use "Manual…" there.',
                parent=self._root,
            )
        else:
            detail = (proc.stderr or proc.stdout or '').strip()[:300]
            messagebox.showerror(
                'Trust Certificate',
                'Automatic install failed. Use the "Manual…" button instead.\n\n'
                f'{detail}',
                parent=self._root,
            )

    def _open_cert_trust(self) -> None:
        """Open the bridge's HTTPS endpoint so the user can accept the self-signed cert."""
        messagebox.showinfo(
            'Trust Certificate',
            'A page will open in your browser.\n\n'
            'IMPORTANT: Use the same browser you use for the dashboard.\n\n'
            '1. You will see a security warning (this is expected — the\n'
            '   bridge runs locally with a self-signed certificate).\n'
            '2. Click "Advanced", then "Proceed to ... (unsafe)".\n'
            '3. Wait for the green "Certificate trusted" page with a\n'
            '   "Live connection confirmed" check.\n\n'
            'Then close the tab and return to the dashboard.\n'
            'You only need to do this once per browser.',
            parent=self._root,
        )
        webbrowser.open(self._get_https_url())

    def _copy_url(self) -> None:
        self._root.clipboard_clear()
        self._root.clipboard_append(self._url_var.get())

    def _on_ws_port_change(self, event) -> None:
        try:
            port = self._ws_port_var.get()
            self._bridge.set_ws_port(port)
            self._url_var.set(self._get_ws_url())
        except Exception:
            pass

    def _start(self) -> None:
        asyncio.run_coroutine_threadsafe(self._bridge.start(), self._loop)

    def _stop(self) -> None:
        asyncio.run_coroutine_threadsafe(self._bridge.stop(), self._loop)

    def _quit(self) -> None:
        self._root.destroy()
        self._quit_cb()

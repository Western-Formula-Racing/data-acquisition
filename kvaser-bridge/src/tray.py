"""
Kvaser Bridge GUI using tkinter (stdlib, no extra deps).

Small window with channel/bitrate/port config, start/stop, and status.
"""

from __future__ import annotations
import asyncio
import logging
import socket
import tkinter as tk
from tkinter import messagebox, ttk
from typing import Callable
import webbrowser

import config
from bridge import Bridge, BridgeState, BridgeStatus

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
        self._channel_var = tk.IntVar(value=initial_channel)
        self._bitrate_var = tk.IntVar(value=initial_bitrate)
        self._ws_port_var = tk.IntVar(value=initial_ws_port)
        self._status_text = tk.StringVar(value='Idle')
        self._rx_text     = tk.StringVar(value='0')
        self._clients_text = tk.StringVar(value='0')

        self._build_ui()

        bridge.on_status_change = self._on_status_change

    def _build_ui(self) -> None:
        root = self._root
        pad = {'padx': 8, 'pady': 4}

        # -- Config frame --
        cfg_frame = ttk.LabelFrame(root, text='Configuration')
        cfg_frame.pack(fill='x', **pad)

        # Channel
        ttk.Label(cfg_frame, text='Channel:').grid(row=0, column=0, sticky='w', padx=4, pady=2)
        ch_combo = ttk.Combobox(
            cfg_frame,
            textvariable=self._channel_var,
            values=list(range(self._num_channels)),
            state='readonly',
            width=20,
        )
        ch_combo.grid(row=0, column=1, padx=4, pady=2, sticky='ew')
        ch_combo.bind('<<ComboboxSelected>>', self._on_channel_change)

        # Bitrate
        ttk.Label(cfg_frame, text='Bitrate:').grid(row=1, column=0, sticky='w', padx=4, pady=2)
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
        br_combo.grid(row=1, column=1, padx=4, pady=2, sticky='ew')
        br_combo.bind('<<ComboboxSelected>>', lambda e: self._on_bitrate_change(br_combo))
        self._br_combo = br_combo

        # WS Port
        ttk.Label(cfg_frame, text='WS Port:').grid(row=2, column=0, sticky='w', padx=4, pady=2)
        ws_entry = ttk.Entry(cfg_frame, textvariable=self._ws_port_var, width=22)
        ws_entry.grid(row=2, column=1, padx=4, pady=2, sticky='ew')
        ws_entry.bind('<FocusOut>', self._on_ws_port_change)
        ws_entry.bind('<Return>', self._on_ws_port_change)
        self._ws_entry = ws_entry

        cfg_frame.columnconfigure(1, weight=1)
        self._ch_combo = ch_combo

        # -- Status frame --
        status_frame = ttk.LabelFrame(root, text='Status')
        status_frame.pack(fill='x', **pad)

        self._indicator = tk.Canvas(status_frame, width=16, height=16, highlightthickness=0)
        self._indicator.grid(row=0, column=0, padx=4, pady=2)
        self._dot = self._indicator.create_oval(2, 2, 14, 14, fill='#888888')

        ttk.Label(status_frame, textvariable=self._status_text).grid(row=0, column=1, sticky='w')

        ttk.Label(status_frame, text='Frames:').grid(row=1, column=0, sticky='w', padx=4, pady=2)
        ttk.Label(status_frame, textvariable=self._rx_text).grid(row=1, column=1, sticky='w')

        ttk.Label(status_frame, text='Clients:').grid(row=2, column=0, sticky='w', padx=4, pady=2)
        ttk.Label(status_frame, textvariable=self._clients_text).grid(row=2, column=1, sticky='w')

        # Connect URL (read-only, copyable)
        ttk.Label(status_frame, text='Connect to:').grid(row=3, column=0, sticky='w', padx=4, pady=2)
        self._url_var = tk.StringVar(value=self._get_ws_url())
        url_entry = ttk.Entry(status_frame, textvariable=self._url_var, state='readonly', width=28)
        url_entry.grid(row=3, column=1, padx=4, pady=2, sticky='ew')
        ttk.Button(status_frame, text='Copy', command=self._copy_url, width=5).grid(row=3, column=2, padx=2)
        self._url_entry = url_entry

        # Trust cert helper
        ttk.Label(status_frame, text='First time?').grid(row=4, column=0, sticky='w', padx=4, pady=2)
        trust_btn = ttk.Button(status_frame, text='Trust Certificate', command=self._open_cert_trust)
        trust_btn.grid(row=4, column=1, sticky='w', padx=4, pady=2)

        # Warning label
        warn = ttk.Label(
            status_frame,
            text='Open in the same browser you use for the dashboard,\nthen click Advanced -> Proceed.',
            foreground='#b45309',
            wraplength=220,
            justify='left',
        )
        warn.grid(row=5, column=0, columnspan=3, sticky='w', padx=4, pady=(0, 4))

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
        self._clients_text.set(str(status.clients))

        color = _STATE_COLORS.get(status.state, '#888888')
        self._indicator.itemconfigure(self._dot, fill=color)

        if status.state == BridgeState.ERROR and status.error_msg:
            self._status_text.set(f'Error: {status.error_msg[:50]}')

        self._start_btn.configure(state='disabled' if running else 'normal')
        self._stop_btn.configure(state='normal' if running else 'disabled')
        self._ch_combo.configure(state='disabled' if running else 'readonly')
        self._br_combo.configure(state='disabled' if running else 'readonly')
        self._ws_entry.configure(state='disabled' if running else 'normal')

    # ------------------------------------------------------------------
    # Actions
    # ------------------------------------------------------------------

    def _on_channel_change(self, event) -> None:
        self._bridge.set_channel(self._channel_var.get())

    def _on_bitrate_change(self, combo) -> None:
        idx = combo.current()
        if 0 <= idx < len(config.BITRATE_OPTIONS):
            br = config.BITRATE_OPTIONS[idx]
            self._bitrate_var.set(br)
            self._bridge.set_bitrate(br)

    def _get_ws_url(self) -> str:
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(('8.8.8.8', 80))
            ip = s.getsockname()[0]
            s.close()
        except Exception:
            ip = 'localhost'
        return f'wss://{ip}:{self._ws_port_var.get()}'

    def _get_https_url(self) -> str:
        """HTTPS URL for the cert trust page (same host/port as WSS)."""
        wss = self._url_var.get()
        return wss.replace('wss://', 'https://', 1)

    def _open_cert_trust(self) -> None:
        """Open the bridge's HTTPS endpoint so the user can accept the self-signed cert."""
        messagebox.showinfo(
            'Trust Certificate',
            'A page will open in your browser.\n\n'
            'IMPORTANT: Use the same browser you use for the dashboard.\n\n'
            '1. Click "Advanced"\n'
            '2. Click "Proceed to ... (unsafe)"\n\n'
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

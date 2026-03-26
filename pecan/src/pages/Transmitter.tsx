import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { Search, Zap, Send, Info } from "lucide-react";
import { usePageLock } from "../lib/usePageLock";
import { PageLockBanner } from "../components/PageLockBanner";
import { txWebSocketService } from "../services/TxWebSocketService";
import { dataStore } from "../lib/DataStore";
import localDbc from "../assets/dbc.dbc?raw";
import { Dbc } from "candied";

type TxFeedback =
  | null
  | { type: "sending" }
  | { type: "ok"; status: string }
  | { type: "error"; message: string };

const DataTransmitter = () => {
  const lock = usePageLock('can-transmitter');
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedMsgId, setSelectedMsgId] = useState<number | null>(null);
  const [signalValues, setSignalValues] = useState<Record<string, number>>({});
  const [delay, setDelay] = useState<number | "">("");
  const [txFeedback, setTxFeedback] = useState<TxFeedback>(null);
  const [liveBytes, setLiveBytes] = useState<number[] | null>(null);
  const [txConnected, setTxConnected] = useState(false);

  const pendingTxRef = useRef<string | null>(null);
  const ackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Connect to the TX WebSocket on mount; clean up on unmount
  useEffect(() => {
    txWebSocketService.connect();

    const onPreview = (msg: any) => {
      if (msg?.type === "preview") {
        setLiveBytes(msg.bytes);
      }
    };
    const onAck = (msg: any) => {
      if (msg?.type === "uplink_ack") {
        if (pendingTxRef.current && msg.ref === pendingTxRef.current) {
          pendingTxRef.current = null;
          if (ackTimeoutRef.current !== null) {
            window.clearTimeout(ackTimeoutRef.current);
            ackTimeoutRef.current = null;
          }
          setTxFeedback({ type: "ok", status: msg.status });
        }
      }
    };
    const onErr = (msg: any) => {
      if (msg?.type === "error") {
        if (pendingTxRef.current) {
          pendingTxRef.current = null;
          if (ackTimeoutRef.current !== null) {
            window.clearTimeout(ackTimeoutRef.current);
            ackTimeoutRef.current = null;
          }
          setTxFeedback({ type: "error", message: `${msg.code}: ${msg.message}` });
        }
      }
    };

    // Track connection state by polling
    const pollInterval = setInterval(() => {
      setTxConnected(txWebSocketService.connected);
    }, 1000);

    txWebSocketService.onMessage(onPreview);
    txWebSocketService.onMessage(onAck);
    txWebSocketService.onMessage(onErr);

    return () => {
      txWebSocketService.offMessage(onPreview);
      txWebSocketService.offMessage(onAck);
      txWebSocketService.offMessage(onErr);
      clearInterval(pollInterval);
    };
  }, []);

  // Request a live preview from the TX bridge whenever signals change
  const requestPreview = useCallback((canId: number, signals: Record<string, number>) => {
    if (!txWebSocketService.isConnected()) return;
    txWebSocketService.previewSignals(canId, signals);
  }, []);

  // Debounced preview: fire after signal changes
  useEffect(() => {
    if (selectedMsgId == null) return;
    const timeout = setTimeout(() => {
      requestPreview(selectedMsgId, signalValues);
    }, 150); // 150ms debounce
    return () => clearTimeout(timeout);
  }, [selectedMsgId, signalValues, requestPreview]);

  const handleTransmit = useCallback(() => {
    if (selectedMsgId == null) return;
    const canId = selectedMsgId;

    if (!txWebSocketService.isConnected()) {
      setTxFeedback({ type: "error", message: "TX bridge not connected — check UTS is running on port 9078." });
      return;
    }

    const ref = `tx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

    const run = () => {
      if (ackTimeoutRef.current !== null) {
        window.clearTimeout(ackTimeoutRef.current);
        ackTimeoutRef.current = null;
      }

      pendingTxRef.current = ref;
      setTxFeedback({ type: "sending" });

      ackTimeoutRef.current = window.setTimeout(() => {
        ackTimeoutRef.current = null;
        if (pendingTxRef.current === ref) {
          pendingTxRef.current = null;
          setTxFeedback({ type: "error", message: "No acknowledgement (timeout)." });
        }
      }, 10_000);

      const sent = txWebSocketService.sendSignals(canId, signalValues, ref);
      if (!sent) {
        pendingTxRef.current = null;
        if (ackTimeoutRef.current !== null) {
          window.clearTimeout(ackTimeoutRef.current);
          ackTimeoutRef.current = null;
        }
        setTxFeedback({ type: "error", message: "Failed to send (TX bridge disconnected)." });
      } else {
        // Show the TX frame in the trace
        dataStore.ingestMessage({
          msgID: `0x${canId.toString(16).toUpperCase()}`,
          messageName: selectedMessage?.name ?? `CAN_0x${canId.toString(16).toUpperCase()}`,
          data: {},
          rawData: liveBytes
            ? liveBytes.map(b => b.toString(16).padStart(2, "0").toUpperCase()).join(" ")
            : "00 00 00 00 00 00 00 00",
          timestamp: Date.now(),
          direction: "tx",
        });
      }
    };

    if (delay !== "" && typeof delay === "number" && delay > 0) {
      window.setTimeout(run, delay);
    } else {
      run();
    }
  }, [selectedMsgId, signalValues, delay, liveBytes]);

  // 1. Load available messages from DBC
  const availableMessages = useMemo(() => {
    const dbc = new Dbc();
    const data = dbc.load(localDbc);
    return Array.from(data.messages.values());
  }, []);

  // 2. Filter messages for sidebar
  const filteredMessages = availableMessages.filter(msg =>
    msg.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    msg.id.toString().includes(searchTerm)
  );

  const selectedMessage = availableMessages.find(m => m.id === selectedMsgId);

  // 3. Handle signal changes
  const updateSignal = (name: string, value: number) => {
    setSignalValues(prev => ({ ...prev, [name]: value }));
  };

  // 4. Generate hex from live bytes (provided by TX bridge) or fallback
  const rawPayload = useMemo((): string[] => {
    if (liveBytes && liveBytes.length === 8) {
      return liveBytes.map(b => b.toString(16).padStart(2, "0").toUpperCase());
    }
    return ["00", "00", "00", "00", "00", "00", "00", "00"];
  }, [liveBytes]);

  const isTxReady = txConnected && !lock.isLockedByOther;

  // 4-state color system: lock × WS connection
  const txBorderState =
    lock.isLockedByMe && txConnected  ? 'active'  :
    !lock.isLockedByMe && txConnected ? 'ready'   :
    lock.isLockedByMe                 ? 'locked'  :
                                        'idle';

  const TX_COLORS = {
    idle:   { wire: 'rgba(30,58,138,0.30)',  wireSub: 'rgba(30,58,138,0.18)'  },
    locked: { wire: 'rgba(96,165,250,0.38)', wireSub: 'rgba(96,165,250,0.22)' },
    ready:  { wire: 'rgba(34,197,94,0.36)',  wireSub: 'rgba(34,197,94,0.20)'  },
    active: { wire: 'rgba(249,115,22,0.40)', wireSub: 'rgba(249,115,22,0.22)' },
  } as const;

  const colors = TX_COLORS[txBorderState];

  return (
    <div className="relative flex flex-col h-full gap-6 p-6 text-white overflow-hidden">
      <PageLockBanner lock={lock} wireColor={colors.wire} txConnected={txConnected} />

      <div className="flex flex-1 gap-6 overflow-hidden">

        {/* --- LEFT COLUMN: Floating Sidebar --- */}
        <div className="w-80 flex flex-col gap-4 bg-slate-900/50 rounded-2xl border p-4 backdrop-blur-md shadow-2xl" style={{ borderColor: colors.wire, transition: 'border-color 0.5s ease' }}>
          <div className="relative">
            <Search className="absolute left-3 top-3 w-4 h-4 text-white" />
            <input
              type="text"
              placeholder="Search Messages..."
              className="w-full bg-slate-950 border border-slate-800 rounded-2xl py-2 pl-10 pr-4 text-sm focus:outline-none focus:border-blue-500 transition-colors"
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>

          <div className="flex-1 overflow-y-auto pr-2 space-y-2 custom-scrollbar">
            <label className="text-[10px] uppercase tracking-widest text-white-500 font-bold px-2">Available Messages</label>
            {filteredMessages.map(msg => (
              <button
                key={msg.id}
                onClick={() => {
                  setSelectedMsgId(msg.id);
                  setSignalValues({});
                  setLiveBytes(null);
                }}
                className={`w-full flex flex-col items-start p-3 !rounded-2xl transition-all ${selectedMsgId === msg.id
                  ? "bg-blue-600 text-white shadow-lg"
                  : "hover:bg-slate-800 text-slate-400"
                  }`}
              >
                <span className="text-xs font-bold font-mono">0x{msg.id.toString(16).toUpperCase()}</span>
                <span className="text-sm truncate w-full text-left">{msg.name}</span>
              </button>
            ))}
          </div>
        </div>

        {/* --- CENTRAL DISPLAY: Workspace --- */}
        <div className="flex-1 flex flex-col gap-6 overflow-y-auto pr-4">
          {selectedMessage ? (
            <>
              {/* Hex Header Card */}
              <div className="bg-slate-900/50 border rounded-3xl p-6 backdrop-blur-md" style={{ borderColor: colors.wire, transition: 'border-color 0.5s ease' }}>
                <div className="flex justify-between items-center mb-6">
                  <div>
                    <h2 className="text-2xl font-bold text-white">{selectedMessage.name}</h2>
                    <p className="text-blue-400 font-mono text-sm">ID: 0x{selectedMessage.id.toString(16).toUpperCase()}</p>
                  </div>
                  <div className="p-3 bg-blue-500/10 rounded-2xl">
                    <Zap className="w-6 h-6 text-blue-400" />
                  </div>
                </div>

                <div className="space-y-3 max-w-xl">
                  <label className="text-[10px] uppercase tracking-widest text-slate-500 font-bold">Raw Payload Preview</label>
                  <div className="flex gap-2">
                    {rawPayload.map((byte, i) => (
                      <div key={i} className="flex-1 h-14 bg-slate-950 border border-slate-800 rounded-xl flex items-center justify-center font-mono text-blue-400 text-lg shadow-inner">
                        {byte}
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Signals Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {Array.from(selectedMessage.signals.values()).map(sig => {
                  const currentValue = signalValues[sig.name] ?? Math.max(sig.min, Math.min(sig.max, 0));

                  return (
                    <div key={sig.name} className="bg-slate-900/30 border rounded-2xl p-4 flex flex-col gap-3" style={{ borderColor: colors.wireSub, transition: 'border-color 0.5s ease' }}>
                      <div className="flex justify-between items-center">
                        <div className="flex flex-col">
                          <span className="text-sm font-semibold text-slate-300">{sig.name}</span>
                          <span className="text-[10px] text-slate-500 font-mono italic">
                            Range: {sig.min} to {sig.max}
                          </span>
                        </div>
                        <span className="text-[10px] font-mono text-blue-400 bg-blue-500/10 border border-blue-500/20 px-2 py-1 rounded-md">
                          {sig.unit || "raw"}
                        </span>
                      </div>

                      <div className="flex items-center gap-4">
                        <input
                          type="range"
                          min={sig.min}
                          max={sig.max}
                          step={sig.factor || 0.01}
                          value={currentValue}
                          onChange={(e) => updateSignal(sig.name, Number(e.target.value))}
                          className="flex-1 accent-blue-500 h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer hover:accent-blue-400 transition-all"
                        />
                        <div className="relative">
                          <input
                            type="number"
                            min={sig.min}
                            max={sig.max}
                            step={sig.factor || 0.1}
                            value={currentValue}
                            onChange={(e) => updateSignal(sig.name, Number(e.target.value))}
                            className="w-24 bg-slate-950 border border-slate-800 rounded-xl py-2 px-3 text-right text-sm font-mono text-blue-400 focus:outline-none focus:border-blue-500/50 transition-colors shadow-inner [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                          />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Controls Bar */}
              <div className="mt-auto pt-6 flex flex-col items-end gap-2">
                <div className="flex flex-wrap justify-end items-center gap-4 w-full">
                  <div className="flex items-center bg-slate-900 border border-slate-800 rounded-2xl p-1 h-12 w-64">
                    <button type="button" onClick={() => setDelay("")} className={`flex-1 h-full !rounded-xl text-[10px] font-bold ${delay === "" ? 'bg-blue-600 text-white' : 'text-slate-500'}`}>NOW</button>
                    <div className="w-px h-4 bg-slate-800 mx-2" />
                    <input
                      type="number"
                      value={delay}
                      onChange={(e) => setDelay(e.target.value === "" ? "" : Number(e.target.value))}
                      placeholder="delay..."
                      className="bg-transparent text-right pr-2 text-sm font-mono text-blue-400 outline-none w-20"
                    />
                    <span className="text-[10px] text-slate-600 pr-2 font-bold">MS</span>
                  </div>
                  <button
                    type="button"
                    onClick={handleTransmit}
                    disabled={!isTxReady || txFeedback?.type === "sending"}
                    className={`h-12 px-10 font-bold !rounded-2xl shadow-lg flex items-center gap-3 transition-all ${
                      !isTxReady || txFeedback?.type === "sending"
                        ? 'bg-slate-700 text-slate-500 cursor-not-allowed'
                        : 'bg-blue-600 hover:bg-blue-500 text-white'
                    }`}
                  >
                    <Send className="w-4 h-4" /> TRANSMIT
                  </button>
                </div>
                {txFeedback?.type === "sending" && (
                  <p className="text-xs text-slate-400">Sending… waiting for uplink_ack</p>
                )}
                {txFeedback?.type === "ok" && (
                  <p className="text-xs text-emerald-400">
                    Transmitted — server status: <span className="font-mono">{txFeedback.status}</span>
                  </p>
                )}
                {txFeedback?.type === "error" && (
                  <p className="text-xs text-red-400 max-w-xl text-right">{txFeedback.message}</p>
                )}
              </div>
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-slate-600">
              <Info className="w-12 h-12 mb-4 opacity-20" />
              <p className="text-lg italic">Select a message from the sidebar to begin</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default DataTransmitter;

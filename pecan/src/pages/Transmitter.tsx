import React, { useState, useMemo } from "react";
import { Search, Zap, Send, Clock, Info } from "lucide-react";
import { packMessage } from "../utils/packMessage";
// Assuming you have a hook or utility to get your DBC messages
import localDbc from "../assets/dbc.dbc?raw";
import { Dbc } from "candied";

const DataTransmitter = () => {
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedMsgId, setSelectedMsgId] = useState<number | null>(null);
  const [signalValues, setSignalValues] = useState<Record<string, number>>({});
  const [delay, setDelay] = useState<number | "">("");

  const UPLINK_WHITELIST = [256, 101];

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

  // 4. Generate Live Hex
  const rawPayload = useMemo(() => {
    if (!selectedMsgId) return ["00", "00", "00", "00", "00", "00", "00", "00"];
    const hex = packMessage(selectedMsgId, signalValues);
    return hex.match(/.{1,2}/g) || ["00", "00", "00", "00", "00", "00", "00", "00"];
  }, [selectedMsgId, signalValues]);

  return (
    <div className="flex h-full gap-6 p-6 text-white overflow-hidden">

      {/* --- LEFT COLUMN: Floating Sidebar --- */}
      <div className="w-80 flex flex-col gap-4 bg-slate-900/50 rounded-2xl border border-blue-500/20 p-4 backdrop-blur-md shadow-2xl">
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
                setSignalValues({}); // Reset inputs on switch
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
            <div className="bg-slate-900/50 border border-slate-800 rounded-3xl p-6 backdrop-blur-md">
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
                // Calculate the initial/current value
                // If not yet touched, try to use 0, but clamp it within the DBC min/max
                const currentValue = signalValues[sig.name] ?? Math.max(sig.min, Math.min(sig.max, 0));

                return (
                  <div key={sig.name} className="bg-slate-900/30 border border-slate-800/50 rounded-2xl p-4 flex flex-col gap-3">
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
                      {/* Slider Input */}
                      <input
                        type="range"
                        min={sig.min}
                        max={sig.max}
                        // Use the precision from the DBC factor if available, otherwise 0.01
                        step={sig.factor || 0.01}
                        value={currentValue}
                        onChange={(e) => updateSignal(sig.name, Number(e.target.value))}
                        className="flex-1 accent-blue-500 h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer hover:accent-blue-400 transition-all"
                      />

                      {/* Numerical Input Box */}
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
            <div className="mt-auto pt-6 flex justify-end items-center gap-4">
              <div className="flex items-center bg-slate-900 border border-slate-800 rounded-2xl p-1 h-12 w-64">
                <button onClick={() => setDelay("")} className={`flex-1 h-full !rounded-xl text-[10px] font-bold ${delay === "" ? 'bg-blue-600 text-white' : 'text-slate-500'}`}>NOW</button>
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
              <button className="h-12 px-10 bg-blue-600 hover:bg-blue-500 text-white font-bold !rounded-2xl shadow-lg flex items-center gap-3 transition-all">
                <Send className="w-4 h-4" /> TRANSMIT
              </button>
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
  );
};

export default DataTransmitter;
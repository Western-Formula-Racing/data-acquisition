import { useState } from "react";
import { useWcars } from "../../context/WcarsContext";

export function WcarsSettings() {
  const { config, setConfig, sendTestAlert } = useWcars();
  const [open, setOpen] = useState(false);
  const [temp, setTemp] = useState(config.thresholds.torch_cell_temp_c);
  const [imbal, setImbal] = useState(config.thresholds.torch_cell_imbalance_v);
  const [rearm, setRearm] = useState(config.thresholds.rearm_seconds);
  const [enabled, setEnabled] = useState(config.audio.enabled);
  const [volume, setVolume] = useState(config.audio.volume);

  const apply = () => {
    setConfig({
      thresholds: { torch_cell_temp_c: temp, torch_cell_imbalance_v: imbal, rearm_seconds: rearm },
      audio: { enabled, volume },
    });
    setOpen(false);
  };

  return (
    <div className="wcars-settings">
      <button className="wcars-gear" onClick={() => setOpen((o) => !o)} aria-label="WCARS settings">
        ⚙
      </button>
      {open && (
        <div className="wcars-settings-panel">
          <h3>WCARS</h3>
          <label>
            TORCH cell temp limit (°C)
            <input type="number" step="0.5" value={temp} onChange={(e) => setTemp(Number(e.target.value))} />
          </label>
          <label>
            TORCH cell imbalance limit (V)
            <input type="number" step="0.01" value={imbal} onChange={(e) => setImbal(Number(e.target.value))} />
          </label>
          <label>
            Re-arm window (s)
            <input type="number" step="1" min="0" value={rearm} onChange={(e) => setRearm(Number(e.target.value))} />
          </label>
          <label>
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Enable chimes
          </label>
          <label>
            Volume
            <input type="range" min="0" max="1" step="0.05" value={volume} onChange={(e) => setVolume(Number(e.target.value))} />
          </label>
          <div className="wcars-settings-actions">
            <button onClick={apply}>Apply</button>
            <button onClick={() => sendTestAlert()}>Send test alert</button>
            <button onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

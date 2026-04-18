// app.jsx — shell: side-by-side canvas with two overlay variants, Tweaks,
// OBS setup notes, connection panel.

// ─── CAN Debug Panel ──────────────────────────────────────────────────────────
function CanDebugPanel() {
  const [open, setOpen] = React.useState(true);
  const [tick, setTick] = React.useState(0);
  const [flash, setFlash] = React.useState(false);
  const prevCount = React.useRef(0);

  React.useEffect(() => {
    const iv = setInterval(() => {
      const n = window.wsService.getMsgCount();
      if (n !== prevCount.current) {
        prevCount.current = n;
        setFlash(true);
        setTimeout(() => setFlash(false), 120);
      }
      setTick((t) => t + 1);
    }, 200);
    return () => clearInterval(iv);
  }, []);

  const wsStatus = window.wsService.useStatus();
  const dbcReady = window.wsService.isDbcReady();
  const msgCount = window.wsService.getMsgCount();
  const live = window.telemetryStore?.live ?? {};
  const signals = Object.entries(live).slice(0, 8);

  const dot = { width: 7, height: 7, borderRadius: 4, display: 'inline-block', marginRight: 5 };
  const modeColor = wsStatus.mode === 'live' ? '#00E5A0' : wsStatus.mode === 'sim' ? '#D6AB39' : '#E63946';

  if (!open) {
    return (
      <div onClick={() => setOpen(true)} style={{
        position: 'fixed', bottom: 12, left: 12, zIndex: 50,
        background: 'rgba(10,10,11,0.85)', border: `1px solid ${modeColor}`,
        padding: '4px 10px', cursor: 'pointer',
        fontFamily: '"JetBrains Mono", monospace', fontSize: 10, color: modeColor,
        letterSpacing: 1.2,
      }}>
        <span style={{ ...dot, background: flash ? '#fff' : modeColor }} />
        CAN {wsStatus.mode.toUpperCase()} · {msgCount}
      </div>
    );
  }

  return (
    <div style={{
      position: 'fixed', bottom: 12, left: 12, zIndex: 50, width: 280,
      background: 'rgba(10,10,11,0.92)', border: '1px solid rgba(255,255,255,0.12)',
      fontFamily: '"JetBrains Mono", monospace', fontSize: 10, color: '#c4c4c7',
    }}>
      {/* header */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '5px 10px', borderBottom: '1px solid rgba(255,255,255,0.08)',
        background: 'rgba(255,255,255,0.04)',
      }}>
        <span style={{ letterSpacing: 1.4, color: '#f4f4f5', fontWeight: 700 }}>CAN DEBUG</span>
        <span onClick={() => setOpen(false)} style={{ cursor: 'pointer', opacity: 0.5 }}>✕</span>
      </div>

      <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 5 }}>
        {/* status row */}
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span>
            <span style={{ ...dot, background: modeColor }} />
            {wsStatus.mode.toUpperCase()}
          </span>
          <span style={{ color: dbcReady ? '#00E5A0' : '#E63946' }}>
            DBC {dbcReady ? 'loaded' : 'fallback'}
          </span>
        </div>

        {/* message counter with flash */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ color: '#888' }}>messages</span>
          <span style={{
            color: flash ? '#fff' : '#D6AB39', fontWeight: 700, fontSize: 12,
            transition: 'color 60ms',
          }}>{msgCount.toLocaleString()}</span>
        </div>

        {/* live signals */}
        <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 5, marginTop: 2 }}>
          <div style={{ color: '#555', marginBottom: 3 }}>LIVE SIGNALS</div>
          {signals.length === 0
            ? <div style={{ color: '#555' }}>— waiting —</div>
            : signals.map(([name, sig]) => (
              <div key={name} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 1 }}>
                <span style={{ color: '#888', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 160 }}>{name}</span>
                <span style={{ color: '#f4f4f5' }}>
                  {typeof (sig.sensorReading ?? sig.value) === 'number'
                    ? (sig.sensorReading ?? sig.value).toFixed(2)
                    : '—'}
                  {sig.unit ? ` ${sig.unit}` : ''}
                </span>
              </div>
            ))
          }
          {Object.keys(live).length > 8 && (
            <div style={{ color: '#555', marginTop: 2 }}>+{Object.keys(live).length - 8} more</div>
          )}
        </div>
      </div>
    </div>
  );
}

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "carNumber": 33,
  "wsUrl": "ws://10.71.1.10:9080",
  "mediamtxHost": "localhost",
  "layout": "side-by-side",
  "showWaveforms": true,
  "showGTrail": true,
  "activeVariant": "A"
}/*EDITMODE-END*/;

function App() {
  const [tweaks, setTweaks] = React.useState(() => {
    try { return { ...TWEAK_DEFAULTS, ...JSON.parse(localStorage.getItem('wfr-tweaks') || '{}') }; }
    catch { return TWEAK_DEFAULTS; }
  });
  const [editMode, setEditMode] = React.useState(false);
  const [panelOpen, setPanelOpen] = React.useState(true);
  const [wsInput, setWsInput] = React.useState(() => localStorage.getItem(window.LS_WS_KEY) || '');
  const [mtxInput, setMtxInput] = React.useState(tweaks.mediamtxHost || '');
  const wsStatus = window.wsService.useStatus();
  const [fitScale, setFitScale] = React.useState(1);

  const update = (patch) => {
    const next = { ...tweaks, ...patch };
    setTweaks(next);
    localStorage.setItem('wfr-tweaks', JSON.stringify(next));
    window.parent?.postMessage({ type: '__edit_mode_set_keys', edits: patch }, '*');
  };

  React.useEffect(() => {
    const handler = (e) => {
      if (e.data?.type === '__activate_edit_mode') setEditMode(true);
      if (e.data?.type === '__deactivate_edit_mode') setEditMode(false);
    };
    window.addEventListener('message', handler);
    window.parent?.postMessage({ type: '__edit_mode_available' }, '*');
    return () => window.removeEventListener('message', handler);
  }, []);

  // Connect to real base station WebSocket (falls back to sim if unreachable)
  React.useEffect(() => {
    const saved = localStorage.getItem(window.LS_WS_KEY);
    if (saved) window.wsService.connect(saved);
    else window.wsService.connect('ws://10.71.1.10:9080');
  }, []);

  // Fit the 1920×? composite into the viewport
  React.useEffect(() => {
    const compute = () => {
      const layout = tweaks.layout;
      const natW = layout === 'side-by-side' ? 1920 * 2 + 40 : 1920;
      const natH = 1080 + 80;
      const s = Math.min(window.innerWidth / natW, window.innerHeight / natH, 1);
      setFitScale(s);
    };
    compute();
    window.addEventListener('resize', compute);
    return () => window.removeEventListener('resize', compute);
  }, [tweaks.layout]);

  const connectWs = () => {
    window.wsService.connect(wsInput.trim());
  };
  const useSim = () => {
    localStorage.removeItem(window.LS_WS_KEY);
    window.wsService.disconnect();
    window.wsService.startSim();
  };

  const variantA = (
    <window.VideoStage
      overlay={<window.OverlayBroadcastBar carNumber={tweaks.carNumber} />}
      mediamtxHost={tweaks.mediamtxHost || null}
      carNumber={tweaks.carNumber}
    />
  );
  const variantB = (
    <window.VideoStage
      overlay={<window.OverlayCornerHud carNumber={tweaks.carNumber} />}
      mediamtxHost={tweaks.mediamtxHost || null}
      carNumber={tweaks.carNumber}
    />
  );

  const renderCanvas = () => {
    if (tweaks.layout === 'side-by-side') {
      return (
        <div style={{ display: 'flex', gap: 40, alignItems: 'flex-start' }}>
          <Labeled title="Variant A · BROADCAST BAR">
            {variantA}
          </Labeled>
          <Labeled title="Variant B · CORNER HUD">
            {variantB}
          </Labeled>
        </div>
      );
    }
    return (
      <Labeled title={tweaks.activeVariant === 'A' ? 'BROADCAST BAR' : 'CORNER HUD'}>
        {tweaks.activeVariant === 'A' ? variantA : variantB}
      </Labeled>
    );
  };

  const natW = tweaks.layout === 'side-by-side' ? 1920 * 2 + 40 : 1920;
  const natH = 1080 + 60;

  return (
    <div style={{
      minHeight: '100vh', background: '#0a0a0b', color: '#f4f4f5',
      fontFamily: window.FONT.label, overflow: 'hidden',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} data-screen-label="01 Stream Overlay Canvas">
      <div style={{
        width: natW, transform: `scale(${fitScale})`, transformOrigin: 'center center',
      }}>
        {renderCanvas()}
      </div>

      {/* Connection pill (top-left, always visible) */}
      <div style={{ position: 'fixed', top: 12, left: 12, display: 'flex', gap: 8,
        alignItems: 'center', background: 'rgba(0,0,0,0.7)', border: '1px solid rgba(255,255,255,0.1)',
        padding: '6px 12px', fontFamily: window.FONT.mono, fontSize: 11 }}>
        <span style={{
          width: 8, height: 8, borderRadius: 4,
          background: wsStatus.mode === 'live' ? window.COL.green :
            wsStatus.mode === 'sim' ? window.COL.accent :
            wsStatus.mode === 'connecting' ? '#fb8' : window.COL.red,
        }} />
        <span style={{ letterSpacing: 1.4, textTransform: 'uppercase' }}>
          {wsStatus.mode === 'sim' ? 'SIM DATA' :
            wsStatus.mode === 'live' ? 'LIVE WS' :
            wsStatus.mode === 'connecting' ? 'CONNECTING' : 'WS ERROR'}
        </span>
        {wsStatus.url && <span style={{ opacity: 0.6 }}>· {wsStatus.url}</span>}
      </div>

      {/* Settings panel toggle */}
      <button onClick={() => setPanelOpen((o) => !o)}
        style={{
          position: 'fixed', top: 12, right: 12, zIndex: 30,
          background: 'rgba(0,0,0,0.7)', color: '#fff',
          border: '1px solid rgba(255,255,255,0.15)',
          padding: '6px 14px', fontFamily: window.FONT.mono, fontSize: 11,
          letterSpacing: 1.4, textTransform: 'uppercase', cursor: 'pointer',
        }}>
        {panelOpen ? 'hide settings' : 'settings'}
      </button>

      <CanDebugPanel />

      {panelOpen && (
        <div style={{
          position: 'fixed', bottom: 12, right: 12, width: 360, zIndex: 25,
          background: 'rgba(12,12,14,0.96)', border: '1px solid rgba(255,255,255,0.12)',
          padding: 18, fontFamily: window.FONT.label, fontSize: 12,
          color: '#e4e4e7', maxHeight: 'calc(100vh - 70px)', overflow: 'auto',
        }}>
          <Section title="Data source">
            <label style={lblStyle}>WebSocket URL</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <input value={wsInput} onChange={(e) => setWsInput(e.target.value)}
                placeholder="ws://10.71.1.10:9080" style={inputStyle} />
              <button onClick={connectWs} style={btnStyle}>Connect</button>
            </div>
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              <button onClick={useSim} style={{ ...btnStyle, flex: 1 }}>
                Start Sim
              </button>
              <button 
                onClick={() => {
                  localStorage.removeItem(window.LS_WS_KEY);
                  window.wsService.disconnect();
                  window.wsService.stopSim();
                }} 
                style={{ ...btnStyle, flex: 1 }}>
                Stop Sim
              </button>
            </div>
            <div style={{ fontSize: 10, color: '#888', marginTop: 6, lineHeight: 1.5 }}>
              Falls back to sim if the socket drops. Matches the failover pattern
              in <code>pecan/src/services/WebSocketService.ts</code>.
            </div>
          </Section>

          <Section title="Video source (MediaMTX WHEP)">
            <label style={lblStyle}>MediaMTX host</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <input value={mtxInput} onChange={(e) => setMtxInput(e.target.value)}
                placeholder="10.71.1.20" style={inputStyle} />
              <button onClick={() => update({ mediamtxHost: mtxInput.trim() })} style={btnStyle}>Use</button>
            </div>
            <div style={{ fontSize: 10, color: '#888', marginTop: 6, lineHeight: 1.5 }}>
              Pulls <code>/car-camera/whep</code> on port 8889 — same path PECAN uses.
              Leave blank for placeholder; OBS can layer real video underneath.
            </div>
          </Section>

          <Section title="Layout">
            <div style={{ display: 'flex', gap: 6 }}>
              {['side-by-side', 'single'].map((l) => (
                <button key={l} onClick={() => update({ layout: l })}
                  style={{ ...btnStyle, flex: 1,
                    background: tweaks.layout === l ? window.COL.accent : 'transparent',
                    color: tweaks.layout === l ? '#0a0a0b' : '#e4e4e7' }}>
                  {l === 'side-by-side' ? 'Both' : 'Solo'}
                </button>
              ))}
            </div>
            {tweaks.layout === 'single' && (
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                {['A', 'B'].map((v) => (
                  <button key={v} onClick={() => update({ activeVariant: v })}
                    style={{ ...btnStyle, flex: 1,
                      background: tweaks.activeVariant === v ? window.COL.accent : 'transparent',
                      color: tweaks.activeVariant === v ? '#0a0a0b' : '#e4e4e7' }}>
                    {v === 'A' ? 'Broadcast Bar' : 'Corner HUD'}
                  </button>
                ))}
              </div>
            )}
          </Section>

          <Section title="Branding">
            <label style={lblStyle}>Car number</label>
            <input type="number" value={tweaks.carNumber}
              onChange={(e) => update({ carNumber: parseInt(e.target.value) || 26 })}
              style={inputStyle} />
          </Section>

          <Section title="OBS browser-source setup">
            <ol style={{ margin: 0, paddingLeft: 18, fontSize: 11, lineHeight: 1.6, color: '#c4c4c7' }}>
              <li>Add <b>Browser</b> source in OBS.</li>
              <li>URL: this page + <code>?variant=A&solo=1</code> (or B).</li>
              <li>Width 1920, Height 1080.</li>
              <li>Enable <b>Shutdown source when not visible</b>: off.</li>
              <li>Enable <b>Refresh when activated</b>: on.</li>
              <li>Custom CSS: <code>body{'{ '}background: transparent{' }'}</code> (overlay only).</li>
              <li>In OBS, stack your real video source under this. Hit <b>Go Live</b> → YouTube / Twitch.</li>
            </ol>
          </Section>
        </div>
      )}
    </div>
  );
}

const inputStyle = {
  flex: 1, background: 'rgba(0,0,0,0.4)', color: '#fff',
  border: '1px solid rgba(255,255,255,0.15)', padding: '6px 8px',
  fontFamily: window.FONT.mono, fontSize: 11, outline: 'none',
};
const btnStyle = {
  background: 'transparent', color: '#e4e4e7',
  border: '1px solid rgba(255,255,255,0.2)', padding: '6px 12px',
  fontFamily: window.FONT.label, fontSize: 11, letterSpacing: 1.2,
  textTransform: 'uppercase', cursor: 'pointer',
};
const lblStyle = {
  display: 'block', fontSize: 10, letterSpacing: 1.4, textTransform: 'uppercase',
  color: '#888', marginBottom: 4, marginTop: 4,
};

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: 14, paddingBottom: 12,
      borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
      <div style={{
        fontSize: 10, letterSpacing: 1.6, textTransform: 'uppercase',
        color: window.COL.accent, marginBottom: 8, fontWeight: 700,
      }}>{title}</div>
      {children}
    </div>
  );
}

function Labeled({ title, children }) {
  return (
    <div>
      <div style={{
        fontFamily: window.FONT.mono, fontSize: 13, letterSpacing: 2,
        color: 'rgba(255,255,255,0.5)', marginBottom: 12, textTransform: 'uppercase',
      }}>{title}</div>
      {children}
    </div>
  );
}

// URL params let OBS load a single variant, bare, at full size
(function applyUrlParams() {
  const u = new URL(location.href);
  if (u.searchParams.get('solo') === '1') {
    const v = u.searchParams.get('variant') || 'A';
    try {
      const t = JSON.parse(localStorage.getItem('wfr-tweaks') || '{}');
      localStorage.setItem('wfr-tweaks', JSON.stringify({ ...t, layout: 'single', activeVariant: v }));
    } catch {}
  }
})();

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);

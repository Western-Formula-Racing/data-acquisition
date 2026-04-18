// widgets.jsx — shared overlay primitives: gauges, waveforms, g-circle, warning flash.
// All widgets read straight from window.telemetryStore / useTelemetry().

const COL = {
  accent: '#D6AB39',        // WFR gold (README badge)
  accentDim: '#8c6f22',
  red: '#E63946',
  green: '#00E5A0',
  bg: 'rgba(10,10,11,0.72)',
  bgSolid: '#0a0a0b',
  chrome: 'rgba(255,255,255,0.08)',
  text: '#f4f4f5',
  textDim: 'rgba(244,244,245,0.6)',
  textMuted: 'rgba(244,244,245,0.35)',
};

const FONT = {
  label: '"Inter", "Helvetica Neue", Helvetica, Arial, sans-serif',
  mono: '"JetBrains Mono", "SF Mono", ui-monospace, monospace',
};

// ─── Big numeric readout ───────────────────────────────────────────────
function BigNumber({ label, value, unit, digits = 0, tone = 'default', size = 54, sublabel }) {
  const display = (typeof value === 'number' && isFinite(value))
    ? (digits === 0 ? Math.round(value).toString() : value.toFixed(digits))
    : '—';
  const color = tone === 'warn' ? COL.red : tone === 'accent' ? COL.accent : COL.text;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1 }}>
      <div style={{
        fontFamily: FONT.label, fontSize: 10, fontWeight: 600,
        letterSpacing: 1.4, color: COL.textDim, textTransform: 'uppercase',
        marginBottom: 4,
      }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <div style={{
          fontFamily: FONT.mono, fontSize: size, fontWeight: 500,
          color, fontVariantNumeric: 'tabular-nums',
          letterSpacing: -1,
        }}>{display}</div>
        {unit && (
          <div style={{
            fontFamily: FONT.mono, fontSize: size * 0.28, fontWeight: 500,
            color: COL.textDim, textTransform: 'lowercase',
          }}>{unit}</div>
        )}
      </div>
      {sublabel && (
        <div style={{
          fontFamily: FONT.label, fontSize: 10, color: COL.textMuted, marginTop: 2,
        }}>{sublabel}</div>
      )}
    </div>
  );
}

// ─── Horizontal bar (throttle / brake) ─────────────────────────────────
function BarMeter({ label, value, max = 100, color = COL.accent, height = 10, unit = '%' }) {
  const pct = Math.max(0, Math.min(1, (value ?? 0) / max));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{
          fontFamily: FONT.label, fontSize: 10, fontWeight: 600, letterSpacing: 1.4,
          color: COL.textDim, textTransform: 'uppercase',
        }}>{label}</span>
        <span style={{
          fontFamily: FONT.mono, fontSize: 13, color: COL.text,
          fontVariantNumeric: 'tabular-nums',
        }}>
          {typeof value === 'number' ? value.toFixed(0) : '—'}{unit}
        </span>
      </div>
      <div style={{
        position: 'relative', height, background: 'rgba(255,255,255,0.08)',
        borderRadius: 1, overflow: 'hidden',
      }}>
        <div style={{
          position: 'absolute', inset: 0, width: `${pct * 100}%`,
          background: color, transition: 'width 100ms linear',
        }} />
        {/* tick marks every 25% */}
        {[0.25, 0.5, 0.75].map((t) => (
          <div key={t} style={{
            position: 'absolute', top: 0, bottom: 0, left: `${t * 100}%`,
            width: 1, background: 'rgba(0,0,0,0.35)',
          }} />
        ))}
      </div>
    </div>
  );
}

// ─── Circular RPM gauge with animated needle ───────────────────────────
function RpmGauge({ rpm = 0, max = 8000, size = 220, redline = 6500, label = 'RPM' }) {
  const pct = Math.max(0, Math.min(1, rpm / max));
  const startAngle = -220;
  const endAngle = 40;
  const sweep = endAngle - startAngle;
  const needle = startAngle + pct * sweep;
  const r = size / 2 - 8;
  const cx = size / 2, cy = size / 2;

  // Build tick marks
  const ticks = [];
  for (let i = 0; i <= 10; i++) {
    const a = (startAngle + (i / 10) * sweep) * Math.PI / 180;
    const r1 = r, r2 = r - (i % 2 === 0 ? 14 : 8);
    const x1 = cx + Math.cos(a) * r1, y1 = cy + Math.sin(a) * r1;
    const x2 = cx + Math.cos(a) * r2, y2 = cy + Math.sin(a) * r2;
    const over = (i / 10) * max >= redline;
    ticks.push(
      <line key={i} x1={x1} y1={y1} x2={x2} y2={y2}
        stroke={over ? COL.red : COL.textDim}
        strokeWidth={i % 2 === 0 ? 2 : 1} />
    );
    if (i % 2 === 0) {
      const lr = r - 26;
      const lx = cx + Math.cos(a) * lr, ly = cy + Math.sin(a) * lr;
      ticks.push(
        <text key={`t${i}`} x={lx} y={ly} fill={over ? COL.red : COL.textDim}
          fontSize={10} fontFamily={FONT.mono}
          textAnchor="middle" dominantBaseline="middle">
          {((i / 10) * max / 1000).toFixed(0)}
        </text>
      );
    }
  }

  // Redline arc
  const arcStart = (startAngle + (redline / max) * sweep) * Math.PI / 180;
  const arcEnd = endAngle * Math.PI / 180;
  const arcR = r + 2;
  const ax1 = cx + Math.cos(arcStart) * arcR, ay1 = cy + Math.sin(arcStart) * arcR;
  const ax2 = cx + Math.cos(arcEnd) * arcR, ay2 = cy + Math.sin(arcEnd) * arcR;
  const largeArc = arcEnd - arcStart > Math.PI ? 1 : 0;

  const needleRad = needle * Math.PI / 180;
  const nx = cx + Math.cos(needleRad) * (r - 18);
  const ny = cy + Math.sin(needleRad) * (r - 18);

  const over = rpm >= redline;

  return (
    <div style={{ position: 'relative', width: size, height: size }}>
      <svg width={size} height={size} style={{ display: 'block' }}>
        {/* backplate */}
        <circle cx={cx} cy={cy} r={r + 4} fill="rgba(0,0,0,0.65)" />
        <circle cx={cx} cy={cy} r={r + 4} fill="none" stroke={COL.chrome} strokeWidth={1} />
        {/* redline arc */}
        <path d={`M ${ax1} ${ay1} A ${arcR} ${arcR} 0 ${largeArc} 1 ${ax2} ${ay2}`}
          stroke={COL.red} strokeWidth={3} fill="none" />
        {ticks}
        {/* needle */}
        <line x1={cx} y1={cy} x2={nx} y2={ny}
          stroke={over ? COL.red : COL.accent} strokeWidth={3}
          strokeLinecap="round"
          style={{ transition: 'all 90ms linear' }} />
        <circle cx={cx} cy={cy} r={6} fill={COL.bgSolid} stroke={COL.accent} strokeWidth={1.5} />
      </svg>
      <div style={{
        position: 'absolute', inset: 0, display: 'flex',
        flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        pointerEvents: 'none', paddingTop: size * 0.12,
      }}>
        <div style={{
          fontFamily: FONT.mono, fontSize: size * 0.22, fontWeight: 500,
          color: over ? COL.red : COL.text, letterSpacing: -1,
          fontVariantNumeric: 'tabular-nums',
        }}>{Math.round(rpm)}</div>
        <div style={{
          fontFamily: FONT.label, fontSize: 10, color: COL.textDim,
          letterSpacing: 1.4, textTransform: 'uppercase',
        }}>{label}</div>
      </div>
    </div>
  );
}

// ─── G-force dot with trail ────────────────────────────────────────────
function GCircle({ size = 160, maxG = 2.0 }) {
  const store = window.telemetryStore;
  const ax = store.get('ax')?.value ?? 0;   // longitudinal (Front_Accel_X)
  const ay = store.get('ay')?.value ?? 0;   // lateral (Front_Accel_Y)

  const trailRef = React.useRef([]);
  const [, force] = React.useState(0);
  React.useEffect(() => {
    const iv = setInterval(() => {
      trailRef.current.push({ x: ax, y: ay, t: Date.now() });
      const cutoff = Date.now() - 1500;
      trailRef.current = trailRef.current.filter((p) => p.t > cutoff).slice(-60);
      force((n) => n + 1);
    }, 60);
    return () => clearInterval(iv);
  }, [ax, ay]);

  const cx = size / 2, cy = size / 2;
  const r = size / 2 - 10;
  const sx = (g) => cx + (g / maxG) * r;
  const sy = (g) => cy - (g / maxG) * r;

  return (
    <div style={{ position: 'relative', width: size, height: size }}>
      <svg width={size} height={size}>
        <circle cx={cx} cy={cy} r={r + 4} fill="rgba(0,0,0,0.65)" />
        <circle cx={cx} cy={cy} r={r + 4} fill="none" stroke={COL.chrome} strokeWidth={1} />
        {[0.33, 0.66, 1].map((f, i) => (
          <circle key={i} cx={cx} cy={cy} r={r * f} fill="none"
            stroke={COL.chrome} strokeWidth={1} strokeDasharray={i === 2 ? '0' : '2 4'} />
        ))}
        <line x1={cx - r} y1={cy} x2={cx + r} y2={cy} stroke={COL.chrome} strokeWidth={1} />
        <line x1={cx} y1={cy - r} x2={cx} y2={cy + r} stroke={COL.chrome} strokeWidth={1} />
        {/* trail */}
        {trailRef.current.map((p, i) => {
          const age = (Date.now() - p.t) / 1500;
          return (
            <circle key={i} cx={sx(p.x)} cy={sy(p.y)} r={2}
              fill={COL.accent} opacity={1 - age} />
          );
        })}
        {/* current */}
        <circle cx={sx(ax)} cy={sy(ay)} r={5} fill={COL.accent} stroke="#fff" strokeWidth={1} />
      </svg>
      <div style={{
        position: 'absolute', top: 6, left: 10,
        fontFamily: FONT.label, fontSize: 9, letterSpacing: 1.4,
        color: COL.textDim, textTransform: 'uppercase',
      }}>G-FORCE</div>
      <div style={{
        position: 'absolute', bottom: 6, right: 10,
        fontFamily: FONT.mono, fontSize: 10, color: COL.textDim,
      }}>
        {ax.toFixed(2)}g / {ay.toFixed(2)}g
      </div>
    </div>
  );
}

// ─── Live data waveform (10s history) ───────────────────────────────────
function Waveform({ signal, width = 320, height = 70, color = COL.accent, label, unit = '', format = (v) => v.toFixed(0) }) {
  const store = window.telemetryStore;
  const hist = store.getHistory(signal);
  if (hist.length < 2) {
    return <div style={{ width, height, opacity: 0.3, fontFamily: FONT.mono,
      fontSize: 10, color: COL.textDim, padding: 8 }}>{label}: waiting…</div>;
  }
  const now = Date.now();
  const minT = now - 10_000;
  const vals = hist.map((p) => p.v);
  let mn = Math.min(...vals), mx = Math.max(...vals);
  if (mx - mn < 0.001) { mx = mn + 1; }
  const pad = (mx - mn) * 0.1;
  mn -= pad; mx += pad;
  const xOf = (t) => ((t - minT) / 10_000) * width;
  const yOf = (v) => height - 14 - ((v - mn) / (mx - mn)) * (height - 22);

  const d = hist.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xOf(p.t).toFixed(1)} ${yOf(p.v).toFixed(1)}`).join(' ');
  const last = hist[hist.length - 1];

  return (
    <div style={{ position: 'relative', width, height, background: 'rgba(0,0,0,0.55)',
      borderLeft: `2px solid ${color}`, padding: '6px 8px', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span style={{ fontFamily: FONT.label, fontSize: 9, letterSpacing: 1.4,
          color: COL.textDim, textTransform: 'uppercase' }}>{label}</span>
        <span style={{ fontFamily: FONT.mono, fontSize: 11, color: COL.text,
          fontVariantNumeric: 'tabular-nums' }}>
          {format(last.v)}{unit}
        </span>
      </div>
      <svg width={width - 16} height={height - 24} style={{ position: 'absolute', left: 8, top: 18 }}>
        <path d={d} fill="none" stroke={color} strokeWidth={1.5} opacity={0.9}
          transform={`translate(${-8}, 0)`} />
        <circle cx={xOf(last.t) - 8} cy={yOf(last.v) - 18} r={2} fill={color} />
      </svg>
    </div>
  );
}

// ─── Warning flash (low SOC / over-temp) ────────────────────────────────
function WarningFlash() {
  const store = window.telemetryStore;
  const soc = store.get('soc')?.value;
  const motorT = store.get('motor_temp')?.value;
  const packT = store.get('pack_t')?.value;
  const warnings = [];
  if (typeof soc === 'number' && soc < 20) warnings.push({ code: 'LOW SOC', msg: `${soc.toFixed(0)}%` });
  if (typeof motorT === 'number' && motorT > 80) warnings.push({ code: 'MOTOR TEMP', msg: `${motorT.toFixed(0)}°C` });
  if (typeof packT === 'number' && packT > 55) warnings.push({ code: 'PACK TEMP', msg: `${packT.toFixed(0)}°C` });
  if (!warnings.length) return null;
  return (
    <div style={{
      position: 'absolute', top: 90, left: '50%', transform: 'translateX(-50%)',
      display: 'flex', gap: 8, zIndex: 20,
    }}>
      {warnings.map((w, i) => (
        <div key={i} style={{
          background: COL.red, color: '#fff', padding: '6px 14px',
          fontFamily: FONT.label, fontSize: 12, fontWeight: 700,
          letterSpacing: 2, textTransform: 'uppercase',
          animation: 'wfrflash 0.7s ease-in-out infinite alternate',
          clipPath: 'polygon(8px 0, 100% 0, calc(100% - 8px) 100%, 0 100%)',
          paddingLeft: 18, paddingRight: 18,
        }}>
          ⚠ {w.code} · {w.msg}
        </div>
      ))}
    </div>
  );
}

// ─── REC indicator ─────────────────────────────────────────────────────
function RecIndicator() {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6,
      fontFamily: FONT.label, fontSize: 10, fontWeight: 700, letterSpacing: 1.6,
      color: COL.text, textTransform: 'uppercase',
    }}>
      <span style={{
        width: 8, height: 8, borderRadius: 4, background: COL.red,
        animation: 'wfrrecpulse 1.2s ease-in-out infinite',
      }} />
      REC · LIVE
    </div>
  );
}

// ─── WFR car # lockup ──────────────────────────────────────────────────
function TeamMark({ carNumber = 33, dark = true }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '8px 12px', background: dark ? 'rgba(0,0,0,0.55)' : 'transparent',
      border: `1px solid ${COL.chrome}`,
    }}>
      <div style={{
        width: 36, height: 36, background: COL.accent, color: COL.bgSolid,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: FONT.label, fontSize: 20, fontWeight: 900, fontStyle: 'italic',
        letterSpacing: -1,
      }}>W</div>
      <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1 }}>
        <span style={{
          fontFamily: FONT.label, fontSize: 11, fontWeight: 700, letterSpacing: 1.6,
          color: COL.text, textTransform: 'uppercase',
        }}>Western Formula Racing</span>
        <span style={{
          fontFamily: FONT.mono, fontSize: 10, color: COL.accent, marginTop: 2,
        }}>CAR #{carNumber} · FSAE</span>
      </div>
    </div>
  );
}

Object.assign(window, {
  COL, FONT, BigNumber, BarMeter, RpmGauge, GCircle, Waveform,
  WarningFlash, RecIndicator, TeamMark,
});

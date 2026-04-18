// overlays.jsx — two F1-broadcast-style variants that composite over the
// video feed. Both are 1920×1080 native.

// ═══ Variant A — "Broadcast Bar" ══════════════════════════════════════
// Bottom ticker bar + top-left team lockup + top-right status + RPM needle
// in bottom-right, mirroring classic F1 TV graphics.
function OverlayBroadcastBar({ carNumber = 33 }) {
  window.useTelemetry();
  const store = window.telemetryStore;
  const rpm = store.get('rpm')?.value ?? 0;
  const throttle = store.get('throttle')?.value ?? 0;
  const brake = store.get('brake')?.value ?? 0;
  const soc = store.get('soc')?.value ?? 0;
  const packV = store.get('pack_v')?.value ?? 0;
  const packI = store.get('pack_i')?.value ?? 0;
  const motorT = store.get('motor_temp')?.value ?? 0;
  const packT = store.get('pack_t')?.value ?? 0;
  const steer = store.get('steer')?.value ?? 0;
  const speedKmh = rpm / 500;

  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none',
      fontFamily: window.FONT.label, color: window.COL.text }}>

      {/* Top-left: team lockup */}
      <div style={{ position: 'absolute', top: 24, left: 24 }}>
        <window.TeamMark carNumber={carNumber} />
      </div>

      {/* Top-right: REC + connection */}
      <div style={{ position: 'absolute', top: 24, right: 24,
        display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
        <div style={{ background: 'rgba(0,0,0,0.55)', padding: '8px 12px',
          border: `1px solid ${window.COL.chrome}`, display: 'flex', gap: 14 }}>
          <window.RecIndicator />
          <span style={{ fontFamily: window.FONT.mono, fontSize: 10,
            color: window.COL.textDim, letterSpacing: 1.4 }}>
            1080p · 50 Hz TELEMETRY
          </span>
        </div>
      </div>

      {/* Warning flash */}
      <window.WarningFlash />

      {/* Right side: waveforms stacked (last 10s) */}
      <div style={{ position: 'absolute', top: 130, right: 24,
        display: 'flex', flexDirection: 'column', gap: 6 }}>
        <window.Waveform signal="rpm" label="RPM" color={window.COL.accent}
          width={280} height={60} format={(v) => v.toFixed(0)} />
        <window.Waveform signal="throttle" label="Throttle" color={window.COL.green}
          width={280} height={60} unit="%" format={(v) => v.toFixed(0)} />
        <window.Waveform signal="brake" label="Brake" color={window.COL.red}
          width={280} height={60} unit="%" format={(v) => v.toFixed(0)} />
      </div>

      {/* RPM gauge bottom-right, above the bar */}
      <div style={{ position: 'absolute', right: 40, bottom: 170 }}>
        <window.RpmGauge rpm={rpm} max={8000} redline={6500} size={220} />
      </div>

      {/* Bottom broadcast bar */}
      <div style={{
        position: 'absolute', left: 0, right: 0, bottom: 0,
        height: 140, background: 'linear-gradient(to top, rgba(0,0,0,0.9) 0%, rgba(0,0,0,0.75) 60%, rgba(0,0,0,0) 100%)',
      }}>
        {/* accent stripe */}
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 110, height: 3,
          background: `linear-gradient(90deg, ${window.COL.accent} 0%, ${window.COL.accent} 30%, transparent 100%)` }} />

        <div style={{ position: 'absolute', left: 40, right: 40, bottom: 20,
          display: 'flex', alignItems: 'flex-end', gap: 40 }}>

          {/* Speed block — hero */}
          <div style={{ borderRight: `1px solid ${window.COL.chrome}`, paddingRight: 36 }}>
            <window.BigNumber label="SPEED" value={speedKmh} unit="km/h" size={72} tone="accent" />
          </div>

          {/* Throttle/Brake bars */}
          <div style={{ width: 240, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <window.BarMeter label="THROTTLE" value={throttle} color={window.COL.green} />
            <window.BarMeter label="BRAKE" value={brake} max={100} color={window.COL.red} unit="%" />
            <div style={{ display: 'flex', justifyContent: 'space-between',
              fontFamily: window.FONT.mono, fontSize: 11, color: window.COL.textDim }}>
              <span>STEER</span>
              <span style={{ color: window.COL.text }}>{steer.toFixed(0)}°</span>
            </div>
          </div>

          {/* Battery block */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6,
            borderLeft: `1px solid ${window.COL.chrome}`, paddingLeft: 36, flex: 1 }}>
            <div style={{ display: 'flex', gap: 32 }}>
              <window.BigNumber label="SOC" value={soc} unit="%" size={36}
                tone={soc < 20 ? 'warn' : 'default'} digits={0} />
              <window.BigNumber label="PACK V" value={packV} unit="V" size={36} digits={1} />
              <window.BigNumber label="PACK I" value={packI} unit="A" size={36} digits={1} />
            </div>
            <div style={{ display: 'flex', gap: 32, marginTop: 2 }}>
              <div style={{ fontFamily: window.FONT.mono, fontSize: 11, color: window.COL.textDim }}>
                MOT <span style={{ color: motorT > 80 ? window.COL.red : window.COL.text }}>
                  {motorT.toFixed(0)}°C</span>
              </div>
              <div style={{ fontFamily: window.FONT.mono, fontSize: 11, color: window.COL.textDim }}>
                PACK <span style={{ color: packT > 55 ? window.COL.red : window.COL.text }}>
                  {packT.toFixed(0)}°C</span>
              </div>
            </div>
          </div>
        </div>

        {/* Session ticker */}
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 20,
          background: window.COL.accent, color: window.COL.bgSolid,
          display: 'flex', alignItems: 'center', paddingLeft: 40, gap: 24,
          fontFamily: window.FONT.label, fontSize: 10, fontWeight: 700, letterSpacing: 2 }}>
          <span>PRACTICE · SESSION 3</span>
          <span style={{ opacity: 0.7 }}>·</span>
          <span>LAP 7</span>
          <span style={{ opacity: 0.7 }}>·</span>
          <span style={{ fontFamily: window.FONT.mono }}>1:24.317</span>
          <span style={{ opacity: 0.7 }}>·</span>
          <span>AMBIENT 18°C · TRACK 24°C · DRY</span>
        </div>
      </div>
    </div>
  );
}

// ═══ Variant B — "Corner HUD" ═════════════════════════════════════════
// Sparser, more cinematic. One big speed number center-bottom, corner gauges,
// no full bottom bar — keeps the center-safe zone open for action.
function OverlayCornerHud({ carNumber = 33 }) {
  window.useTelemetry();
  const store = window.telemetryStore;
  const rpm = store.get('rpm')?.value ?? 0;
  const throttle = store.get('throttle')?.value ?? 0;
  const brake = store.get('brake')?.value ?? 0;
  const soc = store.get('soc')?.value ?? 0;
  const packV = store.get('pack_v')?.value ?? 0;
  const motorT = store.get('motor_temp')?.value ?? 0;
  const steer = store.get('steer')?.value ?? 0;
  const speedKmh = rpm / 500;

  const cornerBox = {
    background: 'rgba(10,10,11,0.55)',
    border: `1px solid ${window.COL.chrome}`,
    backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
    padding: 16,
  };

  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none',
      fontFamily: window.FONT.label, color: window.COL.text }}>

      {/* Top-left: small team lockup */}
      <div style={{ position: 'absolute', top: 32, left: 32 }}>
        <window.TeamMark carNumber={carNumber} />
      </div>

      {/* Top-right: session + REC */}
      <div style={{ position: 'absolute', top: 32, right: 32, ...cornerBox,
        display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
        <window.RecIndicator />
        <div style={{ fontFamily: window.FONT.mono, fontSize: 10,
          color: window.COL.textDim, letterSpacing: 1 }}>
          LAP 7 · 1:24.317
        </div>
      </div>

      {/* Top-right waveforms (last 10s) — ported from Variant A */}
      <div style={{ position: 'absolute', top: 128, right: 32,
        display: 'flex', flexDirection: 'column', gap: 6 }}>
        <window.Waveform signal="rpm" label="RPM" color={window.COL.accent}
          width={280} height={60} format={(v) => v.toFixed(0)} />
        <window.Waveform signal="throttle" label="Throttle" color={window.COL.green}
          width={280} height={60} unit="%" format={(v) => v.toFixed(0)} />
        <window.Waveform signal="brake" label="Brake" color={window.COL.red}
          width={280} height={60} unit="%" format={(v) => v.toFixed(0)} />
      </div>

      <window.WarningFlash />

      {/* Bottom-left: G-force trail */}
      <div style={{ position: 'absolute', bottom: 36, left: 36, ...cornerBox, padding: 8 }}>
        <window.GCircle size={170} maxG={2.0} />
      </div>

      {/* Bottom-right: RPM + numerics */}
      <div style={{ position: 'absolute', bottom: 36, right: 36,
        display: 'flex', alignItems: 'flex-end', gap: 16 }}>
        <div style={{ ...cornerBox, padding: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, auto)',
            gap: '10px 22px', marginBottom: 10 }}>
            <window.BigNumber label="SOC" value={soc} unit="%" size={28}
              tone={soc < 20 ? 'warn' : 'default'} />
            <window.BigNumber label="PACK" value={packV} unit="V" size={28} digits={0} />
            <window.BigNumber label="MOT T" value={motorT} unit="°C" size={28}
              tone={motorT > 80 ? 'warn' : 'default'} />
            <window.BigNumber label="STEER" value={steer} unit="°" size={28} />
          </div>
        </div>
        <window.RpmGauge rpm={rpm} max={8000} redline={6500} size={200} />
      </div>

      {/* Center-bottom: cinematic speed */}
      <div style={{ position: 'absolute', bottom: 60, left: '50%',
        transform: 'translateX(-50%)', textAlign: 'center',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
        <div style={{
          fontFamily: window.FONT.mono,
          fontSize: 140, fontWeight: 300,
          color: window.COL.text, letterSpacing: -4, lineHeight: 1,
          fontVariantNumeric: 'tabular-nums',
          textShadow: '0 4px 32px rgba(0,0,0,0.8)',
        }}>
          {Math.round(speedKmh)}
          <span style={{ fontSize: 26, color: window.COL.accent, marginLeft: 10,
            letterSpacing: 2, fontWeight: 500 }}>km/h</span>
        </div>
        {/* Throttle/brake dual bar */}
        <div style={{ display: 'flex', gap: 6, width: 360, height: 6 }}>
          <div style={{ flex: 1, background: 'rgba(255,255,255,0.1)',
            position: 'relative', overflow: 'hidden', transform: 'scaleX(-1)' }}>
            <div style={{ position: 'absolute', right: 0, top: 0, bottom: 0,
              width: `${Math.min(100, brake)}%`,
              background: window.COL.red, transition: 'width 80ms linear' }} />
          </div>
          <div style={{ flex: 1, background: 'rgba(255,255,255,0.1)',
            position: 'relative', overflow: 'hidden' }}>
            <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0,
              width: `${Math.min(100, throttle)}%`,
              background: window.COL.green, transition: 'width 80ms linear' }} />
          </div>
        </div>
        <div style={{ display: 'flex', width: 360, justifyContent: 'space-between',
          fontFamily: window.FONT.label, fontSize: 9, letterSpacing: 1.4,
          color: window.COL.textDim, textTransform: 'uppercase' }}>
          <span>← BRAKE</span>
          <span>THROTTLE →</span>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { OverlayBroadcastBar, OverlayCornerHud });

import type { SdStatus } from "../../../../lib/wcars/sdSignals";

interface Props {
  label: string;
  value: number | null;
  range: [number, number];
  unit?: string;
  status: SdStatus;
  decimals?: number;
  sweepDeg?: number;
}

const R = 42;
const CX = 50;
const CY = 50;

function polar(cx: number, cy: number, r: number, deg: number) {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function arcPath(startDeg: number, endDeg: number, r: number) {
  const s = polar(CX, CY, r, startDeg);
  const e = polar(CX, CY, r, endDeg);
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${s.x} ${s.y} A ${r} ${r} 0 ${large} 1 ${e.x} ${e.y}`;
}

export function EcvMGauge({
  label, value, range, unit, status, decimals = 0, sweepDeg = 240,
}: Props) {
  const [min, max] = range;
  const start = -sweepDeg / 2;
  const end = sweepDeg / 2;
  const clamped = value === null ? min : Math.min(max, Math.max(min, value));
  const frac = (clamped - min) / (max - min || 1);
  const needleDeg = start + frac * (end - start);
  const tip = polar(CX, CY, R - 6, needleDeg);
  const text = value === null || status === "missing" ? "XX" : value.toFixed(decimals);

  return (
    <div className={`wcars-gauge wcars-gauge--${status}`}>
      <svg viewBox="0 0 100 70" className="wcars-gauge-svg" aria-hidden="true">
        <path className="wcars-gauge-track" d={arcPath(start, end, R)} fill="none" />
        <line
          className="wcars-gauge-needle"
          x1={CX} y1={CY} x2={tip.x} y2={tip.y}
        />
        <circle className="wcars-gauge-hub" cx={CX} cy={CY} r={2.5} />
      </svg>
      <div className="wcars-gauge-readout">
        <span className="wcars-gauge-label">{label}</span>
        <span className="wcars-gauge-value">{text}</span>
        {unit ? <span className="wcars-gauge-unit">{unit}</span> : null}
      </div>
    </div>
  );
}

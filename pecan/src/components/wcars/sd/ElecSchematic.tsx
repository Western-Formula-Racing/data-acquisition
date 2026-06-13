import type { SdValue } from "../../../lib/wcars/sdSignals";
import { useSdValue } from "../../../lib/wcars/sdSignals";

/** A telemetry readout pinned to a schematic coordinate.
 *  label sits above, value + unit below, coloured by status. */
function Readout({
  x, y, label, sd, decimals = 0, anchor = "middle",
}: {
  x: number;
  y: number;
  label: string;
  sd: SdValue;
  decimals?: number;
  anchor?: "start" | "middle" | "end";
}) {
  const text =
    sd.value === null || sd.status === "missing" ? "XX" : sd.value.toFixed(decimals);
  return (
    <g
      transform={`translate(${x},${y})`}
      textAnchor={anchor}
      className={`wcars-rd wcars-rd--${sd.status}`}
    >
      <text className="wcars-rd-lbl" y={0}>{label}</text>
      <text className="wcars-rd-val" y={30}>
        {text}
        {sd.unit ? <tspan className="wcars-rd-unit" dx={6}>{sd.unit}</tspan> : null}
      </text>
    </g>
  );
}

export function ElecSchematic() {
  const v = useSdValue("packV");
  const a = useSdValue("packA");
  const soc = useSdValue("packSoc");
  const dcl = useSdValue("packDcl");
  const ccl = useSdValue("packCcl");
  const busV = useSdValue("busV");
  const busA = useSdValue("busA");

  // Bus is "energized" when DC bus voltage is present and meaningfully high.
  const energized = busV.status !== "missing" && (busV.value ?? 0) > 50;
  const flow = energized ? " wcars-flow--on" : "";

  // SoC bar fill (bottom-up).
  const socFrac = soc.value === null ? 0 : Math.min(1, Math.max(0, soc.value / 100));
  const BAR_X = 98, BAR_Y = 210, BAR_W = 54, BAR_H = 180;
  const fillH = BAR_H * socFrac;

  // Current direction along the bus→inverter pipe: discharge (→) vs charge (←).
  const discharging = (busA.value ?? 0) >= 0;
  const ax = 655; // arrow centre x on the bus→inverter pipe
  const ay = 290;
  const dir = discharging ? 1 : -1;
  const arrowPts = `${ax - dir * 8},${ay - 8} ${ax - dir * 8},${ay + 8} ${ax + dir * 10},${ay}`;

  // Switch arm endpoint: closed (horizontal) when energized, else lifted.
  const armEnd = energized ? { x: 510, y: 290 } : { x: 505, y: 266 };

  return (
    <div className="wcars-syn wcars-syn-elec wcars-elec-schem" data-testid="syn-elec">
      <div className="wcars-syn-title">ELEC / BATT</div>
      <svg viewBox="0 0 1000 540" className="wcars-schem-svg" role="img" aria-label="Electrical synoptic">
        {/* ---- HV BATTERY PACK ---- */}
        <rect className="wcars-schem-box" x={70} y={150} width={310} height={270} rx={10} />
        <text className="wcars-schem-head" x={225} y={184} textAnchor="middle">HV BATT</text>

        {/* SoC bar */}
        <rect className="wcars-soc-track" x={BAR_X} y={BAR_Y} width={BAR_W} height={BAR_H} />
        <rect
          className={`wcars-soc-fill wcars-soc-fill--${soc.status}`}
          x={BAR_X} y={BAR_Y + (BAR_H - fillH)} width={BAR_W} height={fillH}
        />
        <Readout x={BAR_X + BAR_W / 2} y={BAR_Y + BAR_H + 34} label="SOC" sd={soc} />

        {/* Pack readouts */}
        <Readout x={280} y={232} label="HV" sd={v} />
        <Readout x={280} y={322} label="CURR" sd={a} />

        {/* Positive terminal nub */}
        <rect className="wcars-schem-term" x={380} y={272} width={16} height={36} />

        {/* ---- CONTACTOR (K1) ---- */}
        <text className="wcars-schem-tag" x={480} y={252} textAnchor="middle">K1</text>
        <line className={`wcars-flow${flow}`} x1={396} y1={290} x2={450} y2={290} />
        <circle className="wcars-schem-node" cx={450} cy={290} r={6} />
        <line
          className={`wcars-schem-arm${energized ? " wcars-schem-arm--closed" : ""}`}
          x1={450} y1={290} x2={armEnd.x} y2={armEnd.y}
        />
        <circle className="wcars-schem-node" cx={510} cy={290} r={6} />
        <line className={`wcars-flow${flow}`} x1={510} y1={290} x2={582} y2={290} />

        {/* ---- HV BUS BAR ---- */}
        <rect className={`wcars-schem-bus${flow}`} x={582} y={160} width={9} height={300} />
        <text className="wcars-schem-head" x={586} y={146} textAnchor="middle">HV BUS</text>

        {/* ---- BUS → INVERTER pipe + flow arrow ---- */}
        <line className={`wcars-flow${flow}`} x1={591} y1={290} x2={720} y2={290} />
        <polygon className={`wcars-flow-arrow${flow}`} points={arrowPts} />
        <Readout x={655} y={232} label="BUS V" sd={busV} decimals={1} />
        <Readout x={655} y={332} label="BUS A" sd={busA} decimals={1} />

        {/* ---- INVERTER / DRIVE ---- */}
        <rect className="wcars-schem-box" x={720} y={190} width={220} height={200} rx={8} />
        <text className="wcars-schem-head" x={830} y={236} textAnchor="middle">INV / DRIVE</text>
        <circle className="wcars-schem-node" cx={830} cy={300} r={26} fill="none" />
        <text className="wcars-schem-tag" x={830} y={308} textAnchor="middle">M</text>

        {/* ---- CURRENT LIMITS (envelope) ---- */}
        <Readout x={160} y={500} label="DISCH LIM" sd={dcl} anchor="middle" />
        <Readout x={300} y={500} label="CHG LIM" sd={ccl} anchor="middle" />
      </svg>
    </div>
  );
}

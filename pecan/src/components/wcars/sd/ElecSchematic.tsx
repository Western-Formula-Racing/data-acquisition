import type { SdValue } from "../../../lib/wcars/sdSignals";
import { useSdValue } from "../../../lib/wcars/sdSignals";
import { usePackAggregates, usePackTemp } from "../../../lib/wcars/packAggregates";
import { predictedPackV, predictedSagV } from "../../../lib/wcars/batteryModel";

/** Health of the battery model: how closely the measured (summed) pack
 *  voltage tracks the OCV-predicted value at the current SoC. A small
 *  delta is normal during current draw (== sag). At rest, the delta
 *  should be ≈ 0. */
type Health = "ok" | "drift" | "bad" | "missing";
function healthFromDelta(deltaV: number): Health {
  const ad = Math.abs(deltaV);
  if (ad < 2) return "ok";
  if (ad < 8) return "drift";
  return "bad";
}

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
  const pack = usePackAggregates();
  // Synthetic SdValue for the computed pack voltage, so the existing
  // EcvMValueBox status logic still works.
  const packVsd: SdValue = {
    value: pack.cellCount > 0 ? pack.packVoltage : null,
    label: "",
    unit: "V",
    status: pack.cellCount > 0 ? "normal" : "missing",
  };
  const a = useSdValue("packA");
  const soc = useSdValue("packSoc");
  const dcl = useSdValue("packDcl");
  const ccl = useSdValue("packCcl");
  const busV = useSdValue("busV");
  const busA = useSdValue("busA");
  const airPos = useSdValue("airPos");
  const airNeg = useSdValue("airNeg");

  // Bus is energized when both halves of the AIR contactor pair are closed.
  const airPosClosed = airPos.status !== "missing" && (airPos.value ?? 0) >= 1;
  const airNegClosed = airNeg.status !== "missing" && (airNeg.value ?? 0) >= 0.5;
  const energized = airPosClosed && airNegClosed;
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

  // OCV model: predict the open-circuit pack voltage at the current SoC,
  // and the expected sag at the current draw + pack temperature.
  const packT = usePackTemp();
  const socFrac2 = (soc.value ?? 0) / 100;
  const hasSoc = soc.status !== "missing" && soc.value !== null;
  const hasCells = pack.cellCount > 0;
  const hasTemp = packT.tempC !== null;
  const hasCurrent = a.status !== "missing" && a.value !== null;
  const predV = hasSoc ? predictedPackV(socFrac2) : null;
  const sagV =
    hasSoc && hasCurrent && hasTemp
      ? predictedSagV(a.value ?? 0, socFrac2, packT.tempC ?? 25)
      : null;
  const measV = hasCells ? pack.packVoltage : null;
  // At rest (low current), the measured pack V should ≈ OCV-predicted. Under
  // load, the difference ≈ sag. We surface the raw delta for honesty; the
  // HEALTH field classifies the magnitude.
  const deltaV = measV !== null && predV !== null ? measV - predV : null;
  const health: Health = deltaV === null ? "missing" : healthFromDelta(deltaV);

  return (
    <div className="wcars-syn wcars-syn-elec wcars-elec-schem" data-testid="syn-elec">
      <div className="wcars-syn-title">ELEC / BATT</div>
      <svg viewBox="0 0 1000 540" className="wcars-schem-svg" role="img" aria-label="Electrical synoptic" preserveAspectRatio="xMidYMid meet">
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
        <Readout x={280} y={232} label="HV" sd={packVsd} decimals={1} />
        <Readout x={280} y={322} label="CURR" sd={a} />

        {/* Positive terminal nub */}
        <rect className="wcars-schem-term" x={380} y={272} width={16} height={36} />

        {/* ---- AIR (accumulator isolation relay pair), closed when both halves are made ---- */}
        <text className="wcars-schem-tag" x={480} y={252} textAnchor="middle">AIR+ / AIR-</text>
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

        {/* ---- HEALTH PANEL: MEAS vs PRED vs SAG ---- */}
        <rect className="wcars-health-panel" x={410} y={445} width={530} height={85} rx={6} />
        <text className="wcars-schem-head wcars-schem-head--small" x={420} y={463}>BATTERY HEALTH (100S)</text>
        <text className="wcars-schem-tag" x={420} y={478} textAnchor="start">
          cell Δ {hasCells ? `${(((pack.maxVoltage ?? 0) - (pack.minVoltage ?? 0)) * 1000).toFixed(0)} mV · ${pack.cellCount} cells` : "—"}
        </text>
        <text className={`wcars-health-cell wcars-health-cell--${health}`} x={490} y={505} textAnchor="middle">
          <tspan className="wcars-health-lbl" x={490} dy={0}>MEAS</tspan>
          <tspan className="wcars-health-val" x={490} dy={20}>
            {measV === null ? "XX" : `${measV.toFixed(1)} V`}
          </tspan>
        </text>
        <text className="wcars-health-cell" x={610} y={505} textAnchor="middle">
          <tspan className="wcars-health-lbl" x={610} dy={0}>PRED</tspan>
          <tspan className="wcars-health-val" x={610} dy={20}>
            {predV === null ? "XX" : `${predV.toFixed(1)} V`}
          </tspan>
        </text>
        <text className="wcars-health-cell" x={730} y={505} textAnchor="middle">
          <tspan className="wcars-health-lbl" x={730} dy={0}>SAG</tspan>
          <tspan className="wcars-health-val" x={730} dy={20}>
            {sagV === null ? "XX" : `${sagV.toFixed(1)} V`}
          </tspan>
        </text>
        <text className="wcars-health-cell" x={850} y={505} textAnchor="middle">
          <tspan className="wcars-health-lbl" x={850} dy={0}>Δ</tspan>
          <tspan className="wcars-health-val" x={850} dy={20}>
            {deltaV === null ? "XX" : `${deltaV >= 0 ? "+" : ""}${deltaV.toFixed(1)} V`}
          </tspan>
        </text>
        <text className="wcars-schem-tag" x={930} y={463} textAnchor="end">
          T {packT.tempC === null ? "XX" : `${packT.tempC.toFixed(1)}°C`} · {packT.sensorsRead}/{packT.totalSensors} thm
        </text>
      </svg>
    </div>
  );
}

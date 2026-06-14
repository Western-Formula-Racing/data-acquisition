import type { SdValue } from "../../../lib/wcars/sdSignals";
import { useSdValue } from "../../../lib/wcars/sdSignals";

/** A pinned thermal readout with a small coloured dot keyed to status. */
function Therm({
  x, y, label, sd, decimals = 1, anchor = "middle",
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
      <circle className="wcars-therm-dot" cx={0} cy={-6} r={6} />
      <text className="wcars-rd-lbl" y={16}>{label}</text>
      <text className="wcars-rd-val" y={44}>
        {text}
        <tspan className="wcars-rd-unit" dx={6}>°C</tspan>
      </text>
    </g>
  );
}

export function CoolSchematic() {
  const coolant = useSdValue("coolant");
  const motor = useSdValue("motorTemp");
  const hot = useSdValue("hotSpot");
  const gate = useSdValue("gateTemp");
  const modA = useSdValue("modA");
  const modB = useSdValue("modB");
  const modC = useSdValue("modC");

  // Peak read-out picks the highest-status sensor so the operator sees the
  // worst of the thermal picture, not the average.
  const sensors = [motor, hot, gate, modA, modB, modC];
  const rank = { normal: 0, missing: 1, caution: 2, warning: 3 } as const;
  const peak = sensors.reduce<SdValue>((acc, s) => (rank[s.status] > rank[acc.status] ? s : acc), coolant);

  return (
    <div className="wcars-syn wcars-syn-cool wcars-cool-schem" data-testid="syn-cool">
      <div className="wcars-syn-title">COOL / THERMAL</div>
      <svg viewBox="0 0 1000 540" className="wcars-schem-svg" role="img" aria-label="Cooling / thermal synoptic">
        {/* ---- INVERTER BLOCK ---- */}
        <rect className="wcars-schem-box" x={260} y={110} width={480} height={300} rx={10} />
        <text className="wcars-schem-head" x={500} y={144} textAnchor="middle">INVERTER / MOTOR</text>

        {/* IGBT modules A / B / C sit along the bottom of the inverter block */}
        <Therm x={340} y={310} label="MOD A" sd={modA} />
        <Therm x={500} y={310} label="MOD B" sd={modB} />
        <Therm x={660} y={310} label="MOD C" sd={modC} />

        {/* Motor (winding) + gate-driver board along the top */}
        <Therm x={380} y={210} label="MOTOR" sd={motor} />
        <Therm x={500} y={210} label="GATE" sd={gate} />

        {/* Hot spot — internal, hottest point */}
        <Therm x={620} y={210} label="HOT" sd={hot} />

        {/* ---- COOLANT INLET (outlet not telemetered on WFR25) ---- */}
        <text className="wcars-schem-tag" x={120} y={200}>COOLANT IN</text>
        <line
          className={`wcars-cool-pipe wcars-cool-pipe--${coolant.status}`}
          x1={120} y1={210} x2={258} y2={210}
        />
        <Therm x={170} y={280} label="IN" sd={coolant} />

        {/* Return from inverter to ambient (no radiator temp sensor; show the
            path as dim/dashed, never animated green — that would imply a
            telemetered flow we don't have). */}
        <line
          className="wcars-cool-return"
          x1={740} y1={210} x2={880} y2={210}
        />
        <text className="wcars-schem-tag" x={810} y={200}>COOLANT OUT</text>
        <text className="wcars-schem-tag wcars-schem-tag--dim" x={810} y={240}>no sensor</text>

        {/* ---- PEAK TEMP READOUT ---- */}
        <rect
          className={`wcars-cool-peak wcars-cool-peak--${peak.status}`}
          x={260} y={445} width={480} height={70} rx={8}
        />
        <text className="wcars-cool-peak-lbl" x={290} y={488}>PEAK</text>
        <text
          className="wcars-cool-peak-val"
          x={500} y={497} textAnchor="middle"
        >
          {peak.value === null || peak.status === "missing" ? "XX" : peak.value.toFixed(1)}
          <tspan className="wcars-cool-peak-unit" dx={8}>°C</tspan>
        </text>
      </svg>
    </div>
  );
}

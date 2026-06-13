import type { SdValue } from "../../../lib/wcars/sdSignals";
import { useSdValue } from "../../../lib/wcars/sdSignals";
import { seriesEnergized } from "../../../lib/wcars/safetyLoop";

/** A boolean telemetry signal is "on" when present and >= 0.5. */
function isOn(sd: SdValue): boolean {
  return sd.status !== "missing" && (sd.value ?? 0) >= 0.5;
}

const RAIL_Y = 120;

/** One normally-open safety contact sitting on the loop rail. */
function Contact({ cx, label, sd }: { cx: number; label: string; sd: SdValue }) {
  const present = sd.status !== "missing";
  const closed = isOn(sd);
  const cls = !present ? "missing" : closed ? "closed" : "open";
  const word = !present ? "XX" : closed ? "CLOSED" : "OPEN";
  return (
    <g className={`wcars-contact wcars-contact--${cls}`} textAnchor="middle">
      <circle className="wcars-contact-term" cx={cx - 32} cy={RAIL_Y} r={5} />
      <circle className="wcars-contact-term" cx={cx + 32} cy={RAIL_Y} r={5} />
      <line
        className="wcars-contact-arm"
        x1={cx - 32}
        y1={RAIL_Y}
        x2={closed ? cx + 32 : cx + 22}
        y2={closed ? RAIL_Y : RAIL_Y - 26}
      />
      <text className="wcars-contact-lbl" x={cx} y={RAIL_Y + 48}>{label}</text>
      <text className="wcars-contact-state" x={cx} y={RAIL_Y + 70}>{word}</text>
    </g>
  );
}

/** Small round status lamp with a caption. */
function Indicator({ x, y, label, sd }: { x: number; y: number; label: string; sd: SdValue }) {
  const present = sd.status !== "missing";
  const on = isOn(sd);
  const cls = !present ? "missing" : on ? "on" : "off";
  return (
    <g className={`wcars-ind wcars-ind--${cls}`} textAnchor="middle">
      <circle className="wcars-ind-dot" cx={x} cy={y} r={11} />
      <text className="wcars-ind-lbl" x={x} y={y + 30}>{label}</text>
    </g>
  );
}

export function SafetySynoptic() {
  const imd = useSdValue("imdRelay");
  const ams = useSdValue("amsRelay");
  const bspd = useSdValue("bspdRelay");
  const latch = useSdValue("latchRelay");
  const loopReturn = useSdValue("loopReturn");
  const hv = useSdValue("hvActive");
  const pcEn = useSdValue("prechargeEnable");
  const pcOk = useSdValue("prechargeOk");
  const state = useSdValue("packState");

  // Series conduction: IMD → AMS → BSPD → Latch.
  const closed = [imd, ams, bspd, latch].map(isOn);
  const nodes = seriesEnergized(closed); // length 5: source + after each contact
  const cx = [240, 410, 580, 750]; // contact centres
  const loopComplete = nodes[4] && isOn(loopReturn);

  const seg = (energized: boolean) => `wcars-rail${energized ? " wcars-rail--live" : ""}`;

  const hvOn = isOn(hv);
  const hvMissing = hv.status === "missing";
  const hvText = hvMissing ? "HV ——" : hvOn ? "HV ACTIVE" : "HV OFF";

  const stateText =
    state.status === "missing" ? "XX" : state.label || String(state.value ?? "");

  return (
    <div className="wcars-syn wcars-syn-safety wcars-safety-schem" data-testid="syn-safety">
      <div className="wcars-syn-title">SHUTDOWN CIRCUIT</div>
      <svg viewBox="0 0 1000 540" className="wcars-schem-svg" role="img" aria-label="Safety loop synoptic">
        {/* ---- SHUTDOWN LOOP RECTANGLE ---- */}
        {/* top rail, segmented so each section colours by conduction */}
        <line className={seg(nodes[0])} x1={90}  y1={RAIL_Y} x2={cx[0] - 32} y2={RAIL_Y} />
        <line className={seg(nodes[1])} x1={cx[0] + 32} y1={RAIL_Y} x2={cx[1] - 32} y2={RAIL_Y} />
        <line className={seg(nodes[2])} x1={cx[1] + 32} y1={RAIL_Y} x2={cx[2] - 32} y2={RAIL_Y} />
        <line className={seg(nodes[3])} x1={cx[2] + 32} y1={RAIL_Y} x2={cx[3] - 32} y2={RAIL_Y} />
        <line className={seg(nodes[4])} x1={cx[3] + 32} y1={RAIL_Y} x2={880} y2={RAIL_Y} />
        {/* return path: right side down, bottom rail, left side up */}
        <line className={seg(loopComplete)} x1={880} y1={RAIL_Y} x2={880} y2={250} />
        <line className={seg(loopComplete)} x1={880} y1={250} x2={90} y2={250} />
        <line className={seg(loopComplete)} x1={90} y1={250} x2={90} y2={RAIL_Y} />

        {/* source node (tractive-system master) */}
        <circle className="wcars-contact-term" cx={90} cy={RAIL_Y} r={6} />
        <text className="wcars-schem-tag" x={90} y={RAIL_Y - 14} textAnchor="middle">TSMS</text>
        <text className="wcars-rail-cap" x={485} y={272} textAnchor="middle">SAFETY LOOP RETURN</text>

        {/* contacts */}
        <Contact cx={cx[0]} label="IMD" sd={imd} />
        <Contact cx={cx[1]} label="AMS" sd={ams} />
        <Contact cx={cx[2]} label="BSPD" sd={bspd} />
        <Contact cx={cx[3]} label="LATCH" sd={latch} />

        {/* ---- HV ACTIVE LAMP ---- */}
        <rect
          className={`wcars-hv-lamp wcars-hv-lamp--${hvMissing ? "missing" : hvOn ? "on" : "off"}`}
          x={90} y={325} width={300} height={95} rx={10}
        />
        <text className="wcars-hv-lamp-text" x={240} y={385} textAnchor="middle">{hvText}</text>

        {/* ---- PRECHARGE ---- */}
        <rect className="wcars-schem-box" x={430} y={325} width={240} height={95} rx={8} />
        <text className="wcars-schem-head" x={550} y={353} textAnchor="middle">PRECHARGE</text>
        <Indicator x={500} y={390} label="ENABLE" sd={pcEn} />
        <Indicator x={600} y={390} label="OK" sd={pcOk} />

        {/* ---- PACK STATE ---- */}
        <rect className="wcars-schem-box" x={710} y={325} width={200} height={95} rx={8} />
        <text className="wcars-schem-head" x={810} y={353} textAnchor="middle">PACK STATE</text>
        <text
          className={`wcars-pack-state wcars-pack-state--${state.status}`}
          x={810} y={395} textAnchor="middle"
        >
          {stateText}
        </text>
      </svg>
    </div>
  );
}

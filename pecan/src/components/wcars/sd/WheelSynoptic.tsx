import { useSdValue } from "../../../lib/wcars/sdSignals";
import { EcamValueBox } from "./primitives/EcamValueBox";

export function WheelSynoptic() {
  const lf = useSdValue("leftRpm");
  const rf = useSdValue("rightRpm");
  const bf = useSdValue("brakeF");
  const br = useSdValue("brakeR");
  const brk = useSdValue("brakePct");
  const thr = useSdValue("throttle");
  return (
    <div className="wcars-syn wcars-syn-wheel" data-testid="syn-wheel">
      <div className="wcars-syn-title">WHEEL</div>
      <div className="wcars-wheel-grid">
        <EcamValueBox label="L RPM" value={lf.value} unit="" status={lf.status} />
        <EcamValueBox label="R RPM" value={rf.value} unit="" status={rf.status} />
        <EcamValueBox label="BRK F" value={bf.value} unit="" status={bf.status} decimals={2} />
        <EcamValueBox label="BRK R" value={br.value} unit="" status={br.status} decimals={2} />
      </div>
      <div className="wcars-wheel-inputs">
        <EcamValueBox label="THR" value={thr.value} unit="%" status={thr.status} />
        <EcamValueBox label="BRK" value={brk.value} unit="%" status={brk.status} />
      </div>
    </div>
  );
}

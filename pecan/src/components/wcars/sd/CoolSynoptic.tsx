import { useSdValue } from "../../../lib/wcars/sdSignals";
import { EcamValueBox } from "./primitives/EcamValueBox";

export function CoolSynoptic() {
  const coolant = useSdValue("coolant");
  const motor = useSdValue("motorTemp");
  const modA = useSdValue("modA");
  const modB = useSdValue("modB");
  const modC = useSdValue("modC");
  const gate = useSdValue("gateTemp");
  return (
    <div className="wcars-syn wcars-syn-cool" data-testid="syn-cool">
      <div className="wcars-syn-title">COOL / THERMAL</div>
      <EcamValueBox label="COOLANT" value={coolant.value} unit="°C" status={coolant.status} decimals={1} />
      <div className="wcars-cool-grid">
        <EcamValueBox label="MOTOR" value={motor.value} unit="°C" status={motor.status} decimals={1} />
        <EcamValueBox label="MOD A" value={modA.value} unit="°C" status={modA.status} decimals={1} />
        <EcamValueBox label="MOD B" value={modB.value} unit="°C" status={modB.status} decimals={1} />
        <EcamValueBox label="MOD C" value={modC.value} unit="°C" status={modC.status} decimals={1} />
        <EcamValueBox label="GATE" value={gate.value} unit="°C" status={gate.status} decimals={1} />
      </div>
    </div>
  );
}

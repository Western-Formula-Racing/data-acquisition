import { useSdValue } from "../../../lib/wcars/sdSignals";
import { EcamGauge } from "./primitives/EcamGauge";
import { EcamValueBox } from "./primitives/EcamValueBox";

export function MotorSynoptic() {
  const rpm = useSdValue("motorRpm");
  const tFb = useSdValue("torqueFb");
  const tCmd = useSdValue("torqueCmd");
  const mt = useSdValue("motorTemp");
  const hs = useSdValue("hotSpot");
  const gd = useSdValue("gateTemp");
  return (
    <div className="wcars-syn wcars-syn-motor" data-testid="syn-motor">
      <div className="wcars-syn-title">MOTOR / DRIVE</div>
      <EcamGauge label="N" value={rpm.value} range={[0, 6000]} unit="RPM" status={rpm.status} />
      <div className="wcars-motor-torque">
        <EcamValueBox label="TQ CMD" value={tCmd.value} unit="Nm" status={tCmd.status} decimals={1} />
        <EcamValueBox label="TQ FB" value={tFb.value} unit="Nm" status={tFb.status} decimals={1} />
      </div>
      <div className="wcars-motor-temps">
        <EcamValueBox label="MOT" value={mt.value} unit="°C" status={mt.status} decimals={1} />
        <EcamValueBox label="HOT" value={hs.value} unit="°C" status={hs.status} decimals={1} />
        <EcamValueBox label="GATE" value={gd.value} unit="°C" status={gd.status} decimals={1} />
      </div>
    </div>
  );
}

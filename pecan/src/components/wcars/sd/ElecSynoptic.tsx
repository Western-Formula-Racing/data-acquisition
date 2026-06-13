import { useSdValue } from "../../../lib/wcars/sdSignals";
import { EcamValueBox } from "./primitives/EcamValueBox";

export function ElecSynoptic() {
  const v = useSdValue("packV");
  const a = useSdValue("packA");
  const soc = useSdValue("packSoc");
  const dcl = useSdValue("packDcl");
  const ccl = useSdValue("packCcl");
  const busV = useSdValue("busV");
  const busA = useSdValue("busA");
  return (
    <div className="wcars-syn wcars-syn-elec" data-testid="syn-elec">
      <div className="wcars-syn-title">ELEC / BATT</div>
      <div className="wcars-elec-pack">
        <EcamValueBox label="HV" value={v.value} unit="V" status={v.status} />
        <EcamValueBox label="CURR" value={a.value} unit="A" status={a.status} />
        <EcamValueBox label="SOC" value={soc.value} unit="%" status={soc.status} />
      </div>
      <div className="wcars-elec-limits">
        <EcamValueBox label="DCL" value={dcl.value} unit="A" status={dcl.status} />
        <EcamValueBox label="CCL" value={ccl.value} unit="A" status={ccl.status} />
      </div>
      <div className="wcars-elec-bus">
        <EcamValueBox label="BUS V" value={busV.value} unit="V" status={busV.status} decimals={1} />
        <EcamValueBox label="BUS A" value={busA.value} unit="A" status={busA.status} decimals={1} />
      </div>
    </div>
  );
}

import { useSdValue } from "../../../lib/wcars/sdSignals";

export function StatusSynoptic() {
  const state = useSdValue("vcuState");
  const rtd = useSdValue("rtdButton");
  const stateText = state.label || (state.value === null ? "XX" : String(state.value));
  const rtdText = rtd.value === null ? "XX" : rtd.value >= 1 ? "ARMED" : "SAFE";
  return (
    <div className="wcars-syn wcars-syn-sts" data-testid="syn-sts">
      <div className="wcars-syn-title">STATUS</div>
      <div className="wcars-sts-line">
        <span className="wcars-lbl wcars-lbl--remark">VCU STATE</span>
        <span className="wcars-lbl wcars-lbl--value">{stateText}</span>
      </div>
      <div className="wcars-sts-line">
        <span className="wcars-lbl wcars-lbl--remark">READY TO DRIVE</span>
        <span className="wcars-lbl wcars-lbl--value">{rtdText}</span>
      </div>
    </div>
  );
}

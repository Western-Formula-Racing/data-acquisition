import type { SdStatus } from "../../../../lib/wcars/sdSignals";

interface Props {
  label: string;
  value: number | null;
  unit?: string;
  status: SdStatus;
  decimals?: number;
}

export function EcvMValueBox({ label, value, unit, status, decimals = 0 }: Props) {
  const text =
    value === null || status === "missing" ? "XX" : value.toFixed(decimals);
  return (
    <div className={`wcars-vbox wcars-vbox--${status}`}>
      <span className="wcars-vbox-label">{label}</span>
      <span className="wcars-vbox-value">{text}</span>
      {unit ? <span className="wcars-vbox-unit">{unit}</span> : null}
    </div>
  );
}

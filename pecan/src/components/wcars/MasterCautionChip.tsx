import { useNavigate } from "react-router";
import { useWcars } from "../../context/WcarsContext";

export function MasterCautionChip() {
  const { alerts } = useWcars();
  const navigate = useNavigate();
  const active = alerts.filter((a) => !a.replay);
  if (active.length === 0) return null;
  const hasWarn = active.some((a) => a.severity === "WARNING");
  const hasCaut = active.some((a) => a.severity === "CAUTION" || a.severity === "MEMO");
  const cls = hasWarn ? "wcars-chip wcars-chip-warn" : hasCaut ? "wcars-chip wcars-chip-caut" : "wcars-chip";
  const label = hasWarn ? `MASTER WARN (${active.length})` : hasCaut ? `MASTER CAUT (${active.length})` : `${active.length}`;
  return (
    <button className={cls} onClick={() => navigate("/wcars")} aria-label="Open WCARS">
      {label}
    </button>
  );
}
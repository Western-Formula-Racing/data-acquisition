import { useEffect, useMemo, useRef, useState } from "react";
import { useWcars } from "../../../context/WcarsContext";
import { useSdValue } from "../../../lib/wcars/sdSignals";
import { EcpButtonRow } from "./EcpButtonRow";
import { SD_PAGES, ruleToPage, type SdPageId } from "./pages";

const PIN_MS = 8000;

function useInopPages(): SdPageId[] {
  const wheelL = useSdValue("leftRpm");
  const wheelR = useSdValue("rightRpm");
  const elecV = useSdValue("packV");
  const elecSoc = useSdValue("packSoc");
  const motRpm = useSdValue("motorRpm");
  const motTemp = useSdValue("motorTemp");
  const cool = useSdValue("coolant");
  const loopHv = useSdValue("hvActive");
  const loopRet = useSdValue("loopReturn");
  return useMemo(() => {
    // Only flag INOP when data is actively flowing (at least one signal present).
    // If no signals have arrived yet, the stream is simply cold — not INOP.
    const anyPresent = [wheelL, wheelR, elecV, elecSoc, motRpm, motTemp, cool, loopHv]
      .some((s) => s.status !== "missing");
    if (!anyPresent) return [];
    const inop: SdPageId[] = [];
    if (wheelL.status === "missing" && wheelR.status === "missing") inop.push("WHEEL");
    if (elecV.status === "missing" && elecSoc.status === "missing") inop.push("ELEC");
    if (loopHv.status === "missing" && loopRet.status === "missing") inop.push("LOOP");
    if (motRpm.status === "missing" && motTemp.status === "missing") inop.push("MOTOR");
    if (cool.status === "missing") inop.push("COOL");
    return inop;
  }, [wheelL.status, wheelR.status, elecV.status, elecSoc.status, motRpm.status, motTemp.status, cool.status, loopHv.status, loopRet.status]);
}

export function SystemDisplay() {
  const { alerts } = useWcars();
  const [selected, setSelected] = useState<SdPageId>("STS");
  const [flashing, setFlashing] = useState<SdPageId | null>(null);
  const pinnedUntil = useRef(0);
  const lastWarnId = useRef<string | null>(null);
  const inop = useInopPages();

  useEffect(() => {
    const warn = alerts.find((a) => a.severity === "WARNING" && !a.replay);
    if (!warn || warn.id === lastWarnId.current) return;
    lastWarnId.current = warn.id;
    const page = ruleToPage(warn.rule);
    if (!page || inop.includes(page)) return;
    setFlashing(page);
    if (Date.now() >= pinnedUntil.current) setSelected(page);
    const t = setTimeout(() => setFlashing(null), 4000);
    return () => clearTimeout(t);
  }, [alerts, inop]);

  const onSelect = (id: SdPageId) => {
    pinnedUntil.current = Date.now() + PIN_MS;
    setSelected(id);
  };

  const Page = SD_PAGES[selected].Component;
  return (
    <div className="wcars-sd" data-testid="system-display">
      <div className="wcars-sd-viewport">
        <Page />
      </div>
      <EcpButtonRow selected={selected} inop={inop} onSelect={onSelect} flashing={flashing} />
    </div>
  );
}

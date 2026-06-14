import { useEffect } from "react";
import { EcvMPanel } from "../components/wcars/EcvMPanel";
import { WcarsSettings } from "../components/wcars/WcarsSettings";
import { SystemDisplay } from "../components/wcars/sd/SystemDisplay";
import { startFakeSdTelemetry } from "../lib/wcars/devFakeTelemetry";

export default function Wcars() {
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has("fakesd")) return;
    return startFakeSdTelemetry();
  }, []);

  return (
    <div className="wcars-page">
      <header className="wcars-header">
        <h1>WCARS</h1>
        <WcarsSettings />
      </header>
      <div className="wcars-grid">
        <section className="wcars-left" aria-label="Active alerts">
          <h2 className="wcars-pane-title">ECVM — ACTIVE ALERTS</h2>
          <EcvMPanel />
        </section>
        <section className="wcars-right" aria-label="System display">
          <h2 className="wcars-pane-title">SYSTEM DISPLAY</h2>
          <SystemDisplay />
        </section>
      </div>
    </div>
  );
}

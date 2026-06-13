import { useEffect } from "react";
import { EcamPanel } from "../components/wcars/EcamPanel";
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
          <h2 className="wcars-pane-title">ECAM — ACTIVE ALERTS</h2>
          <EcamPanel />
        </section>
        <section className="wcars-right" aria-label="System display">
          <h2 className="wcars-pane-title">SYSTEM DISPLAY</h2>
          <SystemDisplay />
        </section>
      </div>
    </div>
  );
}

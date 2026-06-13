import { describe, it, expect, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { WcarsProvider, useWcars } from "./WcarsContext";
import { DEFAULT_WCARS_CONFIG } from "../lib/wcars/types";

function Probe() {
  const { alerts, log, config, clearAll } = useWcars();
  return (
    <div>
      <div data-testid="alerts">{alerts.length}</div>
      <div data-testid="log">{log.length}</div>
      <div data-testid="config-temp">{config.thresholds.torch_cell_temp_c}</div>
      <button data-testid="clearall" onClick={clearAll}>clear all</button>
    </div>
  );
}

describe("WcarsContext", () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });

  it("starts with empty alerts/log and default config", () => {
    const { getByTestId } = render(<WcarsProvider><Probe /></WcarsProvider>);
    expect(getByTestId("alerts").textContent).toBe("0");
    expect(getByTestId("log").textContent).toBe("0");
    expect(getByTestId("config-temp").textContent).toBe(String(DEFAULT_WCARS_CONFIG.thresholds.torch_cell_temp_c));
  });

  it("clearAll is a no-op on empty state and does not throw", () => {
    const { getByTestId } = render(<WcarsProvider><Probe /></WcarsProvider>);
    act(() => getByTestId("clearall").click());
    expect(getByTestId("alerts").textContent).toBe("0");
  });
});
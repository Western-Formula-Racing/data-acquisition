import "../../../test/sdTestUtils";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { clearSignals } from "../../../test/sdTestUtils";

const wcarsMock = vi.hoisted(() => ({ alerts: [] as any[] }));
vi.mock("../../../context/WcarsContext", () => ({
  useWcars: () => ({ alerts: wcarsMock.alerts, clear: vi.fn(), clearAll: vi.fn(), log: [] }),
}));

import { SystemDisplay } from "./SystemDisplay";

describe("SystemDisplay", () => {
  beforeEach(() => { clearSignals(); wcarsMock.alerts = []; });

  it("defaults to STS and switches page on ECP press (pin)", () => {
    render(<SystemDisplay />);
    expect(screen.getByTestId("syn-sts")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /WHEEL/ }));
    expect(screen.getByTestId("syn-wheel")).toBeTruthy();
  });

  it("auto-jumps to the page for a new WARNING when not pinned", async () => {
    wcarsMock.alerts = [
      { id: "x", rule: "INV_FAULT", severity: "WARNING", replay: false, title: "", detail: "", ts: 1, value: null },
    ];
    render(<SystemDisplay />);
    expect(await screen.findByTestId("syn-motor")).toBeTruthy();
  });
});

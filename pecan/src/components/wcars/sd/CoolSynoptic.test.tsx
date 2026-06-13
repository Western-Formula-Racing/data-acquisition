import "../../../test/sdTestUtils";
import { render, screen } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import { setSignal, clearSignals } from "../../../test/sdTestUtils";
import { CoolSynoptic } from "./CoolSynoptic";

describe("CoolSynoptic", () => {
  beforeEach(() => clearSignals());
  it("renders coolant temp", () => {
    setSignal("0x0A2", "INV_Coolant_Temp", 48);
    render(<CoolSynoptic />);
    // coolant uses decimals=1, so 48 renders as "48.0"
    expect(screen.getByText("48.0")).toBeTruthy();
  });
});

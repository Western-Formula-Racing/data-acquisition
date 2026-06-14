import { describe, expect, it, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { clearSignals, setSignal } from "../../../test/sdTestUtils";
import { CoolSchematic } from "./CoolSchematic";

describe("CoolSchematic", () => {
  beforeEach(() => clearSignals());

  it("renders all six temperature readouts and the peak envelope", () => {
    setSignal("0x0A2", "INV_Coolant_Temp", 48);
    setSignal("0x0A2", "INV_Motor_Temp", 70);
    setSignal("0x0A2", "INV_Hot_Spot_Temp", 95);
    setSignal("0x0A0", "INV_Gate_Driver_Board_Temp", 55);
    setSignal("0x0A0", "INV_Module_A_Temp", 60);
    setSignal("0x0A0", "INV_Module_B_Temp", 58);
    setSignal("0x0A0", "INV_Module_C_Temp", 59);
    render(<CoolSchematic />);
    // 6 sensor labels + 1 IN = 7 thermal labels
    expect(screen.getByText("MOTOR")).toBeTruthy();
    expect(screen.getByText("GATE")).toBeTruthy();
    expect(screen.getByText("HOT")).toBeTruthy();
    expect(screen.getByText("MOD A")).toBeTruthy();
    expect(screen.getByText("MOD B")).toBeTruthy();
    expect(screen.getByText("MOD C")).toBeTruthy();
    expect(screen.getByText("IN")).toBeTruthy();
    expect(screen.getByText("PEAK")).toBeTruthy();
  });

  it("shows XX placeholders when the thermal frame is missing", () => {
    render(<CoolSchematic />);
    expect(screen.getAllByText("XX").length).toBeGreaterThan(0);
  });
});

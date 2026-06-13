import "../../../test/sdTestUtils";
import { render, screen } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import { setSignal, clearSignals } from "../../../test/sdTestUtils";
import { ElecSynoptic } from "./ElecSynoptic";

describe("ElecSynoptic", () => {
  beforeEach(() => clearSignals());
  it("renders pack voltage, current and SoC", () => {
    setSignal("0x6B0", "Pack_Inst_Voltage", 398);
    setSignal("0x6B0", "Pack_Current", 112);
    setSignal("0x6B0", "Pack_SOC", 84);
    render(<ElecSynoptic />);
    expect(screen.getByText("398")).toBeTruthy();
    expect(screen.getByText("112")).toBeTruthy();
    expect(screen.getByText("84")).toBeTruthy();
  });
});

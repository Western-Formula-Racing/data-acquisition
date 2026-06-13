import "../../../test/sdTestUtils";
import { render, screen } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import { setSignal, clearSignals } from "../../../test/sdTestUtils";
import { StatusSynoptic } from "./StatusSynoptic";

describe("StatusSynoptic", () => {
  beforeEach(() => clearSignals());
  it("shows the VCU state label from the enum unit", () => {
    setSignal("0x7D2", "State", 3, "DRIVE");
    render(<StatusSynoptic />);
    expect(screen.getByText("VCU STATE").parentElement?.querySelector(".wcars-lbl--value")?.textContent).toBe("DRIVE");
  });
  it("shows XX STATE when state is missing", () => {
    render(<StatusSynoptic />);
    expect(screen.getByText("VCU STATE").parentElement?.querySelector(".wcars-lbl--value")?.textContent).toBe("XX");
  });
});

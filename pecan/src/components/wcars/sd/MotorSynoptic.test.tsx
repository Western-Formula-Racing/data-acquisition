import "../../../test/sdTestUtils";
import { render, screen } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import { setSignal, clearSignals } from "../../../test/sdTestUtils";
import { MotorSynoptic } from "./MotorSynoptic";

describe("MotorSynoptic", () => {
  beforeEach(() => clearSignals());
  it("renders motor rpm and torque", () => {
    setSignal("0x0A5", "INV_Motor_Speed", 4200);
    setSignal("0x0AC", "INV_Torque_Feedback", 95);
    render(<MotorSynoptic />);
    expect(screen.getByText("4200")).toBeTruthy();
    expect(screen.getByText("95.0")).toBeTruthy();  // torqueFb uses decimals=1
  });
});

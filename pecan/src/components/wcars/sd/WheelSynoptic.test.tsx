import "../../../test/sdTestUtils";          // installs useSignal mock
import { render, screen } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import { setSignal, clearSignals } from "../../../test/sdTestUtils";
import { WheelSynoptic } from "./WheelSynoptic";

describe("WheelSynoptic", () => {
  beforeEach(() => clearSignals());
  it("renders wheel speeds from signals", () => {
    setSignal("0x7DD", "Left_RPM", 1200);
    setSignal("0x7DD", "Right_RPM", 1180);
    render(<WheelSynoptic />);
    expect(screen.getByText("1200")).toBeTruthy();
    expect(screen.getByText("1180")).toBeTruthy();
  });
  it("shows XX for missing brake pressure", () => {
    render(<WheelSynoptic />);
    expect(screen.getAllByText("XX").length).toBeGreaterThan(0);
  });
});

import { describe, expect, it, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { clearSignals, setSignal } from "../../../test/sdTestUtils";
import { SafetySynoptic } from "./SafetySynoptic";

describe("SafetySynoptic", () => {
  beforeEach(() => clearSignals());

  it("shows every contact CLOSED and HV ACTIVE on a healthy loop", () => {
    setSignal("0x420", "IMDRelay", 1);
    setSignal("0x420", "AMSRelay", 1);
    setSignal("0x420", "BSPDRelay", 1);
    setSignal("0x420", "LatchRelay", 1);
    setSignal("0x420", "Safetyloop_return", 1);
    setSignal("0x420", "HV_Active", 1);
    setSignal("0x420", "PackStatus", 3, "Active");
    render(<SafetySynoptic />);
    expect(screen.getAllByText("CLOSED")).toHaveLength(4);
    expect(screen.getByText("HV ACTIVE")).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
  });

  it("shows a tripped contact OPEN and HV OFF when the loop is broken", () => {
    setSignal("0x420", "IMDRelay", 1);
    setSignal("0x420", "AMSRelay", 1);
    setSignal("0x420", "BSPDRelay", 0); // BSPD tripped
    setSignal("0x420", "LatchRelay", 1);
    setSignal("0x420", "Safetyloop_return", 0);
    setSignal("0x420", "HV_Active", 0);
    render(<SafetySynoptic />);
    expect(screen.getByText("OPEN")).toBeTruthy();
    expect(screen.getByText("HV OFF")).toBeTruthy();
  });

  it("shows XX placeholders when the safety frame is missing", () => {
    render(<SafetySynoptic />);
    expect(screen.getAllByText("XX").length).toBeGreaterThan(0);
  });
});

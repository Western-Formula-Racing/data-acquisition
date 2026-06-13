import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { EcamLabel } from "./EcamLabel";
import { EcamFlowLine } from "./EcamFlowLine";

describe("SD misc primitives", () => {
  it("EcamLabel renders text with role class", () => {
    const { getByText, container } = render(<EcamLabel role="title">HV BATT</EcamLabel>);
    expect(getByText("HV BATT")).toBeTruthy();
    expect(container.querySelector(".wcars-lbl--title")).toBeTruthy();
  });
  it("EcamFlowLine renders an svg line", () => {
    const { container } = render(
      <svg><EcamFlowLine x1={0} y1={0} x2={10} y2={0} active /></svg>,
    );
    expect(container.querySelector("line")).toBeTruthy();
  });
});

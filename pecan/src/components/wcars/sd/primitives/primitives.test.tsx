import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { EcvMLabel } from "./EcvMLabel";
import { EcvMFlowLine } from "./EcvMFlowLine";

describe("SD misc primitives", () => {
  it("EcvMLabel renders text with role class", () => {
    const { getByText, container } = render(<EcvMLabel role="title">HV BATT</EcvMLabel>);
    expect(getByText("HV BATT")).toBeTruthy();
    expect(container.querySelector(".wcars-lbl--title")).toBeTruthy();
  });
  it("EcvMFlowLine renders an svg line", () => {
    const { container } = render(
      <svg><EcvMFlowLine x1={0} y1={0} x2={10} y2={0} active /></svg>,
    );
    expect(container.querySelector("line")).toBeTruthy();
  });
});

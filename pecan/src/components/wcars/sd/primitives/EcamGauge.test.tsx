import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { EcamGauge } from "./EcamGauge";

describe("EcamGauge", () => {
  it("renders an svg with the digital readout", () => {
    const { container } = render(
      <EcamGauge label="N" value={3000} range={[0, 6000]} unit="RPM" status="normal" />,
    );
    expect(container.querySelector("svg")).toBeTruthy();
    expect(screen.getByText("3000")).toBeTruthy();
    expect(screen.getByText("RPM")).toBeTruthy();
  });
  it("shows XX when missing", () => {
    render(<EcamGauge label="N" value={null} range={[0, 6000]} unit="RPM" status="missing" />);
    expect(screen.getByText("XX")).toBeTruthy();
  });
});

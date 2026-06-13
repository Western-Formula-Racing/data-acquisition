import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { EcamValueBox } from "./EcamValueBox";

describe("EcamValueBox", () => {
  it("renders value, unit and a status class", () => {
    const { container } = render(
      <EcamValueBox label="MOTOR" value={123.4} unit="°C" status="caution" decimals={1} />,
    );
    expect(screen.getByText("MOTOR")).toBeTruthy();
    expect(screen.getByText("123.4")).toBeTruthy();
    expect(screen.getByText("°C")).toBeTruthy();
    expect(container.querySelector(".wcars-vbox--caution")).toBeTruthy();
  });
  it("shows XX when value is null/missing", () => {
    render(<EcamValueBox label="HV" value={null} unit="V" status="missing" />);
    expect(screen.getByText("XX")).toBeTruthy();
  });
});

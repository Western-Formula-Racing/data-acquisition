import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { EcvMValueBox } from "./EcvMValueBox";

describe("EcvMValueBox", () => {
  it("renders value, unit and a status class", () => {
    const { container } = render(
      <EcvMValueBox label="MOTOR" value={123.4} unit="°C" status="caution" decimals={1} />,
    );
    expect(screen.getByText("MOTOR")).toBeTruthy();
    expect(screen.getByText("123.4")).toBeTruthy();
    expect(screen.getByText("°C")).toBeTruthy();
    expect(container.querySelector(".wcars-vbox--caution")).toBeTruthy();
  });
  it("shows XX when value is null/missing", () => {
    render(<EcvMValueBox label="HV" value={null} unit="V" status="missing" />);
    expect(screen.getByText("XX")).toBeTruthy();
  });
});

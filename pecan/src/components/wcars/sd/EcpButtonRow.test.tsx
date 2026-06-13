import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { EcpButtonRow } from "./EcpButtonRow";

describe("EcpButtonRow", () => {
  it("renders a key per page and marks the selected one", () => {
    render(<EcpButtonRow selected="ELEC" inop={[]} onSelect={() => {}} />);
    const elec = screen.getByRole("button", { name: /ELEC/ });
    expect(elec.className).toContain("wcars-ecp--on");
  });
  it("calls onSelect when an available key is pressed", () => {
    const onSelect = vi.fn();
    render(<EcpButtonRow selected="STS" inop={[]} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /WHEEL/ }));
    expect(onSelect).toHaveBeenCalledWith("WHEEL");
  });
  it("disables INOP keys", () => {
    const onSelect = vi.fn();
    render(<EcpButtonRow selected="STS" inop={["COOL"]} onSelect={onSelect} />);
    const cool = screen.getByRole("button", { name: /COOL/ }) as HTMLButtonElement;
    expect(cool.disabled).toBe(true);
    expect(cool.className).toContain("wcars-ecp--inop");
  });
});

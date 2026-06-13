import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { WcarsProvider } from "../../../context/WcarsContext";
import { MsgPage } from "./MsgPage";

describe("MsgPage", () => {
  it("renders the ACARS log inside a fixed scroll container", () => {
    const { container } = render(
      <WcarsProvider><MsgPage /></WcarsProvider>,
    );
    expect(container.querySelector(".wcars-msg-page")).toBeTruthy();
    expect(container.querySelector(".wcars-acars")).toBeTruthy();
  });
});

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";

import type { RunRecord } from "../types";
import { AnalysisToolbar } from "./AnalysisToolbar";

const run: RunRecord = {
  key: "run-1",
  start_utc: "2026-01-01T12:00:00Z",
  end_utc: "2026-01-01T13:00:00Z",
  start_local: "2026-01-01T07:00:00-05:00",
  end_local: "2026-01-01T08:00:00-05:00",
  bins: 60,
};

const range: [number, number] = [
  Date.parse(run.start_utc),
  Date.parse(run.end_utc),
];

afterEach(() => {
  cleanup();
});

function renderToolbar(overrides: Partial<ComponentProps<typeof AnalysisToolbar>> = {}) {
  const props = {
    runs: [run],
    selectedRunKey: run.key,
    range,
    loading: false,
    exportDisabled: true,
    onRunChange: vi.fn(),
    onSelectCustom: vi.fn(),
    onCustomRange: vi.fn(),
    onExport: vi.fn(),
    ...overrides,
  };
  const view = render(<AnalysisToolbar {...props} />);
  return { ...view, props };
}

describe("AnalysisToolbar", () => {
  it("selecting Custom calls onSelectCustom once and does not call onCustomRange", () => {
    const { props } = renderToolbar();

    fireEvent.change(screen.getByLabelText(/Run window/i), {
      target: { value: "" },
    });

    expect(props.onSelectCustom).toHaveBeenCalledTimes(1);
    expect(props.onCustomRange).not.toHaveBeenCalled();
  });

  it("keeps the select value controlled by selectedRunKey", () => {
    const onSelectCustom = vi.fn();
    const onCustomRange = vi.fn();
    const base = {
      runs: [run],
      range,
      loading: false,
      exportDisabled: true,
      onRunChange: vi.fn(),
      onSelectCustom,
      onCustomRange,
      onExport: vi.fn(),
    };

    const { rerender } = render(
      <AnalysisToolbar {...base} selectedRunKey={run.key} />,
    );
    const select = screen.getByLabelText(/Run window/i) as HTMLSelectElement;
    expect(select.value).toBe(run.key);

    rerender(<AnalysisToolbar {...base} selectedRunKey="" />);
    expect(select.value).toBe("");
  });

  it("Apply with valid bounds calls onCustomRange", () => {
    const onCustomRange = vi.fn();
    renderToolbar({ selectedRunKey: "", onCustomRange });

    fireEvent.change(screen.getByLabelText(/Start \(local/i), {
      target: { value: "2026-06-01T10:00" },
    });
    fireEvent.change(screen.getByLabelText(/End \(local/i), {
      target: { value: "2026-06-01T11:00" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Apply range/i }));

    expect(onCustomRange).toHaveBeenCalledTimes(1);
    const [startMs, endMs] = onCustomRange.mock.calls[0];
    expect(startMs).toBeLessThan(endMs);
    expect(Number.isFinite(startMs)).toBe(true);
    expect(Number.isFinite(endMs)).toBe(true);
  });

  it("Apply with invalid bounds does not call onCustomRange", () => {
    const { props } = renderToolbar({ selectedRunKey: "" });

    fireEvent.change(screen.getByLabelText(/Start \(local/i), {
      target: { value: "2026-06-01T12:00" },
    });
    fireEvent.change(screen.getByLabelText(/End \(local/i), {
      target: { value: "2026-06-01T11:00" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Apply range/i }));

    expect(props.onCustomRange).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/Start must be before end/i);
  });
});

// src/analysis/plot-layout.ts
export interface PlotGroup {
  id: string;
  signals: string[];
  rightAxis: string[];
}

export type PlotLayout = PlotGroup[];

export const MAX_TOTAL_SIGNALS = 12;
export const NEW_PLOT = "__new__";

let idCounter = 0;

function createGroupId(): string {
  idCounter += 1;
  return `plot-${Date.now().toString(36)}-${idCounter}`;
}

export function flattenSignals(layout: PlotLayout): string[] {
  return layout.flatMap((g) => g.signals);
}

function pruneEmpty(layout: PlotLayout): PlotLayout {
  return layout.filter((g) => g.signals.length > 0);
}

function removeSignals(layout: PlotLayout, remove: ReadonlySet<string>): PlotLayout {
  return pruneEmpty(
    layout.map((g) => ({
      ...g,
      signals: g.signals.filter((s) => !remove.has(s)),
      rightAxis: g.rightAxis.filter((s) => !remove.has(s)),
    })),
  );
}

export function toggleSignal(layout: PlotLayout, signal: string): PlotLayout {
  const present = layout.some((g) => g.signals.includes(signal));
  if (present) {
    return removeSignals(layout, new Set([signal]));
  }
  if (flattenSignals(layout).length + 1 > MAX_TOTAL_SIGNALS) return layout;
  return [...layout, { id: createGroupId(), signals: [signal], rightAxis: [] }];
}

export function assignSignals(
  layout: PlotLayout,
  signals: string[],
  target: string,
): PlotLayout {
  const unique = [...new Set(signals)];
  if (unique.length === 0) return layout;
  if (target !== NEW_PLOT && !layout.some((g) => g.id === target)) return layout;

  const current = new Set(flattenSignals(layout));
  const additions = unique.filter((s) => !current.has(s));
  if (current.size + additions.length > MAX_TOTAL_SIGNALS) return layout;

  // Moved signals keep their right-axis membership in the destination group.
  const movedRight = new Set(
    layout.flatMap((g) => g.rightAxis.filter((s) => unique.includes(s))),
  );
  const removed = removeSignals(layout, new Set(unique));

  if (target === NEW_PLOT) {
    return [
      ...removed,
      { id: createGroupId(), signals: unique, rightAxis: unique.filter((s) => movedRight.has(s)) },
    ];
  }
  return removed.map((g) =>
    g.id === target
      ? {
          ...g,
          signals: [...g.signals, ...unique.filter((s) => !g.signals.includes(s))],
          rightAxis: [...g.rightAxis, ...unique.filter((s) => movedRight.has(s))],
        }
      : g,
  );
}

export function clearRightAxisForSignals(
  layout: PlotLayout,
  signals: string[],
): PlotLayout {
  const remove = new Set(signals);
  const hasAny = layout.some((g) => g.rightAxis.some((s) => remove.has(s)));
  if (!hasAny) return layout;
  return layout.map((g) => ({
    ...g,
    rightAxis: g.rightAxis.filter((s) => !remove.has(s)),
  }));
}

export function toggleRightAxis(
  layout: PlotLayout,
  groupId: string,
  signal: string,
): PlotLayout {
  const target = layout.find((g) => g.id === groupId);
  if (!target || !target.signals.includes(signal)) return layout;
  return layout.map((g) =>
    g.id === groupId
      ? {
          ...g,
          rightAxis: g.rightAxis.includes(signal)
            ? g.rightAxis.filter((s) => s !== signal)
            : [...g.rightAxis, signal],
        }
      : g,
  );
}

export function pruneUnknown(
  layout: PlotLayout,
  known: ReadonlySet<string>,
): PlotLayout {
  const hasUnknown = layout.some(
    (g) => g.signals.some((s) => !known.has(s)) || g.rightAxis.some((s) => !known.has(s)),
  );
  if (!hasUnknown) return layout;
  return pruneEmpty(
    layout.map((g) => ({
      ...g,
      signals: g.signals.filter((s) => known.has(s)),
      rightAxis: g.rightAxis.filter((s) => known.has(s)),
    })),
  );
}

export function serializeLayout(
  layout: PlotLayout,
  colorOverrides?: Record<string, string>,
): string {
  return JSON.stringify({
    v: 2,
    plots: layout.map((g) => ({ signals: g.signals, rightAxis: g.rightAxis })),
    colors: colorOverrides && Object.keys(colorOverrides).length > 0 ? colorOverrides : undefined,
  });
}

export interface ParsedLayout {
  layout: PlotLayout;
  colorOverrides: Record<string, string>;
}

export function parseLayout(raw: string | null): ParsedLayout | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as { v?: unknown; plots?: unknown; colors?: unknown };
    if ((data.v !== 1 && data.v !== 2) || !Array.isArray(data.plots)) return null;
    const layout: PlotLayout = [];
    for (const entry of data.plots) {
      if (typeof entry !== "object" || entry === null) return null;
      const rec = entry as { signals?: unknown; rightAxis?: unknown };
      if (!Array.isArray(rec.signals)) return null;
      const signals = rec.signals.filter((s): s is string => typeof s === "string");
      const right = Array.isArray(rec.rightAxis)
        ? rec.rightAxis.filter((s): s is string => typeof s === "string")
        : [];
      if (signals.length === 0) continue;
      layout.push({
        id: createGroupId(),
        signals,
        rightAxis: right.filter((s) => signals.includes(s)),
      });
    }
    // v2 added color overrides; v1 layouts have none.
    const colorOverrides: Record<string, string> =
      data.v === 2 && data.colors && typeof data.colors === "object" && !Array.isArray(data.colors)
        ? Object.fromEntries(
            Object.entries(data.colors as Record<string, unknown>).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          )
        : {};
    return { layout, colorOverrides };
  } catch {
    return null;
  }
}

export function setSignalColor(
  overrides: Record<string, string>,
  signal: string,
  color: string,
): Record<string, string> {
  return { ...overrides, [signal]: color };
}

export function clearSignalColor(
  overrides: Record<string, string>,
  signal: string,
): Record<string, string> {
  const next = { ...overrides };
  delete next[signal];
  return next;
}


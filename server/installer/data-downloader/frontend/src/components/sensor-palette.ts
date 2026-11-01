export interface PaletteEntry {
  border: string;
  bg: string;
  badgeBg: string;
  badgeText: string;
}

const PALETTE: Array<{ light: PaletteEntry; dark: PaletteEntry }> = [
  // 0 Blue
  {
    light: { border: "#2563eb", bg: "#eef2ff", badgeBg: "#dbeafe", badgeText: "#1d4ed8" },
    dark: { border: "#60a5fa", bg: "#1e2638", badgeBg: "#1e3150", badgeText: "#93c5fd" },
  },
  // 1 Orange
  {
    light: { border: "#c2410c", bg: "#fff7ed", badgeBg: "#ffedd5", badgeText: "#9a3412" },
    dark: { border: "#fb923c", bg: "#2c1a10", badgeBg: "#3a2010", badgeText: "#fdba74" },
  },
  // 2 Teal
  {
    light: { border: "#0d9488", bg: "#f0fdfa", badgeBg: "#ccfbf1", badgeText: "#0f766e" },
    dark: { border: "#2dd4bf", bg: "#0d2522", badgeBg: "#123230", badgeText: "#5eead4" },
  },
  // 3 Violet
  {
    light: { border: "#7c3aed", bg: "#f5f3ff", badgeBg: "#ede9fe", badgeText: "#5b21b6" },
    dark: { border: "#a78bfa", bg: "#1e1530", badgeBg: "#261b3e", badgeText: "#c4b5fd" },
  },
  // 4 Amber
  {
    light: { border: "#b45309", bg: "#fffbeb", badgeBg: "#fef3c7", badgeText: "#92400e" },
    dark: { border: "#fbbf24", bg: "#2a1f0a", badgeBg: "#352710", badgeText: "#fde68a" },
  },
  // 5 Green
  {
    light: { border: "#15803d", bg: "#f0fdf4", badgeBg: "#dcfce7", badgeText: "#14532d" },
    dark: { border: "#4ade80", bg: "#0d2118", badgeBg: "#122818", badgeText: "#86efac" },
  },
  // 6 Rose
  {
    light: { border: "#be185d", bg: "#fdf2f8", badgeBg: "#fce7f3", badgeText: "#9d174d" },
    dark: { border: "#f472b6", bg: "#2c1020", badgeBg: "#3a1428", badgeText: "#f9a8d4" },
  },
  // 7 Cyan
  {
    light: { border: "#0e7490", bg: "#ecfeff", badgeBg: "#cffafe", badgeText: "#155e75" },
    dark: { border: "#22d3ee", bg: "#0a2028", badgeBg: "#0f2a38", badgeText: "#67e8f9" },
  },
];

/** Neutral palette for the ungrouped "Other" bucket. */
export const OTHER_PALETTE: PaletteEntry = {
  border: "var(--border-strong)",
  bg: "var(--surface-2)",
  badgeBg: "var(--surface-2)",
  badgeText: "var(--text-muted)",
};

/** djb2 hash → stable palette index for a subsystem name. */
export function paletteIndex(subsystem: string): number {
  let h = 5381;
  const s = subsystem.toUpperCase();
  for (let i = 0; i < s.length; i++) {
    h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  }
  return h % PALETTE.length;
}

export function subsystemColor(subsystem: string, theme: "light" | "dark"): PaletteEntry {
  return PALETTE[paletteIndex(subsystem)][theme];
}

/** Per-signal color overrides chosen by the user (signal name → hex). */
export type SignalColorOverrides = Record<string, string>;

/** Stroke color for plot traces, sharing the subsystem hash and palette borders. */
export function plotStroke(
  name: string,
  theme: "light" | "dark",
  overrides?: SignalColorOverrides,
): string {
  if (overrides?.[name]) return overrides[name];
  return PALETTE[paletteIndex(name)][theme].border;
}

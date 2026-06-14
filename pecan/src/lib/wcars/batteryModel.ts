// pecan/src/lib/wcars/batteryModel.ts
//
// WFR25 cell-level battery model. Given a per-cell SoC, current, and
// temperature, predicts the per-cell open-circuit voltage and DC internal
// resistance, from which we derive the pack voltage and expected sag.
//
// The underlying characterisation data lives in:
//
//   src/assets/wcars/ocv.csv  — SoC, OCV, Temperature_C  (3 cols, 57 rows)
//   src/assets/wcars/dcir.csv — SoC, R0_Ohms, Temperature_C  (3 cols, 400 rows)
//
// All inputs and outputs are **per-cell**. To get pack-level numbers, multiply
// by Nseries (100 for WFR25). The pack currently only has per-cell data on
// the BMS side; current limits and pack current are already at the pack level
// (see usePackAggregates + MOBO 0x202).

import ocvCsv from "../../assets/wcars/ocv.csv?raw";
import dcirCsv from "../../assets/wcars/dcir.csv?raw";

/** Nseries for the WFR25 pack (5 modules × 20S = 100S at the electrical
 *  terminals). Each DBC-reported cell is one representative cell of a 6P
 *  parallel group; the other 5 cells in the group are silent. */
export const WFR25_NSERIES = 100;
export const WFR25_NPARALLEL = 6;

interface OcvPoint { soc: number; ocv: number; }
interface DcirPoint { soc: number; r0: number; temp: number; }

function parseCsv(raw: string): { header: string[]; rows: number[][] } {
  const lines = raw.trim().split(/\r?\n/);
  const header = lines[0].split(",").map((s) => s.trim());
  const rows = lines.slice(1).map((line) =>
    line.split(",").map((s) => Number(s.trim())),
  );
  return { header, rows };
}

/** Load OCV table, dedupe by SoC (multiple rows share SoC; keep the median
 *  OCV for stability), then sort ascending by SoC. */
function loadOcvPoints(): OcvPoint[] {
  const { header, rows } = parseCsv(ocvCsv);
  const iSoc = header.indexOf("SoC");
  const iOcv = header.indexOf("OCV");
  // Group OCV readings by SoC
  const bySoc = new Map<number, number[]>();
  for (const r of rows) {
    const s = r[iSoc], v = r[iOcv];
    if (!Number.isFinite(s) || !Number.isFinite(v)) continue;
    const arr = bySoc.get(s) ?? [];
    arr.push(v);
    bySoc.set(s, arr);
  }
  const out: OcvPoint[] = [];
  for (const [s, vs] of bySoc) {
    vs.sort((a, b) => a - b);
    const mid = vs[Math.floor(vs.length / 2)];
    out.push({ soc: s, ocv: mid });
  }
  out.sort((a, b) => a.soc - b.soc);
  return out;
}

const OCV_POINTS = loadOcvPoints();

/** Per-cell OCV (V) at a given SoC fraction (0..1). Linear interpolation
 *  between adjacent OCV points. Clamps to the measured SoC range. */
export function ocvAtSoc(soc: number): number {
  if (OCV_POINTS.length === 0) return 0;
  const s = Math.min(1, Math.max(0, soc));
  if (s <= OCV_POINTS[0].soc) return OCV_POINTS[0].ocv;
  const last = OCV_POINTS[OCV_POINTS.length - 1];
  if (s >= last.soc) return last.ocv;
  // Binary search for the bracketing pair.
  let lo = 0, hi = OCV_POINTS.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (OCV_POINTS[mid].soc <= s) lo = mid;
    else hi = mid;
  }
  const a = OCV_POINTS[lo], b = OCV_POINTS[hi];
  const t = (s - a.soc) / (b.soc - a.soc);
  return a.ocv + t * (b.ocv - a.ocv);
}

/** Invert: what SoC corresponds to a measured per-cell OCV at rest. */
export function ocvToSoc(perCellV: number): number {
  if (OCV_POINTS.length === 0) return 0;
  const v = perCellV;
  const first = OCV_POINTS[0];
  const last = OCV_POINTS[OCV_POINTS.length - 1];
  if (v <= first.ocv) return first.soc;
  if (v >= last.ocv) return last.soc;
  for (let i = 0; i < OCV_POINTS.length - 1; i++) {
    const a = OCV_POINTS[i], b = OCV_POINTS[i + 1];
    if (a.ocv <= v && v <= b.ocv) {
      const f = (v - a.ocv) / (b.ocv - a.ocv);
      return a.soc + f * (b.soc - a.soc);
    }
  }
  return 0;
}

/** Load DCIR table; keep all rows. */
function loadDcirPoints(): DcirPoint[] {
  const { header, rows } = parseCsv(dcirCsv);
  const iSoc = header.indexOf("SoC");
  const iR0 = header.indexOf("R0_Ohms");
  const iT = header.indexOf("Temperature_C");
  const pts: DcirPoint[] = [];
  for (const r of rows) {
    if ([r[iSoc], r[iR0], r[iT]].some((v) => !Number.isFinite(v))) continue;
    pts.push({ soc: r[iSoc], r0: r[iR0], temp: r[iT] });
  }
  return pts;
}

const DCIR_POINTS = loadDcirPoints();

/** Group DCIR points by SoC level (snap to the 0.01% grid the test data
 *  uses). Returns a Map<SoC_level, points>. */
function dcirBySocLevel(): Map<number, DcirPoint[]> {
  const out = new Map<number, DcirPoint[]>();
  for (const p of DCIR_POINTS) {
    // Round to 4 decimals — the CSV's effective SoC grid.
    const level = Math.round(p.soc * 10000) / 10000;
    const arr = out.get(level) ?? [];
    arr.push(p);
    out.set(level, arr);
  }
  return out;
}

const DCIR_BY_SOC = dcirBySocLevel();
const DCIR_SOC_LEVELS = [...DCIR_BY_SOC.keys()].sort((a, b) => a - b);

/** Within a SoC level's points, linearly interpolate across temperature. */
function interpAlongTemp(slice: DcirPoint[], tempC: number): number {
  if (slice.length === 0) return 0;
  if (slice.length === 1) return slice[0].r0;
  const sorted = [...slice].sort((a, b) => a.temp - b.temp);
  if (tempC <= sorted[0].temp) return sorted[0].r0;
  const last = sorted[sorted.length - 1];
  if (tempC >= last.temp) return last.r0;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i], b = sorted[i + 1];
    if (a.temp <= tempC && tempC <= b.temp) {
      const f = (tempC - a.temp) / (b.temp - a.temp);
      return a.r0 + f * (b.r0 - a.r0);
    }
  }
  return last.r0;
}

/** Per-cell R₀ (Ω) at a given SoC and temperature (°C).
 *  Bilinear interpolation: find the two nearest SoC levels, interpolate
 *  R₀(T) within each, then linearly interpolate between those two R₀
 *  values by SoC distance. Clamps to the measured (SoC, T) extent. */
export function r0At(soc: number, tempC: number): number {
  if (DCIR_SOC_LEVELS.length === 0) return 0;
  const s = Math.min(1, Math.max(0, soc));
  // Binary search for the first level >= s.
  let lo = 0, hi = DCIR_SOC_LEVELS.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (DCIR_SOC_LEVELS[mid] < s) lo = mid + 1;
    else hi = mid;
  }
  let levelA = DCIR_SOC_LEVELS[lo];
  let levelB = levelA;
  if (lo > 0 && Math.abs(DCIR_SOC_LEVELS[lo - 1] - s) < Math.abs(levelA - s)) {
    levelB = levelA;
    levelA = DCIR_SOC_LEVELS[lo - 1];
  }
  const rA = interpAlongTemp(DCIR_BY_SOC.get(levelA)!, tempC);
  if (levelA === levelB) return rA;
  const rB = interpAlongTemp(DCIR_BY_SOC.get(levelB)!, tempC);
  // Linear in SoC between the two levels.
  const dA = Math.abs(levelA - s);
  const dB = Math.abs(levelB - s);
  const total = dA + dB;
  if (total === 0) return rA;
  const f = dA / total; // 0 at levelA, 1 at levelB
  return rA + f * (rB - rA);
}

/** Pack open-circuit voltage (V) at the given SoC fraction (0..1). */
export function predictedPackV(soc: number, nSeries = WFR25_NSERIES): number {
  return ocvAtSoc(soc) * nSeries;
}

/** Expected instantaneous sag (V) at the given pack current and SoC.
 *  `currentA` is pack-level. Positive = discharge. */
export function predictedSagV(
  currentA: number,
  soc: number,
  tempC: number,
  nSeries = WFR25_NSERIES,
): number {
  return currentA * r0At(soc, tempC) * nSeries;
}

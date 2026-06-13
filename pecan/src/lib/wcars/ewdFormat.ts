import type { Severity } from "./types";

export const SEVERITY_LABEL: Record<Severity, string> = {
  WARNING: "WARN",
  CAUTION: "CAUT",
  MEMO: "MEMO",
};

export interface LeaderParts {
  /** Left-hand remark/measurement text. */
  label: string;
  /** Trailing value rendered in cyan after a dot leader, or null for a plain remark. */
  value: string | null;
}

/**
 * Split an ECAM remark into a label + trailing cyan value for dot-leader layout,
 * matching the A350 EWD "ACTION ······· VALUE" convention.
 *
 *   "Thermistor 2 at 57.2C (limit 55)" -> { label: "Thermistor 2 at 57.2C", value: "limit 55" }
 *   "delta 0.142V (limit 0.10)"        -> { label: "delta 0.142V",          value: "limit 0.10" }
 *   "from DRIVE"                        -> { label: "from DRIVE",            value: null }
 */
export function splitLeader(detail: string): LeaderParts {
  const m = detail.match(/^(.*\S)\s*\(([^)]+)\)\s*$/);
  if (m) return { label: m[1].trim(), value: m[2].trim() };
  return { label: detail, value: null };
}

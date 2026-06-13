import type { ReactNode } from "react";

type Role = "title" | "remark" | "value" | "unit";

export function EcamLabel({ role, children }: { role: Role; children: ReactNode }) {
  return <span className={`wcars-lbl wcars-lbl--${role}`}>{children}</span>;
}

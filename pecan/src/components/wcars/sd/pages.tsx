import type { ComponentType } from "react";
import type { SdSignalKey } from "../../../lib/wcars/sdSignals";
import { WheelSynoptic } from "./WheelSynoptic";
import { ElecSchematic } from "./ElecSchematic";
import { SafetySynoptic } from "./SafetySynoptic";
import { MotorSynoptic } from "./MotorSynoptic";
import { CoolSynoptic } from "./CoolSynoptic";
import { StatusSynoptic } from "./StatusSynoptic";
import { MsgPage } from "./MsgPage";

export type SdPageId = "WHEEL" | "ELEC" | "LOOP" | "MOTOR" | "COOL" | "STS" | "MSG";

export interface SdPageDef {
  label: string;
  Component: ComponentType;
  primarySignals: SdSignalKey[];
}

export const SD_PAGES: Record<SdPageId, SdPageDef> = {
  WHEEL: { label: "WHEEL", Component: WheelSynoptic, primarySignals: ["leftRpm", "rightRpm"] },
  ELEC:  { label: "ELEC",  Component: ElecSchematic, primarySignals: ["packV", "packSoc"] },
  LOOP:  { label: "LOOP",  Component: SafetySynoptic, primarySignals: ["hvActive", "loopReturn"] },
  MOTOR: { label: "MOTOR", Component: MotorSynoptic, primarySignals: ["motorRpm", "motorTemp"] },
  COOL:  { label: "COOL",  Component: CoolSynoptic,  primarySignals: ["coolant"] },
  STS:   { label: "STS",   Component: StatusSynoptic, primarySignals: [] },
  MSG:   { label: "MSG",   Component: MsgPage,        primarySignals: [] },
};

export const PAGE_ORDER: SdPageId[] = ["WHEEL", "ELEC", "LOOP", "MOTOR", "COOL", "STS", "MSG"];

const RULE_PAGE: Record<string, SdPageId> = {
  TORCH_CELL_TEMP: "ELEC",
  TORCH_CELL_IMBALANCE: "ELEC",
  TORCH_FAULT: "ELEC",
  // Safety loop / shutdown circuit (confirm names against the alert ruleset)
  HV_LOSS: "LOOP",
  IMD_FAULT: "LOOP",
  AMS_FAULT: "LOOP",
  BSPD_FAULT: "LOOP",
  SAFETY_LOOP_OPEN: "LOOP",
  PRECHARGE_ERROR: "LOOP",
  INV_FAULT: "MOTOR",
  INV_VSM_STATE: "MOTOR",
  VCU_STATE_FAULT: "STS",
  VCU_STATE_CHANGE: "STS",
};

export function ruleToPage(rule: string): SdPageId | null {
  return RULE_PAGE[rule] ?? null;
}

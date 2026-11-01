import { useState, type ReactNode } from "react";
import { MessageGroup, SensorsGroupedResponse } from "../types";
import { OTHER_PALETTE, subsystemColor, type PaletteEntry } from "./sensor-palette";

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  grouped: SensorsGroupedResponse;
  theme: "light" | "dark";
  onPick: (sensor: string) => void;
}

interface GroupRowProps {
  groupKey: string;
  name: string;
  signals: string[];
  colors: PaletteEntry;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  onPick: (s: string) => void;
  badge?: ReactNode;
}

function GroupRow({ groupKey, name, signals, colors, count, collapsed, onToggle, onPick, badge }: GroupRowProps) {
  return (
    <div className="message-group">
      <button
        type="button"
        className="message-group-header"
        onClick={onToggle}
        style={{ borderLeftColor: colors.border, background: collapsed ? undefined : colors.bg }}
        aria-expanded={!collapsed}
      >
        <span
          className="message-group-chevron"
          style={{ transform: collapsed ? "rotate(-90deg)" : undefined }}
          aria-hidden="true"
        >
          ▾
        </span>
        <span className="message-group-name">{name}</span>
        {badge}
        <span className="message-group-count">{count}</span>
      </button>
      {!collapsed && (
        <div className="message-group-body">
          <div className="sensor-grid sensor-grid--compact">
            {signals.map((signal) => (
              <button
                key={signal}
                type="button"
                className="sensor-chip"
                onClick={() => onPick(signal)}
              >
                {signal}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function SensorGroupedGrid({ grouped, theme, onPick }: Props) {
  // Track which groups are collapsed; default is all expanded so signals are
  // visible (and findable via browser Ctrl+F) without clicking into each group.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });

  const hasUngrouped = grouped.ungrouped.length > 0;

  return (
    <div className="message-groups-container">
      {grouped.messages.map((msg: MessageGroup) => {
        const colors = subsystemColor(msg.subsystem, theme);
        return (
          <GroupRow
            key={msg.name}
            groupKey={msg.name}
            name={msg.name}
            signals={msg.signals}
            colors={colors}
            count={msg.signals.length}
            collapsed={collapsed.has(msg.name)}
            onToggle={() => toggle(msg.name)}
            onPick={onPick}
            badge={
              <>
                <span
                  className="subsystem-badge"
                  style={{
                    background: colors.badgeBg,
                    color: colors.badgeText,
                    borderColor: colors.border + "55",
                  }}
                >
                  {msg.subsystem}
                </span>
                <span
                  className="can-id-badge"
                  style={{
                    background: colors.badgeBg,
                    color: colors.badgeText,
                    borderColor: colors.border + "55",
                  }}
                >
                  {msg.can_id_hex} · {msg.can_id}
                </span>
              </>
            }
          />
        );
      })}

      {hasUngrouped && (
        <GroupRow
          groupKey="__ungrouped__"
          name="Other"
          signals={grouped.ungrouped}
          colors={OTHER_PALETTE}
          count={grouped.ungrouped.length}
          collapsed={collapsed.has("__ungrouped__")}
          onToggle={() => toggle("__ungrouped__")}
          onPick={onPick}
        />
      )}
    </div>
  );
}

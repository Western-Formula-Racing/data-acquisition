import { useMemo, useState, type ReactNode } from "react";

import { NEW_PLOT } from "../analysis/plot-layout";
import type { MessageGroup, SensorsGroupedResponse } from "../types";
import { PlotAssignMenu } from "./PlotAssignMenu";
import { SIGNALS_MIME } from "./AnalysisPlotStack";
import { OTHER_PALETTE, subsystemColor, type PaletteEntry } from "./sensor-palette";

function matchesQuery(haystacks: Array<string | number>, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return haystacks.some((value) => String(value).toLowerCase().includes(q));
}

export interface AnalysisSignalPickerProps {
  grouped: SensorsGroupedResponse;
  selected: ReadonlySet<string>;
  onToggle: (signal: string) => void;
  onClearAll?: () => void;
  onAssignSignals?: (signals: string[], target: string) => void;
  assignments?: Record<string, number>;
  plotOptions?: Array<{ id: string; label: string }>;
  theme: "light" | "dark";
  maxSelected?: number;
}

interface PickerGroupProps {
  groupKey: string;
  name: string;
  signals: string[];
  colors: PaletteEntry;
  collapsed: boolean;
  onCollapseToggle: () => void;
  selected: ReadonlySet<string>;
  onToggle: (signal: string) => void;
  onAssignSignals?: (signals: string[], target: string) => void;
  assignments?: Record<string, number>;
  plotOptions?: Array<{ id: string; label: string }>;
  atCap: boolean;
  badge?: ReactNode;
}

function PickerGroup({
  groupKey,
  name,
  signals,
  colors,
  collapsed,
  onCollapseToggle,
  selected,
  onToggle,
  onAssignSignals,
  assignments,
  plotOptions,
  atCap,
  badge,
}: PickerGroupProps) {
  return (
    <div className="message-group analysis-signal-group" data-group={groupKey}>
      <button
        type="button"
        className="message-group-header"
        onClick={onCollapseToggle}
        onDoubleClick={() => onAssignSignals?.(signals, NEW_PLOT)}
        draggable={Boolean(onAssignSignals)}
        onDragStart={(e) => {
          e.dataTransfer.setData(SIGNALS_MIME, JSON.stringify({ signals }));
          e.dataTransfer.effectAllowed = "move";
        }}
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
        <span className="message-group-count">{signals.length}</span>
      </button>
      {!collapsed && (
        <div className="message-group-body">
          <div className="sensor-grid sensor-grid--compact" role="group" aria-label={name}>
            {signals.map((signal) => {
              const isSelected = selected.has(signal);
              const disabled = atCap && !isSelected;
              return (
                <span key={signal} className="analysis-signal-item">
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={isSelected}
                    aria-disabled={disabled || undefined}
                    disabled={disabled}
                    draggable={Boolean(onAssignSignals)}
                    onDragStart={(e) => {
                      e.dataTransfer.setData(SIGNALS_MIME, JSON.stringify({ signals: [signal] }));
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    className={
                      isSelected
                        ? "sensor-chip analysis-signal-chip is-selected"
                        : "sensor-chip analysis-signal-chip"
                    }
                    onClick={() => {
                      if (disabled) return;
                      onToggle(signal);
                    }}
                  >
                    {signal}
                  </button>
                  {isSelected && onAssignSignals && plotOptions && (
                    <PlotAssignMenu
                      signal={signal}
                      value={
                        assignments?.[signal] != null
                          ? plotOptions[assignments[signal] - 1]?.id ?? NEW_PLOT
                          : NEW_PLOT
                      }
                      options={plotOptions}
                      onAssign={(target) => onAssignSignals([signal], target)}
                    />
                  )}
                </span>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export function AnalysisSignalPicker({
  grouped,
  selected,
  onToggle,
  onClearAll,
  onAssignSignals,
  assignments,
  plotOptions,
  theme,
  maxSelected = 12,
}: AnalysisSignalPickerProps) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const atCap = selected.size >= maxSelected;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return { messages: grouped.messages, ungrouped: grouped.ungrouped };
    }

    const messages: MessageGroup[] = [];
    for (const msg of grouped.messages) {
      const groupMatches = matchesQuery(
        [msg.name, msg.subsystem, msg.can_id, msg.can_id_hex],
        q,
      );
      const signals = groupMatches
        ? msg.signals
        : msg.signals.filter((signal) => matchesQuery([signal], q));
      if (signals.length > 0) {
        messages.push({ ...msg, signals });
      }
    }

    const ungrouped = grouped.ungrouped.filter((signal) => matchesQuery([signal, "Other"], q));
    return { messages, ungrouped };
  }, [grouped, query]);

  const toggleCollapsed = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="analysis-signal-picker">
      <div className="analysis-signal-picker-header">
        <label className="selector-label" htmlFor="analysis-signal-search">
          Signals
        </label>
        <div className="analysis-signal-picker-meta">
          <p className="selector-meta analysis-signal-picker-count" aria-live="polite">
            {selected.size} / {maxSelected} selected
          </p>
          <button
            type="button"
            className="button secondary analysis-signal-clear"
            onClick={onClearAll}
            disabled={!onClearAll || selected.size === 0}
            aria-label="Clear all selected signals"
          >
            Clear all
          </button>
        </div>
      </div>

      <input
        id="analysis-signal-search"
        type="search"
        className="selector-input analysis-signal-search"
        placeholder="Search message, subsystem, CAN ID, signal…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        aria-label="Search signals"
      />

      <div className="message-groups-container analysis-signal-groups">
        {filtered.messages.map((msg) => {
          const colors = subsystemColor(msg.subsystem, theme);
          return (
            <PickerGroup
              key={msg.name}
              groupKey={msg.name}
              name={msg.name}
              signals={msg.signals}
              colors={colors}
              collapsed={collapsed.has(msg.name)}
              onCollapseToggle={() => toggleCollapsed(msg.name)}
              selected={selected}
              onToggle={onToggle}
              onAssignSignals={onAssignSignals}
              assignments={assignments}
              plotOptions={plotOptions}
              atCap={atCap}
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

        {filtered.ungrouped.length > 0 && (
          <PickerGroup
            groupKey="__ungrouped__"
            name="Other"
            signals={filtered.ungrouped}
            colors={OTHER_PALETTE}
            collapsed={collapsed.has("__ungrouped__")}
            onCollapseToggle={() => toggleCollapsed("__ungrouped__")}
            selected={selected}
            onToggle={onToggle}
            onAssignSignals={onAssignSignals}
            assignments={assignments}
            plotOptions={plotOptions}
            atCap={atCap}
          />
        )}
      </div>
    </div>
  );
}

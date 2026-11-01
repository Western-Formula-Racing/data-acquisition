import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { createAnalysisConfig, deleteAnalysisConfig, fetchAnalysisConfigs, queryStates } from "../api";
import { findSeasonWithData } from "../analysis/analysis-range";
import { downloadSeriesCsv, seriesToCsv } from "../analysis/export-csv";
import {
  type PlotLayout,
  type ParsedLayout,
  assignSignals,
  clearRightAxisForSignals,
  clearSignalColor,
  flattenSignals,
  parseLayout,
  pruneUnknown,
  serializeLayout,
  setSignalColor,
  toggleRightAxis,
  toggleSignal,
} from "../analysis/plot-layout";
import { layoutToPlots, plotsToLayout } from "../analysis/saved-config";
import type { SeriesMap } from "../analysis/series-cache";
import { useSeriesData } from "../analysis/use-series-data";
import type { RunRecord, SavedConfig, Season, SensorsGroupedResponse, StatesResponse } from "../types";
import { AnalysisConfigMenu } from "./AnalysisConfigMenu";
import { AnalysisPlotStack } from "./AnalysisPlotStack";
import { AnalysisSignalPicker } from "./AnalysisSignalPicker";
import { AnalysisStateTimeline } from "./AnalysisStateTimeline";
import { AnalysisToolbar } from "./AnalysisToolbar";

const layoutStorageKey = (seasonName: string) => `analysis-layout:${seasonName}`;
const configCollapsedKey = "analysis-config-collapsed";

function knownSignalsOf(grouped: SensorsGroupedResponse | null): Set<string> | null {
  if (!grouped) return null;
  return new Set([...grouped.messages.flatMap((m) => m.signals), ...grouped.ungrouped]);
}

export interface AnalysisWorkspaceProps {
  season: Season;
  runs: RunRecord[];
  grouped: SensorsGroupedResponse | null;
  theme: "light" | "dark";
  runsBySeason: Record<string, RunRecord[]>;
  pendingConfig?: SavedConfig | null;
  onPendingConfigConsumed?: () => void;
  onCrossSeasonLoad?: (config: SavedConfig) => void;
}

const EMPTY_GROUPED: SensorsGroupedResponse = {
  updated_at: null,
  dbc_source: "none",
  messages: [],
  ungrouped: [],
};

function isValidRange(startMs: number, endMs: number): boolean {
  return Number.isFinite(startMs) && Number.isFinite(endMs) && startMs < endMs;
}

function hasPlottableSeries(
  seriesBySignal: Record<string, { point_count: number }>,
  signals: string[],
): boolean {
  return signals.some((signal) => {
    const series = seriesBySignal[signal];
    return series != null && series.point_count > 0;
  });
}

function signalsMatchExact(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((signal) => set.has(signal));
}

function selectedOnlySeries(seriesBySignal: SeriesMap, signals: string[]): SeriesMap {
  const filtered: SeriesMap = {};
  for (const signal of signals) {
    const series = seriesBySignal[signal];
    if (series) filtered[signal] = series;
  }
  return filtered;
}

export function AnalysisWorkspace({
  season,
  runs,
  grouped,
  theme,
  runsBySeason,
  pendingConfig = null,
  onPendingConfigConsumed,
  onCrossSeasonLoad,
}: AnalysisWorkspaceProps) {
  // A pendingConfig arrives only after App switched the season to match it.
  const seededConfig = pendingConfig && pendingConfig.season === season.table ? pendingConfig : null;

  const [selectedRunKey, setSelectedRunKey] = useState("");
  const [plots, setPlots] = useState<PlotLayout>(() => {
    if (seededConfig) return plotsToLayout(seededConfig.plots);
    try {
      const parsed = parseLayout(window.localStorage.getItem(layoutStorageKey(season.name)));
      return parsed?.layout ?? [];
    } catch {
      return [];
    }
  });
  const [colorOverrides, setColorOverrides] = useState<Record<string, string>>(() => {
    if (seededConfig?.colors) return { ...seededConfig.colors };
    try {
      const parsed = parseLayout(window.localStorage.getItem(layoutStorageKey(season.name)));
      return parsed?.colorOverrides ?? {};
    } catch {
      return {};
    }
  });
  const seededRange = useMemo<[number, number] | null>(() => {
    if (!seededConfig) return null;
    const start = new Date(seededConfig.start).getTime();
    const end = new Date(seededConfig.end).getTime();
    return Number.isFinite(start) && Number.isFinite(end) && start < end ? [start, end] : null;
    // seededConfig is fixed for this mount; compute once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [fullRange, setFullRange] = useState<[number, number] | null>(seededRange);
  const [viewRange, setViewRange] = useState<[number, number] | null>(seededRange);
  const [awaitingFirstResponse, setAwaitingFirstResponse] = useState(false);
  const [exportConfirmOpen, setExportConfirmOpen] = useState(false);
  const [statesData, setStatesData] = useState<StatesResponse | null>(null);
  const [statesLoading, setStatesLoading] = useState(false);
  const [statesError, setStatesError] = useState<string | null>(null);
  const [statesReloadKey, setStatesReloadKey] = useState(0);
  const [configs, setConfigs] = useState<SavedConfig[]>([]);
  const [crossSeasonPrompt, setCrossSeasonPrompt] = useState<SavedConfig | null>(null);
  const [configCollapsed, setConfigCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem(configCollapsedKey) === "1";
    } catch {
      return false;
    }
  });

  const { seriesBySignal, loadedRequest, loading, error, requestRange, retry } = useSeriesData();

  const seasonName = season.name;
  const seasonTable = season.table;

  useEffect(() => {
    if (seededConfig) onPendingConfigConsumed?.();
    // Run once on mount; seededConfig is fixed for this mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshConfigs = useCallback(() => {
    fetchAnalysisConfigs()
      .then(setConfigs)
      .catch(() => {
        // A failed config fetch must never break the analysis view.
      });
  }, []);

  useEffect(() => {
    refreshConfigs();
  }, [refreshConfigs]);

  // Persist on every layout change; storage failures must never break the UI.
  useEffect(() => {
    try {
      window.localStorage.setItem(layoutStorageKey(seasonName), serializeLayout(plots, colorOverrides));
    } catch {
      // Ignore persistence failures in restricted environments.
    }
  }, [plots, colorOverrides, seasonName]);

  const knownSignals = useMemo(() => knownSignalsOf(grouped), [grouped]);

  // Drop persisted signals this season does not know before they can hit the API.
  useEffect(() => {
    if (!knownSignals) return;
    setPlots((prev) => pruneUnknown(prev, knownSignals));
  }, [knownSignals]);

  const selectedSignals = useMemo(() => flattenSignals(plots), [plots]);
  const selectedSet = useMemo(() => new Set(selectedSignals), [selectedSignals]);
  // Only request signals the season knows: a stale persisted signal must never reach
  // the API, even in the commit before pruneUnknown cleans the layout itself.
  const requestSignals = useMemo(
    () => (knownSignals ? selectedSignals.filter((s) => knownSignals.has(s)) : []),
    [knownSignals, selectedSignals],
  );
  // Order-insensitive key over the filtered set so neither regrouping nor the
  // post-prune re-render (which drops the stale signal) refires the request.
  const signalsKey = useMemo(() => [...requestSignals].sort().join(" "), [requestSignals]);

  const handleToggleSignal = useCallback((signal: string) => {
    setPlots((prev) => toggleSignal(prev, signal));
  }, []);

  const handleClearAll = useCallback(() => {
    setPlots([]);
  }, []);

  const handleAssignSignals = useCallback((signals: string[], target: string) => {
    setPlots((prev) => assignSignals(prev, signals, target));
  }, []);

  const handleToggleRightAxis = useCallback((groupId: string, signal: string) => {
    setPlots((prev) => toggleRightAxis(prev, groupId, signal));
  }, []);

  const handleAssignSignalsToAxis = useCallback(
    (signals: string[], target: string, axis: "left" | "right") => {
      setPlots((prev) => {
        const next = assignSignals(prev, signals, target);
        if (axis === "right") {
          // Find the target group after assignment and set each signal to right axis.
          const targetGroup = next.find((g) => signals.some((s) => g.signals.includes(s)));
          if (targetGroup) {
            let result = next;
            for (const signal of signals) {
              if (!targetGroup.rightAxis.includes(signal)) {
                result = toggleRightAxis(result, targetGroup.id, signal);
              }
            }
            return result;
          }
        }
        if (axis === "left") {
          return clearRightAxisForSignals(next, signals);
        }
        return next;
      });
    },
    [],
  );

  const handleSetSignalColor = useCallback((signal: string, color: string) => {
    setColorOverrides((prev) => setSignalColor(prev, signal, color));
  }, []);

  const handleClearSignalColor = useCallback((signal: string) => {
    setColorOverrides((prev) => clearSignalColor(prev, signal));
  }, []);

  const handleRunChange = useCallback((runKey: string, startMs: number, endMs: number) => {
    setSelectedRunKey(runKey);
    setFullRange([startMs, endMs]);
    setViewRange([startMs, endMs]);
    setExportConfirmOpen(false);
  }, []);

  const handleSelectCustom = useCallback(() => {
    setSelectedRunKey("");
  }, []);

  const handleCustomRange = useCallback((startMs: number, endMs: number) => {
    setSelectedRunKey("");
    setFullRange([startMs, endMs]);
    setViewRange([startMs, endMs]);
    setExportConfirmOpen(false);
  }, []);

  const handlePlotRangeChange = useCallback(
    (startMs: number, endMs: number) => {
      if (Number.isNaN(startMs) && Number.isNaN(endMs)) {
        if (fullRange) setViewRange(fullRange);
        return;
      }
      if (!isValidRange(startMs, endMs)) return;
      setViewRange([startMs, endMs]);
    },
    [fullRange],
  );

  const applyConfig = useCallback((config: SavedConfig) => {
    const start = new Date(config.start).getTime();
    const end = new Date(config.end).getTime();
    setPlots(plotsToLayout(config.plots));
    setColorOverrides(config.colors ?? {});
    setSelectedRunKey("");
    if (Number.isFinite(start) && Number.isFinite(end) && start < end) {
      setFullRange([start, end]);
      setViewRange([start, end]);
    }
  }, []);

  const handleLoadConfig = useCallback(
    (config: SavedConfig) => {
      if (config.season === seasonTable) {
        applyConfig(config);
        return;
      }
      setCrossSeasonPrompt(config);
    },
    [seasonTable, applyConfig],
  );

  const handleConfirmCrossSeason = useCallback(() => {
    if (crossSeasonPrompt) onCrossSeasonLoad?.(crossSeasonPrompt);
    setCrossSeasonPrompt(null);
  }, [crossSeasonPrompt, onCrossSeasonLoad]);

  const handleToggleConfigCollapse = useCallback(() => {
    setConfigCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(configCollapsedKey, next ? "1" : "0");
      } catch {
        // Ignore persistence failures in restricted environments.
      }
      return next;
    });
  }, []);

  const handleSaveConfig = useCallback(
    (fields: { name: string; note: string; author: string }) => {
      if (!viewRange || plots.length === 0) return;
      createAnalysisConfig({
        name: fields.name,
        note: fields.note,
        author: fields.author,
        season: seasonTable,
        start: new Date(viewRange[0]).toISOString(),
        end: new Date(viewRange[1]).toISOString(),
        plots: layoutToPlots(plots),
        colors: Object.keys(colorOverrides).length > 0 ? colorOverrides : undefined,
      })
        .then(() => refreshConfigs())
        .catch(() => {
          // Surface nothing destructive; the list simply will not gain the entry.
        });
    },
    [viewRange, plots, colorOverrides, seasonTable, refreshConfigs],
  );

  const handleDeleteConfig = useCallback(
    (id: string) => {
      deleteAnalysisConfig(id)
        .then(() => refreshConfigs())
        .catch(() => refreshConfigs());
    },
    [refreshConfigs],
  );

  const saveConfigDisabled = plots.length === 0 || !viewRange;

  // Request series whenever table + signals + view range are valid.
  useEffect(() => {
    if (!viewRange || !isValidRange(viewRange[0], viewRange[1])) return;
    // Wait for the sensor list so restored layouts are pruned before the first request.
    if (!knownSignals) return;
    if (requestSignals.length === 0) return;
    setAwaitingFirstResponse(true);
    setExportConfirmOpen(false);
    requestRange(seasonTable, [...requestSignals].sort(), viewRange[0], viewRange[1]);
    // signalsKey stands in for requestSignals so regrouping does not refire.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seasonTable, signalsKey, viewRange, requestRange, knownSignals]);

  // Fetch the state timeline once per selected window; zoom is display-only.
  useEffect(() => {
    if (!fullRange || !isValidRange(fullRange[0], fullRange[1])) {
      setStatesData(null);
      setStatesError(null);
      return;
    }
    const controller = new AbortController();
    setStatesLoading(true);
    setStatesError(null);
    queryStates(
      {
        season: seasonTable,
        start: new Date(fullRange[0]).toISOString(),
        end: new Date(fullRange[1]).toISOString(),
      },
      { signal: controller.signal },
    )
      .then((response) => {
        setStatesData(response);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setStatesData(null);
        setStatesError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setStatesLoading(false);
      });
    return () => controller.abort();
  }, [seasonTable, fullRange, statesReloadKey]);

  // Mark first response complete once loading settles after a request.
  const wasLoadingRef = useRef(false);
  useEffect(() => {
    if (loading) {
      wasLoadingRef.current = true;
      return;
    }
    if (wasLoadingRef.current || Object.keys(seriesBySignal).length > 0 || error || loadedRequest) {
      setAwaitingFirstResponse(false);
      wasLoadingRef.current = false;
    }
  }, [loading, seriesBySignal, error, loadedRequest]);

  const exportSeries = useMemo(
    () => selectedOnlySeries(seriesBySignal, selectedSignals),
    [seriesBySignal, selectedSignals],
  );

  const loadedMatchesSelection =
    loadedRequest != null &&
    viewRange != null &&
    loadedRequest.seasonTable === seasonTable &&
    loadedRequest.startMs === viewRange[0] &&
    loadedRequest.endMs === viewRange[1] &&
    signalsMatchExact(loadedRequest.signals, selectedSignals) &&
    signalsMatchExact(Object.keys(exportSeries), selectedSignals);

  const toolbarRange: [number, number] = viewRange ?? [Number.NaN, Number.NaN];
  const exportDisabled =
    selectedSignals.length === 0 ||
    !viewRange ||
    loading ||
    awaitingFirstResponse ||
    !loadedMatchesSelection ||
    !hasPlottableSeries(exportSeries, selectedSignals);

  const wrongSeasonHint = useMemo(() => {
    if (!viewRange || !isValidRange(viewRange[0], viewRange[1])) return null;
    if (loading || awaitingFirstResponse) return null;
    if (hasPlottableSeries(seriesBySignal, selectedSignals)) return null;
    if (selectedSignals.length === 0) return null;
    return findSeasonWithData(runsBySeason, viewRange[0], viewRange[1], seasonName);
  }, [
    viewRange,
    loading,
    awaitingFirstResponse,
    seriesBySignal,
    selectedSignals,
    runsBySeason,
    seasonName,
  ]);

  const showEmpty =
    !error &&
    !awaitingFirstResponse &&
    !loading &&
    selectedSignals.length > 0 &&
    viewRange != null &&
    !hasPlottableSeries(seriesBySignal, selectedSignals);

  // True only when we still have plots rendered AND a refresh is in flight
  // (signal/window change after the first response). Drives the "Refreshing"
  // overlay instead of letting the plot stack silently redraw.
  const refreshInFlight = !error && (loading || awaitingFirstResponse) && !showEmpty && (awaitingFirstResponse || hasPlottableSeries(seriesBySignal, selectedSignals) || wrongSeasonHint != null);

  const keepPreviousPlots =
    !error &&
    selectedSignals.length > 0 &&
    viewRange != null &&
    hasPlottableSeries(seriesBySignal, selectedSignals);

  const performExport = useCallback(() => {
    if (!loadedRequest || exportDisabled) return;
    downloadSeriesCsv(
      exportSeries,
      seasonName,
      loadedRequest.startMs,
      loadedRequest.endMs,
    );
    setExportConfirmOpen(false);
  }, [loadedRequest, exportDisabled, exportSeries, seasonName]);

  const handleExport = useCallback(() => {
    if (exportDisabled) return;
    const { containsEnvelope } = seriesToCsv(exportSeries);
    if (containsEnvelope) {
      setExportConfirmOpen(true);
      return;
    }
    performExport();
  }, [exportDisabled, exportSeries, performExport]);

  const handleTimelineSelect = useCallback((startMs: number, endMs: number) => {
    setViewRange([startMs, endMs]);
  }, []);

  const handleStatesRetry = useCallback(() => {
    setStatesReloadKey((key) => key + 1);
  }, []);

  const pickerGrouped = grouped ?? EMPTY_GROUPED;

  const plotOptions = useMemo(
    () => plots.map((p, i) => ({ id: p.id, label: `Plot ${i + 1}` })),
    [plots],
  );
  const assignments = useMemo(() => {
    const map: Record<string, number> = {};
    plots.forEach((p, i) =>
      p.signals.forEach((s) => {
        map[s] = i + 1;
      }),
    );
    return map;
  }, [plots]);

  return (
    <div className="analysis-workspace">
      <AnalysisToolbar
        runs={runs}
        selectedRunKey={selectedRunKey}
        range={toolbarRange}
        loading={loading || awaitingFirstResponse}
        exportDisabled={exportDisabled}
        onRunChange={handleRunChange}
        onSelectCustom={handleSelectCustom}
        onCustomRange={handleCustomRange}
        onExport={handleExport}
      />

      {crossSeasonPrompt && (
        <div className="analysis-export-confirm" role="status">
          <p>
            "{crossSeasonPrompt.name}" was saved on {crossSeasonPrompt.season}. Switch from{" "}
            {seasonTable} and load it?
          </p>
          <div className="analysis-export-confirm-actions">
            <button type="button" className="button" onClick={handleConfirmCrossSeason}>
              Switch and load
            </button>
            <button
              type="button"
              className="button secondary"
              onClick={() => setCrossSeasonPrompt(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {exportConfirmOpen && (
        <div
          className="analysis-export-confirm"
          data-testid="analysis-export-confirm"
          role="status"
        >
          <p>
            This export includes envelope (downsampled) data with avg/min/max columns — not raw
            samples.
          </p>
          <div className="analysis-export-confirm-actions">
            <button type="button" className="button" onClick={performExport}>
              Export anyway
            </button>
            <button
              type="button"
              className="button secondary"
              onClick={() => setExportConfirmOpen(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className={`analysis-grid${configCollapsed ? " is-config-collapsed" : ""}`}>
        <aside className="analysis-rail">
          <AnalysisSignalPicker
            grouped={pickerGrouped}
            selected={selectedSet}
            onToggle={handleToggleSignal}
            onClearAll={handleClearAll}
            onAssignSignals={handleAssignSignals}
            assignments={assignments}
            plotOptions={plotOptions}
            theme={theme}
          />
        </aside>

        <section className="analysis-plots" aria-live="polite">
          {fullRange && viewRange && (
            <AnalysisStateTimeline
              data={statesData}
              loading={statesLoading}
              error={statesError}
              viewRange={viewRange}
              onSelectRange={handleTimelineSelect}
              onRetry={handleStatesRetry}
            />
          )}

          {error && (
            <div className="analysis-error card" role="alert">
              <strong>Could not load series.</strong>
              <p>{error}</p>
              <button type="button" className="button" onClick={() => retry()}>
                Retry
              </button>
            </div>
          )}

          {!error && awaitingFirstResponse && !keepPreviousPlots && (
            <div className="analysis-status-badge" role="status">
              Loading series…
            </div>
          )}

          {!error && showEmpty && (
            <div className="analysis-empty" data-testid="analysis-empty" role="status">
              <p>No samples in this range for the selected signals.</p>
              {wrongSeasonHint && (
                <p className="analysis-empty-hint">
                  Overlapping indexed runs exist in {wrongSeasonHint}. Try switching seasons.
                </p>
              )}
            </div>
          )}

          {!error && keepPreviousPlots && viewRange && (
            <div className="analysis-plot-stack-wrap">
              <AnalysisPlotStack
                layout={plots}
                seriesBySignal={seriesBySignal}
                range={viewRange}
                colorOverrides={colorOverrides}
                onRangeChange={handlePlotRangeChange}
                onAssignSignals={handleAssignSignals}
                onAssignSignalsToAxis={handleAssignSignalsToAxis}
                onRemoveSignal={handleToggleSignal}
                onToggleRightAxis={handleToggleRightAxis}
                onSetSignalColor={handleSetSignalColor}
                onClearSignalColor={handleClearSignalColor}
                theme={theme}
              />
              {refreshInFlight && (
                <div className="analysis-refreshing" role="status" data-testid="analysis-refreshing">
                  Refreshing…
                </div>
              )}
            </div>
          )}

          {/* Range selected, no signals yet: show a droppable plot area instead of
              the "select a run window" idle prompt (window is already chosen). */}
          {!error &&
            !awaitingFirstResponse &&
            !loading &&
            !showEmpty &&
            !keepPreviousPlots &&
            fullRange &&
            viewRange &&
            selectedSignals.length === 0 && (
              <div className="analysis-plot-stack-wrap">
                <AnalysisPlotStack
                  layout={[]}
                  seriesBySignal={seriesBySignal}
                  range={viewRange}
                  colorOverrides={colorOverrides}
                  onRangeChange={handlePlotRangeChange}
                  onAssignSignals={handleAssignSignals}
                  onAssignSignalsToAxis={handleAssignSignalsToAxis}
                  onRemoveSignal={handleToggleSignal}
                  onToggleRightAxis={handleToggleRightAxis}
                  onSetSignalColor={handleSetSignalColor}
                  onClearSignalColor={handleClearSignalColor}
                  theme={theme}
                />
              </div>
            )}

          {!error &&
            !awaitingFirstResponse &&
            !loading &&
            !showEmpty &&
            !keepPreviousPlots &&
            !fullRange &&
            selectedSignals.length > 0 && (
              <div className="analysis-idle" role="status" data-testid="analysis-idle-no-window">
                <strong>{selectedSignals.length} signal{selectedSignals.length === 1 ? "" : "s"} selected.</strong>
                <p>Select a run window or time range to plot them.</p>
              </div>
            )}
          {!error &&
            !awaitingFirstResponse &&
            !loading &&
            !showEmpty &&
            !keepPreviousPlots &&
            !fullRange &&
            selectedSignals.length === 0 && (
              <div className="analysis-idle" role="status" data-testid="analysis-idle-no-selection">
                Select a run window and one or more signals to load linked plots.
              </div>
            )}
        </section>

        <AnalysisConfigMenu
          configs={configs}
          activeSeasonTable={seasonTable}
          saveDisabled={saveConfigDisabled}
          collapsed={configCollapsed}
          onToggleCollapse={handleToggleConfigCollapse}
          onSave={handleSaveConfig}
          onLoad={handleLoadConfig}
          onDelete={handleDeleteConfig}
        />
      </div>
    </div>
  );
}

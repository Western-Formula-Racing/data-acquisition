import { useState, useEffect, useRef, useMemo } from "react";
import DataCard from "../components/DataCard";
import DataRow from "../components/DataRow";
import PlotManager from "../components/PlotManager";
import type { PlotSignal } from "../components/PlotManager";
import PlotControls from "../components/PlotControls";
import { dataStore } from "../lib/DataStore";
import { useAllLatestMessages, useDataStoreStats } from "../lib/useDataStore";
import atozIcon from "../assets/atoz.png";
import ztoaIcon from "../assets/ztoa.png";
import sortIcon from "../assets/sort.png";
import idAscendingIcon from "../assets/id_ascending.png";
import idDescendingIcon from "../assets/id_descending.png";
import listViewIcon from "../assets/list-view.png";
import gridViewIcon from "../assets/grid-view.png";
import { useOutletContext } from "react-router";
import TourGuide from "../components/TourGuide";
import type { TourStep } from "../components/TourGuide";
import { useRemoteConfig } from "../lib/useRemoteConfig";

interface Plot {
  id: string;
  signals: PlotSignal[];
}

const TOUR_STEPS: TourStep[] = [
  {
    targetId: "dash-view-toggle",
    title: "View Modes",
    content: "Switch between 'Grid View' (Cards) and 'List View' (Compact Rows) here.",
    position: "bottom"
  },
  {
    targetId: "dash-sort-btn",
    title: "Sorting",
    content: "Click here to sort messages by Name, ID, or Category.",
    position: "bottom"
  },
  {
    targetId: "tour-signal-label",
    title: "Interactive Signals",
    content: "Click this signal name to open the Plot Controls menu.",
    position: "right",
    waitForInteraction: true
  },
  {
    targetId: "tour-new-plot-btn",
    title: "Create Plot",
    content: "Click 'New Plot' to start visualizing this data.",
    position: "right",
    waitForInteraction: true
  },
  {
    targetId: "dash-plot-sidebar",
    title: "Plot Area",
    content: "Your active time-series plot has appeared here! You can add more signals to it or close it.",
    position: "left"
  }
];

function Dashboard() {
  // Sorting and View State
  // =====================================================================
  const [sortingMethod, setSortingMethod] = useState("name");
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [tickUpdate, setTickUpdate] = useState(Date.now());
  const [currentSortIcon, setCurrentSortIcon] = useState(atozIcon);
  const [viewMode, setViewMode] = useState<"cards" | "list">("list");

  const [tourOpen, setTourOpen] = useState(false);
  const [currentTourStep, setCurrentTourStep] = useState(0);
  const [plotPanelOpen, setPlotPanelOpen] = useState(true);
  const setPplotPanelOpen = setPlotPanelOpen;
  const [showPerfOverlay, setShowPerfOverlay] = useState(() =>
    localStorage.getItem("perf-overlay-enabled") === "true"
  );

  // Listen for perf overlay setting changes
  useEffect(() => {
    const handlePerfChange = () => {
      setShowPerfOverlay(localStorage.getItem("perf-overlay-enabled") === "true");
    };
    window.addEventListener("perf-overlay-changed", handlePerfChange);
    return () => window.removeEventListener("perf-overlay-changed", handlePerfChange);
  }, []);

  const { isSidebarOpen: _isSidebarOpen } = useOutletContext<{ isSidebarOpen: boolean }>();


  // Plotting State
  // =====================================================================
  const [plots, setPlots] = useState<Plot[]>([]);
  const [nextPlotId, setNextPlotId] = useState(1);
  const [plotTimeWindow, setPlotTimeWindow] = useState(30000); // Default 30s in ms
  const [plotControls, setPlotControls] = useState<{
    visible: boolean;
    signalInfo: {
      msgID: string;
      signalName: string;
      messageName: string;
      unit: string;
    } | null;
    position: { x: number; y: number };
  }>({
    visible: false,
    signalInfo: null,
    position: { x: 0, y: 0 },
  });

  const sortingFilter = useRef({
    name: 0,
    category: 0,
    id: 1,
    prev: "",
  });

  // Cloud Sync
  // =====================================================================
  const { session, saveConfig, loadConfig } = useRemoteConfig();

  // Load config on login
  useEffect(() => {
    if (session) {
      loadConfig().then((config) => {
        if (config) {
          console.log("Applying remote config...");
          if (config.plots) setPlots(config.plots);
          if (config.viewMode) setViewMode(config.viewMode as "cards" | "list");
          if (config.sortingMethod) setSortingMethod(config.sortingMethod);
        }
      });
    }
  }, [session]); // Only run when session changes (login)

  // Save config on changes
  useEffect(() => {
    if (session) {
      saveConfig({
        plots,
        viewMode,
        sortingMethod,
      });
    }
  }, [plots, viewMode, sortingMethod, session, saveConfig]);

  // Data
  // =====================================================================

  // Use the DataStore hooks to get all latest messages
  const allLatestMessages = useAllLatestMessages();
  const dataStoreStats = useDataStoreStats();

  const [performanceStats, setPerformanceStats] = useState({
    memoryUsage: "N/A" as string | number,
    fps: 0,
  });

  const frameCountRef = useRef(0);
  const lastFpsUpdateRef = useRef(Date.now());

  // TEMPORARY: Expose dataStore to console for testing
  useEffect(() => {
    (window as any).dataStore = dataStore;
  }, []);

  // Performance monitoring
  useEffect(() => {
    // FPS monitoring
    const updateFPS = () => {
      frameCountRef.current++;
      const now = Date.now();
      if (now - lastFpsUpdateRef.current >= 1000) {
        const fps = Math.round(
          (frameCountRef.current * 1000) / (now - lastFpsUpdateRef.current)
        );
        setPerformanceStats((prev) => ({ ...prev, fps }));

        if (fps < 30) {
          console.warn(`Low FPS: ${fps}`);
        }

        frameCountRef.current = 0;
        lastFpsUpdateRef.current = now;
      }
      requestAnimationFrame(updateFPS);
    };
    requestAnimationFrame(updateFPS);

    // Memory monitoring
    const updateMemory = () => {
      if ("memory" in performance) {
        const memInfo = (performance as any).memory;
        const memoryMB = Math.round(memInfo.usedJSHeapSize / 1024 / 1024);
        setPerformanceStats((prev) => ({
          ...prev,
          memoryUsage: memoryMB,
        }));

        if (memoryMB > 100) {
          console.warn(`High memory usage: ${memoryMB}MB`);
        }
      }
    };
    const memoryInterval = setInterval(updateMemory, 2000);

    return () => {
      clearInterval(memoryInterval);
    };
  }, []);

  // Convert Map to array for rendering
  const canMessagesArray = Array.from(allLatestMessages.entries());

  // Sorting Logic
  // =====================================================================

  // Update sort icon and close menu when sorting method changes
  useEffect(() => {
    setSortMenuOpen(false);

    switch (sortingMethod) {
      case "name":
        if (sortingFilter.current.prev == "name") {
          sortingFilter.current.name = 1 - sortingFilter.current.name;
        }
        sortingFilter.current.prev = "name";
        setCurrentSortIcon(
          sortingFilter.current.name == 0
            ? atozIcon
            : ztoaIcon
        );
        break;
      case "category":
        if (sortingFilter.current.prev == "category") {
          sortingFilter.current.category = 1 - sortingFilter.current.category;
        }
        sortingFilter.current.prev = "category";
        setCurrentSortIcon(sortIcon);
        break;
      case "id":
        if (sortingFilter.current.prev == "id") {
          sortingFilter.current.id = 1 - sortingFilter.current.id;
        }
        sortingFilter.current.prev = "id";
        setCurrentSortIcon(
          sortingFilter.current.id == 0
            ? idAscendingIcon
            : idDescendingIcon
        );
        break;
    }
  }, [sortingMethod, tickUpdate]);

  // Sorts the filtered messages
  const filteredMsgs = useMemo(() => {
    const base = [...canMessagesArray];
    switch (sortingMethod) {
      case "name": {
        if (sortingFilter.current.name == 0) {
          return base.sort((a, b) =>
            a[1].messageName.localeCompare(b[1].messageName)
          );
        } else {
          return base.sort((a, b) =>
            b[1].messageName.localeCompare(a[1].messageName)
          );
        }
      }
      case "category": {
        // Sort by computed category matching DataRow logic
        const sorted = [...base].sort((a, b) => {
          const getCat = (entry: any) => {
            const [, sample] = entry;
            const data = sample.data;
            if (!data || Object.keys(data).length === 0) return "ZZZ_NO_CAT";
            const signalNames = Object.keys(data);
            const hasINV = signalNames.some((name) => name.includes("INV"));
            const hasBMS =
              signalNames.some(
                (name) => name.includes("BMS") || name.includes("TORCH")
              ) || sample.messageName.includes("TORCH");
            const hasVCU = signalNames.some((name) => name.includes("VCU"));
            if (hasVCU) return "VCU";
            else if (hasBMS) return "BMS/TORCH";
            else if (hasINV) return "INV";
            else return "ZZZ_NO_CAT";
          };
          return getCat(a).localeCompare(getCat(b));
        });
        return sortingFilter.current.category == 0 ? sorted : sorted.reverse();
      }
      case "id": {
        if (sortingFilter.current.id == 0) {
          return base.sort((a, b) =>
            a[0].localeCompare(b[0], undefined, {
              numeric: true,
            })
          );
        } else {
          return base.sort((a, b) =>
            b[0].localeCompare(a[0], undefined, {
              numeric: true,
            })
          );
        }
      }
      default:
        return base;
    }
  }, [canMessagesArray, sortingMethod, tickUpdate]);

  // View Mode & Tutorial Logic
  // =====================================================================

  // Persisting user view mode choice and tutorial check
  useEffect(() => {
    const savedView = localStorage.getItem("dash:viewMode");
    if (savedView == "cards" || savedView == "list") {
      setViewMode(savedView);
    }

    const hasSeenTutorial = localStorage.getItem("dash:tutorialSeen");
    if (!hasSeenTutorial) {
      // Small delay to let UI settle
      setTimeout(() => {
        setTourOpen(true);
        setCurrentTourStep(0);
      }, 500);
    }
  }, []);

  useEffect(() => {
    localStorage.setItem("dash:viewMode", viewMode);
  }, [viewMode]);

  const handleCloseTour = () => {
    setTourOpen(false);
    localStorage.setItem("dash:tutorialSeen", "true");
  };

  const handleStartTour = () => {
    setTourOpen(true);
    setCurrentTourStep(0);
  };

  // Plot Management Functions
  // =====================================================================
  const handleSignalClick = (
    msgID: string,
    signalName: string,
    messageName: string,
    unit: string,
    event: React.MouseEvent
  ) => {
    event.stopPropagation();
    setPlotControls({
      visible: true,
      signalInfo: { msgID, signalName, messageName, unit },
      position: { x: event.clientX, y: event.clientY },
    });

    // Advance tour if waiting for signal click
    if (tourOpen && currentTourStep === 2) {
      setCurrentTourStep(3);
    }
  };

  const handleNewPlot = (signalInfo: {
    msgID: string;
    signalName: string;
    messageName: string;
    unit: string;
  }) => {
    const newPlotId = String(nextPlotId);
    setPlots([
      ...plots,
      {
        id: newPlotId,
        signals: [signalInfo],
      },
    ]);
    setNextPlotId(nextPlotId + 1);

    // Advance tour if waiting for new plot creation
    if (tourOpen && currentTourStep === 3) {
      setCurrentTourStep(4);
    }
  };

  const handleAddToPlot = (
    plotId: string,
    signalInfo: {
      msgID: string;
      signalName: string;
      messageName: string;
      unit: string;
    }
  ) => {
    setPlots((prevPlots) =>
      prevPlots.map((plot) => {
        if (plot.id === plotId) {
          // Check if signal already exists in this plot
          const exists = plot.signals.some(
            (s) => s.msgID === signalInfo.msgID && s.signalName === signalInfo.signalName
          );
          if (!exists) {
            return {
              ...plot,
              signals: [...plot.signals, signalInfo],
            };
          }
        }
        return plot;
      })
    );
  };

  const handleRemoveSignalFromPlot = (
    plotId: string,
    msgID: string,
    signalName: string
  ) => {
    setPlots((prevPlots) =>
      prevPlots.map((plot) => {
        if (plot.id === plotId) {
          return {
            ...plot,
            signals: plot.signals.filter(
              (s) => !(s.msgID === msgID && s.signalName === signalName)
            ),
          };
        }
        return plot;
      })
    );
  };

  const handleClosePlot = (plotId: string) => {
    setPlots((prevPlots) => prevPlots.filter((plot) => plot.id !== plotId));
  };

  return (
    <div className="flex flex-col md:grid md:grid-cols-3 gap-0 w-100 h-full">
      {/* Tour Guide Overlay */}
      <TourGuide
        steps={TOUR_STEPS}
        isOpen={tourOpen}
        onClose={handleCloseTour}
        currentStepIndex={currentTourStep}
        onStepChange={setCurrentTourStep}
      />

      {/* Data display section */}
      <div className={`md:col-span-2 relative flex flex-col md:h-full overflow-hidden pb-12 md:pb-0 ${plotPanelOpen ? 'h-[50vh]' : 'flex-1'
        }`}>
        <div className="flex-1 p-4 pb-16 overflow-y-auto">
          {/* Data filter / view selection menu */}
          <div className="bg-data-module-bg w-full h-[60px] md:h-[100px] grid grid-cols-4 gap-1 rounded-md mb-[15px]">
            {/* Data category filters */}
            <div className="col-span-3">{/* WIP */}</div>

            {/* View selection options */}
            <div className="col-span-1 flex items-center justify-end gap-1 p-3">
              <div className="flex flex-row">


                {/* Filter button and dropdown  */}
                <div id="dash-sort-btn" className="relative">
                  <button
                    onClick={() => setSortMenuOpen((o) => !o)}
                    className="w-[50px] h-[50px] p-[10px] !rounded-lg flex justify-center items-center cursor-pointer hover:bg-data-textbox-bg/50 transition-colors object-contain"
                  >
                    <img src={currentSortIcon} alt="Sort" />
                  </button>
                  {sortMenuOpen && (
                    <div className="flex flex-col block fixed top-30 z-100 rounded-md bg-dropdown-menu-bg w-30 h-20 text-center text-white">
                      <span className="font-bold">Sort By</span>
                      <div className="bg-dropdown-menu-secondary flex flex-col space-between w-full h-full rounded-b-md">
                        <button
                          onClick={() => {
                            setSortingMethod("name");
                            setTickUpdate(Date.now());
                          }}
                          className={`${sortingMethod == "name" ? "font-bold" : "font-regular"
                            }`}
                        >
                          Name
                        </button>
                        <button
                          onClick={() => {
                            setSortingMethod("category");
                            setTickUpdate(Date.now());
                          }}
                          className={`${sortingMethod == "category"
                            ? "font-bold"
                            : "font-regular"
                            }`}
                        >
                          Category
                        </button>
                        <button
                          onClick={() => {
                            setSortingMethod("id");
                            setTickUpdate(Date.now());
                          }}
                          className={`${sortingMethod == "id" ? "font-bold" : "font-regular"
                            }`}
                        >
                          ID
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Hide view toggle buttons on mobile, only show list view */}
              <div id="dash-view-toggle" className="hidden md:flex">
                <button
                  onClick={() => setViewMode("list")}
                  className="w-[50px] h-[50px] p-[10px] !rounded-lg flex justify-center items-center cursor-pointer hover:bg-data-textbox-bg/50 transition-colors object-contain"
                  aria-pressed={viewMode === "list"}
                >
                  <img src={listViewIcon} alt="List view" />
                </button>
                <button
                  onClick={() => setViewMode("cards")}
                  className="w-[50px] h-[50px] p-[10px] !rounded-lg flex justify-center items-center cursor-pointer hover:bg-data-textbox-bg/50 transition-colors object-contain"
                  aria-pressed={viewMode === "cards"}
                >
                  <img src={gridViewIcon} alt="Grid view" />
                </button>
              </div>
            </div>
          </div>

          <div id="dash-data-list">
            {/* Force list view on mobile, respect viewMode on desktop */}
            {viewMode === "cards" ? (
              <div className="block">
                <div className="columns-2 gap-4">
                  {filteredMsgs.map(([canId, sample]) => {
                    const data = Object.entries(sample.data).map(
                      ([key, value]) => ({
                        [key]: `${value.sensorReading} ${value.unit}`,
                      })
                    );

                    return (
                      <div key={canId} className="mb-4 avoid-break">
                        <DataCard
                          key={canId}
                          msgID={canId}
                          name={sample.messageName}
                          data={
                            data.length > 0
                              ? data
                              : [
                                {
                                  "No Data": "Waiting for messages...",
                                },
                              ]
                          }
                          lastUpdated={sample.timestamp}
                          rawData={sample.rawData}
                          onSignalClick={handleSignalClick}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              // List view box
              <div className="w-100 h-fit rounded-sm bg-sidebar">
                {/* Header - responsive to match DataRow */}
                <div className="w-100 h-[40px] rounded-t-sm grid grid-cols-10 md:grid-cols-12 bg-data-module-bg text-white font-semibold text-sm shadow-md">
                  {/* Message ID column */}
                  <div className="col-span-2 md:col-span-1 flex justify-left items-center ps-3">
                    <button
                      onClick={() => {
                        setSortingMethod("id");
                        setTickUpdate(Date.now());
                      }}
                    >
                      Msg ID
                    </button>
                  </div>
                  {/* Message name column */}
                  <div className="col-span-4 flex justify-left items-center px-3">
                    <button
                      onClick={() => {
                        setSortingMethod("name");
                        setTickUpdate(Date.now());
                      }}
                    >
                      Message Name
                    </button>
                  </div>
                  {/* Category column */}
                  <div className="col-span-2 rounded-t-sm bg-data-textbox-bg flex justify-left items-center px-3">
                    <button
                      onClick={() => {
                        setSortingMethod("category");
                        setTickUpdate(Date.now());
                      }}
                    >
                      <span className="md:hidden">Cat</span>
                      <span className="hidden md:inline">Category</span>
                    </button>
                  </div>
                  {/* Data column - hidden on mobile */}
                  <div className="hidden md:flex col-span-3 justify-left items-center px-3">
                    Data
                  </div>
                  {/* Time column */}
                  <div className="col-span-2 flex justify-left items-center ps-3">
                    Time
                  </div>
                </div>

                {/* Rows */}

                {filteredMsgs.map(([canId, sample], i) => {
                  const data = Object.entries(sample.data).map(
                    ([key, value]) => ({
                      [key]: `${value.sensorReading} ${value.unit}`,
                    })
                  );

                  // Tour Targeting Logic:
                  // Try to find message 1024 for AccelX signal (dynamic plot).
                  // If not found, default to the first message (index 0).
                  const targetId = "1024";
                  const targetSignal = "AccelX";
                  const foundIndex = filteredMsgs.findIndex(([id]) => id === targetId);

                  // If found, target that index. If not, target 0.
                  const tourTargetIndex = foundIndex !== -1 ? foundIndex : 0;
                  const tourSignalName = foundIndex !== -1 ? targetSignal : undefined;

                  // Check if THIS row is the target
                  const isTarget = i === tourTargetIndex;

                  return (
                    <DataRow
                      key={canId}
                      msgID={canId}
                      name={sample.messageName}
                      data={
                        data.length > 0
                          ? data
                          : [
                            {
                              "No Data": "Waiting for messages...",
                            },
                          ]
                      }
                      lastUpdated={sample.timestamp}
                      rawData={sample.rawData}
                      index={i}
                      onSignalClick={handleSignalClick}
                      isTourRow={tourOpen && isTarget}
                      tourSignal={tourSignalName}
                      initialOpen={tourOpen && isTarget}
                    />
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Graph display section - collapsible on mobile */}
      <div
        id="dash-plot-sidebar"
        className={`md:col-span-1 bg-sidebar overflow-hidden flex flex-col transition-all duration-300 ${plotPanelOpen
            ? 'flex-1 md:h-full p-4'
            : `fixed ${showPerfOverlay ? 'bottom-8' : 'bottom-0'} left-0 right-0 h-12 z-20 md:relative md:h-full md:p-4`
          }`}
      >
        {/* Collapsible header - shows on mobile */}
        <button
          className={`md:hidden flex items-center justify-between w-full text-white font-semibold p-3 bg-data-module-bg ${plotPanelOpen ? 'rounded-md mb-2' : 'border-t border-white/10'
            }`}
          onClick={() => setPplotPanelOpen(!plotPanelOpen)}
        >
          <span>📊 Plots ({plots.length})</span>
          <span className="text-lg">{plotPanelOpen ? '▼' : '▲'}</span>
        </button>

        <div className={`flex-1 overflow-y-auto ${plotPanelOpen ? '' : 'hidden md:block'}`}>
          {/* Time Window Control */}
          <div className="bg-data-module-bg rounded-md p-3 mb-3">
            <h3 className="text-white font-semibold mb-2">Plot Settings</h3>
            <div className="flex flex-col gap-2">
              <label className="text-gray-300 text-sm">
                Time Window (seconds):
              </label>
              <input
                type="number"
                min="0"
                max="300"
                value={plotTimeWindow / 1000}
                onChange={(e) => {
                  const value = e.target.value;
                  if (value === '' || value === null) {
                    return;
                  }
                  const seconds = Math.max(0, Math.min(300, Number(value)));
                  setPlotTimeWindow(seconds * 1000);
                }}
                className="bg-data-textbox-bg text-white rounded px-2 py-1 text-sm"
              />
            </div>
          </div>

          {/* Plots */}
          {plots.length === 0 ? (
            <div className="text-center text-gray-500 mt-10">
              <p className="mb-2">No plots yet</p>
              <p className="text-sm">Click on a sensor to create a plot</p>
            </div>
          ) : (
            plots.map((plot) => (
              <PlotManager
                key={plot.id}
                plotId={plot.id}
                signals={plot.signals}
                timeWindowMs={plotTimeWindow}
                onRemoveSignal={(msgID, signalName) =>
                  handleRemoveSignalFromPlot(plot.id, msgID, signalName)
                }
                onClosePlot={() => handleClosePlot(plot.id)}
              />
            ))
          )}
        </div>
      </div>

      {/* Floating Tour Button */}
      <button
        onClick={handleStartTour}
        className="fixed bottom-10 right-6 z-40 w-10 h-10 rounded-full bg-blue-600 text-white shadow-lg flex items-center justify-center hover:bg-blue-500 hover:scale-110 transition-all"
        title="Start Tour"
        aria-label="Start Tour"
      >
        <span className="text-lg font-bold">?</span>
      </button>

      {/* Plot Controls Modal */}
      {
        plotControls.visible && plotControls.signalInfo && (
          <PlotControls
            signalInfo={plotControls.signalInfo}
            existingPlots={plots.map((p) => p.id)}
            position={plotControls.position}
            onNewPlot={handleNewPlot}
            onAddToPlot={handleAddToPlot}
            onClose={() =>
              setPlotControls({ visible: false, signalInfo: null, position: { x: 0, y: 0 } })
            }
          />
        )
      }

      {/* Performance Tab - Fixed at bottom (controlled by settings) */}
      {showPerfOverlay && (
        <div className="fixed bottom-0 left-0 right-0 z-30">
          <div className="w-full py-2 px-4 bg-data-textbox-bg/95 backdrop-blur text-gray-300 text-xs border-t border-white/10">
            <div className="flex justify-between items-center max-w-6xl mx-auto flex-wrap gap-1">
              <span>FPS: {performanceStats.fps}</span>
              <span className="hidden sm:inline">
                CAN: {dataStoreStats.totalMessages > 0 ? "Live" : "0"}
              </span>
              <span className="hidden md:inline">
                Mem: {performanceStats.memoryUsage}
                {typeof performanceStats.memoryUsage === "number" ? "MB" : ""}
              </span>
              <span className="hidden lg:inline">
                Store: {dataStoreStats.totalMessages} msgs, {dataStoreStats.totalSamples} samples
              </span>
              <span className="hidden lg:inline">Store Mem: {dataStoreStats.memoryEstimateMB}MB</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default Dashboard;
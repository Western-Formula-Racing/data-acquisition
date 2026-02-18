import { useState, useEffect, useRef, useMemo } from "react";
import DataCard from "../components/DataCard";
import DataRow from "../components/DataRow";
import { dataStore } from "../lib/DataStore";
import { useAllLatestMessages, useDataStoreStats } from "../lib/useDataStore";

function TxDashboard() {
  // Sorting and View State
  // =====================================================================
  const [sortingMethod, setSortingMethod] = useState("name");
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [tickUpdate, setTickUpdate] = useState(Date.now());
  const [sortIcon, setSortIcon] = useState("../src/assets/atoz.png");
  const [viewMode, setViewMode] = useState<"cards" | "list">("cards");

  const sortingFilter = useRef({
    name: 0,
    category: 0,
    id: 1,
    prev: "",
  });

  // Data
  // =====================================================================

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

  // Performance monitoring (same as Dashboard)
  useEffect(() => {
    const updateFPS = () => {
      frameCountRef.current++;
      const now = Date.now();
      if (now - lastFpsUpdateRef.current >= 1000) {
        const fps = Math.round(
          (frameCountRef.current * 1000) / (now - lastFpsUpdateRef.current)
        );
        setPerformanceStats((prev) => ({ ...prev, fps }));
        frameCountRef.current = 0;
        lastFpsUpdateRef.current = now;
      }
      requestAnimationFrame(updateFPS);
    };
    requestAnimationFrame(updateFPS);

    const updateMemory = () => {
      if ("memory" in performance) {
        const memInfo = (performance as any).memory;
        const memoryMB = Math.round(memInfo.usedJSHeapSize / 1024 / 1024);
        setPerformanceStats((prev) => ({
          ...prev,
          memoryUsage: memoryMB,
        }));
      }
    };
    const memoryInterval = setInterval(updateMemory, 2000);

    return () => clearInterval(memoryInterval);
  }, []);

  // ✅ Filter to TX only
  const txMessagesArray = useMemo(() => {
    return Array.from(allLatestMessages.entries()).filter(([, sample]) => {
      return (sample.direction ?? "rx") === "tx";
    });
  }, [allLatestMessages]);

  // Sorting Logic
  // =====================================================================

  useEffect(() => {
    setSortMenuOpen(false);

    switch (sortingMethod) {
      case "name":
        if (sortingFilter.current.prev == "name") {
          sortingFilter.current.name = 1 - sortingFilter.current.name;
        }
        sortingFilter.current.prev = "name";
        setSortIcon(
          sortingFilter.current.name == 0
            ? "../src/assets/atoz.png"
            : "../src/assets/ztoa.png"
        );
        break;

      case "category":
        if (sortingFilter.current.prev == "category") {
          sortingFilter.current.category = 1 - sortingFilter.current.category;
        }
        sortingFilter.current.prev = "category";
        setSortIcon("../src/assets/sort.png");
        break;

      case "id":
        if (sortingFilter.current.prev == "id") {
          sortingFilter.current.id = 1 - sortingFilter.current.id;
        }
        sortingFilter.current.prev = "id";
        setSortIcon(
          sortingFilter.current.id == 0
            ? "../src/assets/id_ascending.png"
            : "../src/assets/id_descending.png"
        );
        break;
    }
  }, [sortingMethod, tickUpdate]);

  const filteredMsgs = useMemo(() => {
    const base = [...txMessagesArray];

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
            a[0].localeCompare(b[0], undefined, { numeric: true })
          );
        } else {
          return base.sort((a, b) =>
            b[0].localeCompare(a[0], undefined, { numeric: true })
          );
        }
      }

      default:
        return base;
    }
  }, [txMessagesArray, sortingMethod, tickUpdate]);

  // View Mode (separate key from main dashboard so you don’t fight settings)
  // =====================================================================
  useEffect(() => {
    const saved = localStorage.getItem("txdash:viewMode");
    if (saved == "cards" || saved == "list") setViewMode(saved);
  }, []);

  useEffect(() => {
    localStorage.setItem("txdash:viewMode", viewMode);
  }, [viewMode]);

  return (
    <div className="grid grid-cols-3 gap-0 w-100 h-full">
      {/* Data display section */}
      <div className="col-span-2 relative flex flex-col h-full overflow-y-auto">
        <div className="flex-1 p-4 pb-16">
          {/* Header-ish module (reuse your existing top bar style) */}
          <div className="bg-data-module-bg w-full h-[100px] grid grid-cols-4 gap-1 rounded-md mb-[15px]">
            <div className="col-span-3 flex items-center px-4 text-white font-semibold">
              Outgoing CAN (TX)
            </div>

            <div className="col-span-1 flex items-center justify-end gap-1 p-3">
              <div className="flex flex-row">
                <button
                  onClick={() => setSortMenuOpen((o) => !o)}
                  className="w-[50px] h-[50px] p-[10px] !rounded-lg flex justify-center items-center cursor-pointer hover:bg-data-textbox-bg/50 transition-colors object-contain"
                >
                  <img src={sortIcon} />
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
                        className={`${
                          sortingMethod == "name" ? "font-bold" : "font-regular"
                        }`}
                      >
                        Name
                      </button>
                      <button
                        onClick={() => {
                          setSortingMethod("category");
                          setTickUpdate(Date.now());
                        }}
                        className={`${
                          sortingMethod == "category"
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
                        className={`${
                          sortingMethod == "id" ? "font-bold" : "font-regular"
                        }`}
                      >
                        ID
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <button
                onClick={() => setViewMode("list")}
                className="w-[50px] h-[50px] p-[10px] !rounded-lg flex justify-center items-center cursor-pointer hover:bg-data-textbox-bg/50 transition-colors object-contain"
                aria-pressed={viewMode === "list"}
              >
                <img src="../src/assets/list-view.png" />
              </button>

              <button
                onClick={() => setViewMode("cards")}
                className="w-[50px] h-[50px] p-[10px] !rounded-lg flex justify-center items-center cursor-pointer hover:bg-data-textbox-bg/50 transition-colors object-contain"
                aria-pressed={viewMode === "cards"}
              >
                <img src="../src/assets/grid-view.png" />
              </button>
            </div>
          </div>

          {viewMode === "cards" ? (
            <div className="columns-2 gap-4">
              {filteredMsgs.map(([canId, sample]) => {
                const data = Object.entries(sample.data).map(([key, value]) => ({
                  [key]: `${value.sensorReading} ${value.unit}`,
                }));

                return (
                  <div key={canId} className="mb-4 avoid-break">
                    <DataCard
                      key={canId}
                      msgID={canId}
                      name={sample.messageName}
                      data={
                        data.length > 0
                          ? data
                          : [{ "No Data": "Waiting for TX messages..." }]
                      }
                      lastUpdated={sample.timestamp}
                      rawData={sample.rawData}
                    />
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="w-100 h-fit rounded-sm bg-sidebar">
              <div className="w-100 h-[40px] rounded-t-sm grid grid-cols-12 bg-data-module-bg text-white font-semibold text-sm shadow-md">
                <div className="col-span-1 flex justify-left items-center ps-3">
                  <button
                    onClick={() => {
                      setSortingMethod("id");
                      setTickUpdate(Date.now());
                    }}
                  >
                    Msg ID
                  </button>
                </div>

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

                <div className="col-span-2 rounded-t-sm bg-data-textbox-bg flex justify-left items-center px-3">
                  <button
                    onClick={() => {
                      setSortingMethod("category");
                      setTickUpdate(Date.now());
                    }}
                  >
                    Category
                  </button>
                </div>

                <div className="col-span-4 flex justify-left items-center px-3">
                  Data
                </div>

                <div className="col-span-1 flex justify-left items-center ps-3">
                  Time
                </div>
              </div>

              {filteredMsgs.map(([canId, sample], i) => {
                const data = Object.entries(sample.data).map(([key, value]) => ({
                  [key]: `${value.sensorReading} ${value.unit}`,
                }));

                return (
                  <DataRow
                    key={canId}
                    msgID={canId}
                    name={sample.messageName}
                    data={
                      data.length > 0
                        ? data
                        : [{ "No Data": "Waiting for TX messages..." }]
                    }
                    lastUpdated={sample.timestamp}
                    rawData={sample.rawData}
                    index={i}
                  />
                );
              })}
            </div>
          )}
        </div>

        {/* Sticky Performance Tab */}
        <div className="sticky bottom-0 inset-x-0">
          <div className="w-full py-2 px-4 bg-data-textbox-bg/90 backdrop-blur text-gray-300 text-xs border-t border-white/10">
            <div className="flex justify-between items-center max-w-6xl mx-auto">
              <span>FPS: {performanceStats.fps}</span>
              <span>
                TX frames/sec: {filteredMsgs.length > 0 ? "Live" : "0"}
              </span>
              <span>
                Mem: {performanceStats.memoryUsage}
                {typeof performanceStats.memoryUsage === "number" ? "MB" : ""}
              </span>
              <span>
                Store: {dataStoreStats.totalMessages} msgs,{" "}
                {dataStoreStats.totalSamples} samples
              </span>
              <span>Store Mem: {dataStoreStats.memoryEstimateMB}MB</span>
            </div>
          </div>
        </div>
      </div>

      {/* Graph display section */}
      <div className="col-span-1 bg-sidebar">{/* WIP */}</div>
    </div>
  );
}

export default TxDashboard;
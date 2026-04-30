import { useState, useEffect } from "react";
import "./App.css";
import Sidebar from "./components/Sidebar";
import Hamburger from "./components/HamburgerMenu";
import SettingsModal from "./components/SettingsModal";
import { AuthModal } from "./components/AuthModal";
import {
  loadDBCFromCache,
  usingCachedDBC,
} from "./utils/canProcessor";
import { dataStore } from "./lib/DataStore";
import { coldStore } from "./lib/ColdStore";
import { Outlet, useLocation } from "react-router";
import { webSocketService } from "./services/WebSocketService";
import { telemetryHandler } from "./services/TelemetryHandler";
import { serialService } from "./services/SerialService";
import { DefaultBanner, CacheBanner, RecoveredSessionBanner } from "./components/AppBanners";
import FloatingTools from "./components/FloatingTools";
import { useRemoteConfig } from "./lib/useRemoteConfig";
import { updateCategories } from "./config/categories";
import { useTimeline } from "./context/TimelineContext";

function App() {
  const location = useLocation();
  const { clearCheckpoints } = useTimeline();
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);
  const [isAuthOpen, setIsAuthOpen] = useState<boolean>(false);

  const [displayCacheBanner, setDisplayCacheBanner] = useState<boolean>(false);
  const [displayDefaultBanner, setDisplayDefaultBanner] =
    useState<boolean>(true);
  const [displayRecoveredSessionBanner, setDisplayRecoveredSessionBanner] =
    useState<boolean>(() => dataStore.consumeRecoveredSnapshotNotice());

  const bannerApi = {
    showDefault: () => setDisplayDefaultBanner(true),
    showCache: () => setDisplayCacheBanner(true),
    hideDefault: () => setDisplayDefaultBanner(false),
    hideCache: () => setDisplayCacheBanner(false),
    toggleDefault: () => setDisplayDefaultBanner((o) => !o),
    toggleCache: () => setDisplayCacheBanner((o) => !o),
  };

  const { session, loadConfig } = useRemoteConfig();

  useEffect(() => {
    const savedTheme = localStorage.getItem("pecan:theme");
    if (savedTheme === "light") {
      document.body.classList.add("theme-light");
    } else if (savedTheme === "internal" || (!savedTheme && import.meta.env.VITE_INTERNAL)) {
      document.body.classList.add("theme-internal");
    }
  }, []);

  useEffect(() => {
    const fetchConfig = async () => {
      if (session?.user) {
        const cloudConfig = await loadConfig();
        if (cloudConfig?.categoryConfig) {
          updateCategories(cloudConfig.categoryConfig);
        }
      }
    };
    fetchConfig();
  }, [session, loadConfig]);

  const openSettings = () => setIsSettingsOpen(true);
  const closeSettings = () => setIsSettingsOpen(false);
  const openAuth = () => setIsAuthOpen(true);
  const closeAuth = () => setIsAuthOpen(false);
  const showAppBanners = location.pathname !== "/";

  const handleClearRecoveredSession = async () => {
    // Wipe cold store first so that getColdExtent() returns null by the time
    // dataStore notifications fire and TimelineContext re-reads bounds.
    await coldStore.clear().catch(console.warn);
    dataStore.clear();
    dataStore.setActiveSource("live");
    dataStore.clearPersistedSnapshot();
    dataStore.notifyBoundsRefresh();
    clearCheckpoints();
    localStorage.removeItem("dash:plots");
    window.location.reload();
  };

  useEffect(() => {
    (async () => {
      console.log("[App] Loading DBC from cache...");
      await loadDBCFromCache();
      const isUsingCache = usingCachedDBC();
      console.log("[App] Using cached DBC:", isUsingCache);

      if (isUsingCache) {
        setDisplayDefaultBanner(false);
        setDisplayCacheBanner(true);
        localStorage.setItem('dbc-cache-active', 'true');
      } else {
        const wasCacheActive = localStorage.getItem('dbc-cache-active') === 'true';
        if (wasCacheActive) {
          console.log("[App] Cache was previously active but not found now");
        }
        localStorage.removeItem('dbc-cache-active');
      }

      // Initialize WebSocket only after DBC is loaded so the CAN processor
      // is created with the correct DBC file.
      telemetryHandler.initialize();
      webSocketService.initialize();
    })();

    return () => {
      webSocketService.disconnect();
      serialService.disconnect();
    };
  }, []);

  return (
    <div className="h-screen flex flex-row overflow-y-auto">
      <div className={`h-screen transition-all duration-300 ease-in-out flex-shrink-0 ${isSidebarOpen ? 'lg:w-2/9 md:w-2/5 sm:w-3/5 w-full' : 'w-[60px]'}`}>
        {!isSidebarOpen && <Hamburger trigger={() => setIsSidebarOpen(true)} />}
        <Sidebar isOpen={isSidebarOpen} onClose={() => setIsSidebarOpen(false)} onOpenSettings={openSettings} onOpenAuth={openAuth} />
      </div>

      {/* Main content area, Outlet element is needed to display the rendered child pages received from the routes */}
      <main id="main-content" className="flex-1 h-full min-w-0">
        {showAppBanners && (
          <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex flex-col items-center gap-2 w-full pointer-events-none">
            <div className="pointer-events-auto w-full flex justify-center">
              <DefaultBanner
                open={displayDefaultBanner}
                onClose={() => setDisplayDefaultBanner(false)}
                onOpenSettings={openSettings}
              />
            </div>
            <div className="pointer-events-auto w-full flex justify-center">
              <CacheBanner
                open={displayCacheBanner}
                onClose={() => setDisplayCacheBanner(false)}
              />
            </div>
            <div className="pointer-events-auto w-full flex justify-center">
              <RecoveredSessionBanner
                open={displayRecoveredSessionBanner}
                onClose={() => setDisplayRecoveredSessionBanner(false)}
                onClearRecovered={handleClearRecoveredSession}
              />
            </div>
          </div>
        )}
        <Outlet context={{ isSidebarOpen, openSettings, ...bannerApi }} />
        <SettingsModal isOpen={isSettingsOpen} onClose={closeSettings} bannerApi={bannerApi} />
        <AuthModal isOpen={isAuthOpen} onClose={closeAuth} />
        <FloatingTools />
      </main>


    </div>
  );
}

export default App;

import { useState, useEffect } from "react";
import "./App.css";
import Sidebar from "./components/Sidebar";
import Hamburger from "./components/HamburgerMenu";
import SettingsModal from "./components/SettingsModal";
import {
  loadDBCFromCache,
  usingCachedDBC,
} from "./utils/canProcessor";
import { Outlet } from "react-router";
import { webSocketService } from "./services/WebSocketService";
import { DefaultBanner, CacheBanner } from "./components/Banners";

function App() {
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);

  const [displayCacheBanner, setDisplayCacheBanner] = useState<boolean>(false);
  const [displayDefaultBanner, setDisplayDefaultBanner] =
    useState<boolean>(true);

  const bannerApi = {
    showDefault: () => setDisplayDefaultBanner(true),
    showCache: () => setDisplayCacheBanner(true),
    hideDefault: () => setDisplayDefaultBanner(false),
    hideCache: () => setDisplayCacheBanner(false),
    toggleDefault: () => setDisplayDefaultBanner((o) => !o),
    toggleCache: () => setDisplayCacheBanner((o) => !o),
  };

  const openSettings = () => setIsSettingsOpen(true);
  const closeSettings = () => setIsSettingsOpen(false);

  useEffect(() => {
    (async () => {
      console.log("[App] Loading DBC from cache...");
      await loadDBCFromCache();
      const isUsingCache = usingCachedDBC();
      console.log("[App] Using cached DBC:", isUsingCache);

      if (isUsingCache) {
        setDisplayDefaultBanner(false);
        setDisplayCacheBanner(true);
        // Persist the state
        localStorage.setItem('dbc-cache-active', 'true');
      } else {
        // Check if we previously had cache active
        const wasCacheActive = localStorage.getItem('dbc-cache-active') === 'true';
        if (wasCacheActive) {
          console.log("[App] Cache was previously active but not found now");
        }
        localStorage.removeItem('dbc-cache-active');
      }
    })();
  }, []);

  // Initialize WebSocket service once when app loads
  useEffect(() => {
    webSocketService.initialize();

    // Cleanup on unmount
    return () => {
      webSocketService.disconnect();
    };
  }, []); // Empty dependency array = runs once on mount

  return (
    <div className="h-screen flex flex-row overflow-hidden">
      <div className={`h-screen transition-all duration-300 ease-in-out flex-shrink-0 ${isSidebarOpen ? 'lg:w-2/9 md:w-2/5 sm:w-3/5 w-full' : 'w-[60px]'}`}>
        {!isSidebarOpen && <Hamburger trigger={() => setIsSidebarOpen(true)} />}
        {isSidebarOpen && <Sidebar isOpen={isSidebarOpen} onClose={() => setIsSidebarOpen(false)} onOpenSettings={openSettings} />}
      </div>

      {/* Main content area, Outlet element is needed to display the rendered child pages received from the routes */}
      <main id="main-content" className="flex-1 h-full min-w-0">
        <DefaultBanner
          open={displayDefaultBanner}
          onClose={() => setDisplayDefaultBanner(false)}
          onOpenSettings={openSettings}
        />
        <CacheBanner
          open={displayCacheBanner}
          onClose={() => setDisplayCacheBanner(false)}
        />
        <Outlet context={{ isSidebarOpen, openSettings, ...bannerApi }} />
        <SettingsModal isOpen={isSettingsOpen} onClose={closeSettings} bannerApi={bannerApi} />
      </main>


    </div>
  );
}

export default App;

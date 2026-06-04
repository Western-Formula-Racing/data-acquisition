import logo from "../assets/logo.png";
import logoLight from "../assets/logo_light.png";
import settings from "../assets/settings.png";
import avatar from "../assets/avatar.png";
import SidebarOption from "./SidebarOption";
import { NavLink } from "react-router";
import { ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";
import { useTheme } from "next-themes";

function useThemeLogo() {
  const { theme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return logo;
  const active = resolvedTheme ?? theme;
  return active === "light" ? logoLight : logo;
}

interface InputProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenSettings: () => void;
  onOpenAuth: () => void;
}

function Sidebar({ onClose, isOpen, onOpenSettings, onOpenAuth }: Readonly<InputProps>) {
  const logoSrc = useThemeLogo();

  // Define the paths that belong to the Vehicle Control group
  const controlPaths = ["/throttle-mapper", "/sensor-validator", "/can-transmitter", "/tx"];
  
  // State to track if the Vehicle Control dropdown is open
  const [isControlOpen, setIsControlOpen] = useState(
    controlPaths.some(path => location.pathname === path)
  );

  useEffect(() => {
    if (controlPaths.some(path => location.pathname === path)) {
      setIsControlOpen(true);
    }
  }, [location.pathname]);

  const handleSettingsClick = () => {
    onClose();
    onOpenSettings();
  };

  const handleAuthClick = (e: React.MouseEvent) => {
    e.preventDefault();
    onClose();
    onOpenAuth();
  };

  return (
    <div>
      {/* Listener for outside of sidebar clicks */}
      {isOpen && (
        <button
          className="fixed inset-0 z-[79] hidden sm:block !cursor-default"
          onClick={onClose}
        ></button>
      )}

      <div
        className={`sidebar-scroll-none fixed top-0 left-0 bottom-12 lg:w-2/9 md:w-2/5 sm:w-3/5 w-full flex flex-col z-[80] transform transition-all duration-450 overflow-y-auto overscroll-contain ${isOpen
          ? "translate-x-0 opacity-100"
          : "-translate-x-full opacity-0 pointer-events-none"
          }`}
      >
        <div className="bg-sidebar z-100 w-[98%] h-full flex flex-col justify-between">
          <div>
            {/* When clicking the image the sidebar collapses, we'll see if we'll keep it that */}
            {/* NavLink for semantic purposes, clicking image goes home and closes sidebar */}
            <NavLink onClick={onClose} to={"/"}>
              <img className="my-10 cursor-pointer" src={logoSrc} alt="logo" />
            </NavLink>
            {/* Could create a global function to close the sidebar and use it in the component rather than passing onClose in every time */}
            <ul className="p-0">
              <SidebarOption
                option="DASHBOARD"
                path="/dashboard"
                onClose={onClose}
              />
              <SidebarOption
                option="CONSTELLATION"
                path="/constellation"
                onClose={onClose}
              />
              <SidebarOption
                option="CAN TRACE"
                path="/trace"
                onClose={onClose}
                isPending={true}
              />
              <SidebarOption
                option="ACCUMULATOR"
                path="/accumulator"
                onClose={onClose}
              />
              <SidebarOption
                option="CHARGECART"
                path="/chargecart"
                onClose={onClose}
                isPending={true}
              />
              <SidebarOption
                option="CUSTOM MONITOR"
                path="/monitor-builder"
                onClose={onClose}
              />
              <SidebarOption
                option="COMMS INTERFACE"
                path="/comms"
                onClose={onClose}
                isPending={true}
              />
              <li>
                <button
                  onClick={() => setIsControlOpen(!isControlOpen)}
                  className="sidebar-group-header flex w-full gap-3 h-20 items-center justify-between box-border px-3 transition-colors cursor-pointer bg-option hover:bg-option-select/80"
                >
                  <span className="flex items-center gap-2">
                    <span className="sidebar-group-title text-left">
                      Vehicle Control
                    </span>
                    <span className="text-xs bg-yellow-500/20 text-yellow-500 px-1.5 py-0.5 rounded border border-yellow-500/40 font-mono tracking-wider">
                      DEV
                    </span>
                  </span>
                  <ChevronDown className={`text-sidebarfg transition-transform duration-300 ${isControlOpen ? 'rotate-180' : ''}`} />
                </button>
                <div className={`overflow-hidden transition-all duration-300 ease-in-out ${isControlOpen ? 'max-h-64 opacity-100' : 'max-h-0 opacity-0'}`}>
                  <ul className="list-none p-0 m-0">
                    <SidebarOption
                      option="Throttle Mapper"
                      path="/throttle-mapper"
                      onClose={onClose}
                      nested
                      isPending={true}
                    />
                    <SidebarOption
                      option="Sensor Validator"
                      path="/sensor-validator"
                      onClose={onClose}
                      nested
                      isPending={true}
                    />
                    <SidebarOption
                      option="CAN Transmitter"
                      path="/can-transmitter"
                      onClose={onClose}
                      nested
                      isPending={true}
                    />
                  </ul>
                </div>
              </li>

            </ul>
          </div>

          <footer className="flex flex-col items-start pl-[10%] gap-10 mb-10">
            {/* Should go to /account*/}
            <button
              onClick={handleAuthClick}
              className="!no-underline text-md flex flex-row items-center gap-6 bg-transparent border-none cursor-pointer"
            >
              <img src={avatar} alt="avatar" width={30} height={30} />
              <span className="sidebar-footer-label">Account</span>
            </button>
            {/* Settings - opens modal */}
            <button
              onClick={handleSettingsClick}
              className="!no-underline flex flex-row items-center gap-6 text-md cursor-pointer bg-transparent border-none"
            >
              <img src={settings} alt="settings" width={30} height={30} />
              <span className="sidebar-footer-label">Settings</span>
            </button>
          </footer>
        </div>
      </div>
    </div>
  );
}

export default Sidebar;
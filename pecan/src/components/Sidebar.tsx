import banner from "../assets/banner.png";
import settings from "../assets/settings.png";
import avatar from "../assets/avatar.png";
import SidebarOption from "./SidebarOption";
import { NavLink } from "react-router";
import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";

interface InputProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenSettings: () => void;
  onOpenAuth: () => void;
}

function Sidebar({ onClose, isOpen, onOpenSettings, onOpenAuth }: Readonly<InputProps>) {

  // Define the paths that belong to the Vehicle Control group
  const controlPaths = ["/throttle-mapper", "/can-transmitter", "/tx"];
  
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
          className="fixed inset-0 z-50 hidden sm:block !cursor-default"
          onClick={onClose}
        ></button>
      )}

      <div
        className={`fixed top-0 left-0 h-full lg:w-2/9 md:w-2/5 sm:w-3/5 w-full flex flex-col z-50 transform transition-all duration-450 overflow-y-auto overscroll-contain ${isOpen
          ? "translate-x-0 opacity-100"
          : "-translate-x-full opacity-0 pointer-events-none"
          }`}
      >
        <div className="bg-sidebar z-100 w-[98%] h-full flex flex-col justify-between">
          <div>
            {/* When clicking the image the sidebar collapses, we'll see if we'll keep it that */}
            {/* NavLink for semantic purposes, clicking image goes home and closes sidebar */}
            <NavLink onClick={onClose} to={"/"}>
              <img className="my-10 cursor-pointer" src={banner} alt="banner" />
            </NavLink>
            {/* Could create a global function to close the sidebar and use it in the component rather than passing onClose in every time */}
            <ul className="p-0">
              <SidebarOption
                option="DASHBOARD"
                path="/dashboard"
                onClose={onClose}
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
                option="MONITOR BUILDER"
                path="/monitor-builder"
                onClose={onClose}
              />
              <SidebarOption
                option="COMMS"
                path="/comms"
                onClose={onClose}
                isPending={true}
              />
              <li>
                <button
                  onClick={() => setIsControlOpen(!isControlOpen)}
                  className="flex w-full gap-3 h-20 items-center justify-between box-border px-3 bg-option hover:bg-option-select/75 transition-colors border-none cursor-pointer"
                >
                  <span className="flex items-center gap-2">
                    <span className="text-sidebarfg text-3xl font-heading leading-6 scale-y-75 uppercase text-left">
                      Vehicle Control
                    </span>
                    <span className="text-xs bg-yellow-500/20 text-yellow-500 px-1.5 py-0.5 rounded border border-yellow-500/40 font-mono tracking-wider">
                      DEV
                    </span>
                  </span>
                  <ChevronDown className={`text-sidebarfg transition-transform duration-300 ${isControlOpen ? 'rotate-180' : ''}`} />
                </button>
                <div className={`overflow-hidden transition-all duration-300 ease-in-out ${isControlOpen ? 'max-h-64 opacity-100' : 'max-h-0 opacity-0'}`}>
                  <ul className="list-none p-0 m-0 bg-black/10">
                    <SidebarOption
                      option="Throttle Mapper"
                      path="/throttle-mapper"
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

          <footer className="font-footer flex flex-col items-start pl-[10%] gap-10 mb-10">
            {/* Should go to /account*/}
            <button
              onClick={handleAuthClick}
              className="!no-underline text-md flex flex-row items-center gap-6 bg-transparent border-none cursor-pointer"
            >
              <img src={avatar} alt="avatar" width={30} height={30} />
              <span className="text-sidebarfg">Account</span>
            </button>
            {/* Settings - opens modal */}
            <button
              onClick={handleSettingsClick}
              className="!no-underline flex flex-row items-center gap-6 text-md cursor-pointer bg-transparent border-none"
            >
              <img src={settings} alt="settings" width={30} height={30} />
              <span className="text-sidebarfg">Settings</span>
            </button>
          </footer>
        </div>
      </div>
    </div>
  );
}

export default Sidebar;
import banner from "../assets/banner.png";
import settings from "../assets/settings.png";
import avatar from "../assets/avatar.png";
import SidebarOption from "./SidebarOption";
import { NavLink } from "react-router";

interface InputProps {
  isOpen: boolean;
  onClose: () => void;
}

function Sidebar({ onClose, isOpen }: Readonly<InputProps>) {
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
                isPending={true}
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
                option="SYSTEM LINK"
                path="/system-link"
                onClose={onClose}
              />
              <SidebarOption
                option="COMMS"
                path="/comms"
                onClose={onClose}
              />
            </ul>
          </div>
          <footer className="font-footer flex flex-col space-y-8 mb-10">
            {/* Should go to /account*/}
            <NavLink
              to={"/account"}
              className="!no-underline text-md flex flex-row space-x-6 ml-4"
              onClick={onClose}
            >
              <img src={avatar} alt="avatar" width={30} height={30} />
              <span className="text-sidebarfg">Account</span>
            </NavLink>
            {/* Should go to /settings*/}
            <NavLink
              to={"/settings"}
              className="!no-underline flex flex-row space-x-6 text-md ml-4"
              onClick={onClose}
            >
              <img src={settings} alt="settings" width={30} height={30} />
              <span className="text-sidebarfg">Settings and Preferences</span>
            </NavLink>
          </footer>
        </div>
      </div>
    </div>
  );
}

export default Sidebar;
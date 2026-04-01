import { NavLink } from "react-router";

interface InputProps {
  option: string;
  path: string;
  onClose: () => void;
  isPending?: boolean;
  nested?: boolean;
}

function SidebarOption({
  option,
  path,
  onClose,
  isPending,
  nested
}: Readonly<InputProps>) {
  return (
    <li>
      <NavLink
        onClick={onClose}
        className={({ isActive }) =>
          `sidebar-nav-link flex gap-6 items-center box-border px-3 ${isActive
            ? "bg-option-select md:rounded-r-md md:mr-[-2%]"
            : "bg-option hover:bg-option-select/80 transition-colors duration-450"
          } ${nested ? "pl-10 h-15" : "h-20"}`
        }
        to={path}
      >
        <span className={nested ? "sidebar-nav-label-nested" : "sidebar-nav-label"}>
          {option}
        </span>
        {isPending && (
          <span className="text-xs bg-yellow-500/20 text-yellow-500 px-1.5 py-0.5 rounded border border-yellow-500/40 font-mono tracking-wider">
            DEV
          </span>
        )}
      </NavLink>
    </li>
  );
}

export default SidebarOption;

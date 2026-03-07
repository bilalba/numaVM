import { NavLink } from "react-router-dom";

const links = [
  { to: "/", label: "Overview" },
  { to: "/users", label: "Users" },
  { to: "/vms", label: "VMs" },
  { to: "/sessions", label: "Sessions" },
  { to: "/traffic", label: "Traffic" },
  { to: "/events", label: "Events" },
];

export function Sidebar() {
  return (
    <nav className="w-44 border-r border-neutral-200 bg-panel-sidebar p-3 flex flex-col gap-0.5">
      {links.map((link) => (
        <NavLink
          key={link.to}
          to={link.to}
          end={link.to === "/"}
          className={({ isActive }) =>
            `px-2.5 py-1.5 text-xs rounded transition-colors ${
              isActive
                ? "bg-neutral-900 text-white"
                : "text-neutral-600 hover:bg-neutral-100"
            }`
          }
        >
          {link.label}
        </NavLink>
      ))}
    </nav>
  );
}

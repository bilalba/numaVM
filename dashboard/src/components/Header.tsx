import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { useUser } from "./UserProvider";
import { ThemeToggle } from "./ThemeToggle";
import { useVMHeader } from "./VMHeaderContext";

function getLogoutUrl(): string {
  const apiUrl = import.meta.env.VITE_API_URL || "//api.localhost";
  if (apiUrl.includes("localhost")) {
    return "//localhost:4000/logout";
  }
  return apiUrl.replace(/\/\/api\./, "//auth.") + "/logout";
}

function Avatar({ user }: { user: { email: string; avatar_url?: string; name?: string } }) {
  if (user.avatar_url) {
    return (
      <img
        src={user.avatar_url}
        alt=""
        className="w-6 h-6 rounded-full"
      />
    );
  }
  const letter = (user.name || user.email)[0].toUpperCase();
  return (
    <div className="w-6 h-6 rounded-full bg-neutral-200 text-neutral-600 flex items-center justify-center text-[10px] font-medium">
      {letter}
    </div>
  );
}

const statusColors: Record<string, string> = {
  running: "bg-green-500",
  creating: "bg-yellow-500",
  stopped: "bg-neutral-400",
  error: "bg-red-500",
  snapshotted: "bg-blue-500",
  paused: "bg-blue-500",
};

export function Header() {
  const { user, loading } = useUser();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const isVMDetail = location.pathname.startsWith("/vm/");
  const { vm: vmHeader } = useVMHeader();

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <header className="flex items-center justify-between px-4 py-2 text-xs bg-background">
      {isVMDetail ? (
        <>
          <Link to="/" className="sm:hidden flex items-center gap-2 text-foreground min-w-0">
            <span className="text-base leading-none shrink-0">&larr;</span>
            {vmHeader && (
              <>
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusColors[vmHeader.status] || "bg-neutral-400"}`} />
                <span className="text-sm font-semibold truncate">{vmHeader.name}</span>
              </>
            )}
          </Link>
          <Link to="/" className="hidden sm:inline text-foreground hover:underline font-medium">NumaVM</Link>
        </>
      ) : (
        <Link to="/" className="text-foreground hover:underline font-medium">NumaVM</Link>
      )}
      <div className="flex items-center gap-2">
        {isVMDetail && vmHeader && (
          <div className="sm:hidden flex items-center gap-1.5 text-neutral-500">
            <span className="capitalize">{vmHeader.status}</span>
            <span>&middot;</span>
            <span>
              {vmHeader.memSizeMib >= 1024
                ? `${(vmHeader.memSizeMib / 1024).toFixed(vmHeader.memSizeMib % 1024 ? 2 : 0)} GB`
                : `${vmHeader.memSizeMib} MB`}
            </span>
            {vmHeader.status === "running" && vmHeader.role === "owner" && (
              <>
                <span>&middot;</span>
                <button
                  onClick={() => {
                    if (!window.confirm(`Pause "${vmHeader.name}"? The VM will be snapshotted and can be resumed later.`)) return;
                    navigate("/", { state: { pausingVmId: vmHeader.vmId, pausingVmName: vmHeader.name } });
                  }}
                  className="underline underline-offset-4 transition-opacity hover:opacity-60 cursor-pointer"
                >
                  Pause
                </button>
              </>
            )}
          </div>
        )}
        <ThemeToggle />
      {!loading && user && (
        <div ref={ref} className="relative">
          <button
            onClick={() => setOpen(!open)}
            className="flex items-center gap-2 text-neutral-500 hover:text-foreground cursor-pointer"
          >
            <span className="hidden sm:inline">{user.email}</span>
            <Avatar user={user} />
          </button>
          {open && (
            <div className="absolute right-0 top-full mt-1 w-48 bg-surface border border-neutral-200 rounded shadow-sm py-1 z-50">
              <div className="px-3 py-1.5 text-neutral-400 truncate border-b border-neutral-100 mb-1">
                {user.email}
              </div>
              <button
                onClick={() => { navigate("/plan"); setOpen(false); }}
                className="w-full text-left px-3 py-1.5 hover:bg-neutral-100 text-foreground cursor-pointer"
              >
                Plan
              </button>
              <button
                onClick={() => { navigate("/usage"); setOpen(false); }}
                className="w-full text-left px-3 py-1.5 hover:bg-neutral-100 text-foreground cursor-pointer"
              >
                Usage
              </button>
              <button
                onClick={() => { navigate("/settings"); setOpen(false); }}
                className="w-full text-left px-3 py-1.5 hover:bg-neutral-100 text-foreground cursor-pointer"
              >
                Settings
              </button>
              <div className="border-t border-neutral-100 mt-1 pt-1">
                <a
                  href={getLogoutUrl()}
                  className="block px-3 py-1.5 hover:bg-neutral-100 text-neutral-400 hover:text-neutral-600"
                >
                  Log out
                </a>
              </div>
            </div>
          )}
        </div>
      )}
      </div>
    </header>
  );
}

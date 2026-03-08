import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useUser } from "./UserProvider";
import { ThemeToggle } from "./ThemeToggle";

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

export function Header() {
  const { user, loading } = useUser();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

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
    <header className="flex items-center justify-between px-4 py-2 border-b border-neutral-200 text-xs bg-background">
      <Link to="/" className="text-foreground hover:underline font-medium">
        numavm
      </Link>
      <div className="flex items-center gap-2">
        <ThemeToggle />
      {!loading && user && (
        <div ref={ref} className="relative">
          <button
            onClick={() => setOpen(!open)}
            className="flex items-center gap-2 text-neutral-500 hover:text-neutral-700 cursor-pointer"
          >
            <span>{user.email}</span>
            <Avatar user={user} />
          </button>
          {open && (
            <div className="absolute right-0 top-full mt-1 w-48 bg-surface border border-neutral-200 rounded shadow-sm py-1 z-50">
              <div className="px-3 py-1.5 text-neutral-400 truncate border-b border-neutral-100 mb-1">
                {user.name || user.email}
              </div>
              <button
                onClick={() => { navigate("/plan"); setOpen(false); }}
                className="w-full text-left px-3 py-1.5 hover:bg-neutral-100 text-neutral-700 cursor-pointer"
              >
                Plan
              </button>
              <button
                onClick={() => { navigate("/settings"); setOpen(false); }}
                className="w-full text-left px-3 py-1.5 hover:bg-neutral-100 text-neutral-700 cursor-pointer"
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

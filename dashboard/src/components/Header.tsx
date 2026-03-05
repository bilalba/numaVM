import { Link } from "react-router-dom";
import { useUser } from "./UserProvider";

function getLogoutUrl(): string {
  const apiUrl = import.meta.env.VITE_API_URL || "//api.localhost";
  // localhost dev: auth is on port 4000
  if (apiUrl.includes("localhost")) {
    return "//localhost:4000/logout";
  }
  // production: replace "api." with "auth." in the domain
  return apiUrl.replace(/\/\/api\./, "//auth.") + "/logout";
}

export function Header() {
  const { user, loading } = useUser();

  return (
    <header className="flex items-center justify-between px-4 py-2 border-b border-neutral-200 text-xs">
      <Link to="/" className="text-neutral-900 hover:underline font-medium">
        deploymagi
      </Link>
      <div className="flex items-center gap-3 text-neutral-500">
        {!loading && user && (
          <>
            <span>{user.email}</span>
            <a href={getLogoutUrl()} className="text-neutral-400 hover:text-neutral-600 underline">
              Log out
            </a>
          </>
        )}
      </div>
    </header>
  );
}

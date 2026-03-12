import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, type User } from "../lib/api";

interface UserContextValue {
  user: User | null;
  loading: boolean;
}

const UserContext = createContext<UserContextValue>({ user: null, loading: true });

export function UserProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getUser()
      .then(setUser)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // Client-side auth redirect (replaces Caddy forward_auth redirect)
  useEffect(() => {
    if (!loading && !user) {
      const apiHost = import.meta.env.VITE_API_URL?.replace(/^\/\//, "") || "api.localhost";
      const authHost = apiHost.replace(/^api\./, "auth.");
      const protocol = window.location.protocol;
      window.location.href = `${protocol}//${authHost}/login?redirect=${encodeURIComponent(window.location.href)}`;
    }
  }, [loading, user]);

  return (
    <UserContext.Provider value={{ user, loading }}>
      {children}
    </UserContext.Provider>
  );
}

export function useUser() {
  return useContext(UserContext);
}

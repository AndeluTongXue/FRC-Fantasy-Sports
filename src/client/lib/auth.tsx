import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { User } from "../../shared/types";
import { api } from "./api";

interface AuthState {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  signup: (email: string, password: string, displayName: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Adopts a user the server just handed back (password reset signs you straight in). */
  adopt: (user: User) => void;
  /** Re-reads /auth/me — used after confirming an email, so the banner clears. */
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get<{ user: User }>("/auth/me")
      .then((data) => setUser(data.user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const data = await api.post<{ user: User }>("/auth/login", { email, password });
    setUser(data.user);
  }, []);

  const signup = useCallback(async (email: string, password: string, displayName: string) => {
    const data = await api.post<{ user: User }>("/auth/signup", { email, password, displayName });
    setUser(data.user);
  }, []);

  const logout = useCallback(async () => {
    await api.post("/auth/logout");
    setUser(null);
  }, []);

  const adopt = useCallback((next: User) => setUser(next), []);

  const refresh = useCallback(async () => {
    const data = await api.get<{ user: User }>("/auth/me").catch(() => null);
    setUser(data?.user ?? null);
  }, []);

  const value = useMemo(
    () => ({ user, loading, login, signup, logout, adopt, refresh }),
    [user, loading, login, signup, logout, adopt, refresh],
  );

  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}

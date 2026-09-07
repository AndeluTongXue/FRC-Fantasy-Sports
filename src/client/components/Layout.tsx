import { useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";

const linkBase = "px-3 py-2 rounded-md text-sm font-medium transition-colors";

/**
 * Shown until the address is confirmed. The gate it explains is narrow on purpose — creating
 * and joining leagues — so this stays informative rather than blocking the whole app.
 */
function UnverifiedBanner({ email, onRefresh }: { email: string; onRefresh: () => Promise<void> }) {
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState("");

  async function resend() {
    setState("sending");
    setError("");
    try {
      await api.post("/auth/resend-verification");
      setState("sent");
    } catch (caught) {
      setState("idle");
      setError(caught instanceof Error ? caught.message : "Could not send that email");
    }
  }

  return (
    <div className="border-b border-amber-200 bg-amber-50">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm text-amber-900">
        <span>
          Confirm <span className="font-medium">{email}</span> to create or join a league.
        </span>
        {state === "sent" ? (
          <span className="text-amber-800">Sent — check your inbox.</span>
        ) : (
          <button
            type="button"
            onClick={resend}
            disabled={state === "sending"}
            className="font-medium underline underline-offset-2 hover:text-amber-950 disabled:opacity-50"
          >
            {state === "sending" ? "Sending…" : "Resend the link"}
          </button>
        )}
        <button type="button" onClick={() => void onRefresh()} className="text-amber-700 hover:text-amber-950">
          Already confirmed? Recheck
        </button>
        {error && <span className="text-red-700">{error}</span>}
      </div>
    </div>
  );
}

export function Layout() {
  const { user, logout, refresh } = useAuth();
  const navigate = useNavigate();

  async function handleLogout() {
    await logout();
    navigate("/login");
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-edge bg-surface">
        <div className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-3">
          <NavLink to="/" className="mr-4 text-lg font-bold tracking-tight">
            <span className="text-sky-600">FRC</span> Fantasy
          </NavLink>

          <nav className="flex flex-1 gap-1">
            <NavLink
              to="/"
              end
              className={({ isActive }) =>
                `${linkBase} ${isActive ? "bg-cream text-slate-900" : "text-slate-600 hover:text-slate-900"}`
              }
            >
              My Leagues
            </NavLink>
            <NavLink
              to="/teams"
              className={({ isActive }) =>
                `${linkBase} ${isActive ? "bg-cream text-slate-900" : "text-slate-600 hover:text-slate-900"}`
              }
            >
              Teams
            </NavLink>
            <NavLink
              to="/events"
              className={({ isActive }) =>
                `${linkBase} ${isActive ? "bg-cream text-slate-900" : "text-slate-600 hover:text-slate-900"}`
              }
            >
              Events
            </NavLink>
            {user?.isAdmin && (
              <NavLink
                to="/admin"
                className={({ isActive }) =>
                  `${linkBase} ${isActive ? "bg-cream text-slate-900" : "text-slate-600 hover:text-slate-900"}`
                }
              >
                Admin
              </NavLink>
            )}
          </nav>

          <span className="hidden text-sm text-slate-600 sm:inline">{user?.displayName}</span>
          <button
            type="button"
            onClick={handleLogout}
            className="rounded-md px-3 py-2 text-sm text-slate-600 hover:text-slate-900"
          >
            Sign out
          </button>
        </div>
      </header>

      {user && !user.emailVerified && <UnverifiedBanner email={user.email} onRefresh={refresh} />}

      <main className="mx-auto max-w-6xl px-4 py-8">
        <Outlet />
      </main>
    </div>
  );
}

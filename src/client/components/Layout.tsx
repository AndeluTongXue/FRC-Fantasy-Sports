import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";

const linkBase = "px-3 py-2 rounded-md text-sm font-medium transition-colors";

export function Layout() {
  const { user, logout } = useAuth();
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

      <main className="mx-auto max-w-6xl px-4 py-8">
        <Outlet />
      </main>
    </div>
  );
}

import { Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { useAuth } from "./lib/auth";
import { Draft } from "./pages/Draft";
import { Events } from "./pages/Events";
import { League } from "./pages/League";
import { Leagues } from "./pages/Leagues";
import { Login } from "./pages/Login";
import { Signup } from "./pages/Signup";
import { Standings } from "./pages/Standings";
import { Teams } from "./pages/Teams";

export function App() {
  const { user, loading } = useAuth();

  if (loading) {
    return <p className="p-8 text-sm text-slate-400">Loading…</p>;
  }

  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Leagues />} />
        <Route path="/leagues/:leagueId" element={<League />} />
        <Route path="/leagues/:leagueId/draft" element={<Draft />} />
        <Route path="/leagues/:leagueId/standings" element={<Standings />} />
        <Route path="/teams" element={<Teams />} />
        <Route path="/events" element={<Events />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

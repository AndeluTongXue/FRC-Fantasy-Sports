import { Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { useAuth } from "./lib/auth";
import { Admin } from "./pages/Admin";
import { Draft } from "./pages/Draft";
import { Events } from "./pages/Events";
import { ForgotPassword } from "./pages/ForgotPassword";
import { League } from "./pages/League";
import { Leagues } from "./pages/Leagues";
import { Login } from "./pages/Login";
import { ResetPassword } from "./pages/ResetPassword";
import { Signup } from "./pages/Signup";
import { Standings } from "./pages/Standings";
import { Teams } from "./pages/Teams";
import { VerifyEmail } from "./pages/VerifyEmail";

export function App() {
  const { user, loading } = useAuth();

  if (loading) {
    return <p className="p-8 text-sm text-slate-600">Loading…</p>;
  }

  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/verify-email" element={<VerifyEmail />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      {/* Also reachable signed in: signup leaves you with a session, so the confirmation
          link usually opens in a tab that already has one. */}
      <Route path="/verify-email" element={<VerifyEmail />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route element={<Layout />}>
        <Route path="/" element={<Leagues />} />
        <Route path="/leagues/:leagueId" element={<League />} />
        <Route path="/leagues/:leagueId/draft" element={<Draft />} />
        <Route path="/leagues/:leagueId/standings" element={<Standings />} />
        <Route path="/teams" element={<Teams />} />
        <Route path="/events" element={<Events />} />
        {user.isAdmin && <Route path="/admin" element={<Admin />} />}
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

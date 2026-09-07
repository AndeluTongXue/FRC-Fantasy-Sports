import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import type { User } from "../../shared/types";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";

const inputClass =
  "w-full rounded-md border border-edge bg-surface-raised px-3 py-2 outline-none focus:border-sky-500";

export function ResetPassword() {
  const { adopt } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (password !== confirm) {
      setError("Those passwords don't match");
      return;
    }
    setPending(true);
    setError("");
    try {
      // Succeeding here signs you in — the server issued a fresh session and dropped every
      // other one the account had.
      const data = await api.post<{ user: User }>("/auth/reset-password", { token, password });
      adopt(data.user);
      navigate("/");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not reset your password");
    } finally {
      setPending(false);
    }
  }

  if (!token) {
    return (
      <div className="mx-auto mt-24 max-w-sm px-4">
        <h1 className="mb-1 text-2xl font-bold">Reset your password</h1>
        <p className="mt-6 rounded-lg border border-edge bg-surface p-6 text-sm text-slate-700">
          That link is missing its token. Open the link from your email again, or{" "}
          <Link to="/forgot-password" className="text-sky-600 hover:underline">
            request a new one
          </Link>
          .
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto mt-24 max-w-sm px-4">
      <h1 className="mb-1 text-2xl font-bold">Set a new password</h1>
      <p className="mb-6 text-sm text-slate-600">
        This signs you in and signs out every other device.
      </p>

      <form onSubmit={handleSubmit} className="space-y-4 rounded-lg border border-edge bg-surface p-6">
        <label className="block">
          <span className="mb-1 block text-sm text-slate-700">New password</span>
          <input
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className={inputClass}
          />
          <span className="mt-1 block text-xs text-slate-500">At least 8 characters.</span>
        </label>

        <label className="block">
          <span className="mb-1 block text-sm text-slate-700">Confirm password</span>
          <input
            type="password"
            required
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            className={inputClass}
          />
        </label>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <button
          type="submit"
          disabled={pending}
          className="w-full rounded-md bg-sky-600 px-3 py-2 font-medium text-white hover:bg-sky-700 disabled:opacity-50"
        >
          {pending ? "Saving…" : "Set password and sign in"}
        </button>
      </form>

      <p className="mt-4 text-center text-sm text-slate-600">
        <Link to="/forgot-password" className="text-sky-600 hover:underline">
          Request a new link
        </Link>
      </p>
    </div>
  );
}

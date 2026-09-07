import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { GoogleSignIn } from "../components/GoogleSignIn";
import { useAuth } from "../lib/auth";

export function Signup() {
  const { signup } = useAuth();
  const navigate = useNavigate();
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      await signup(email, password, displayName);
      navigate("/");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sign up failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mx-auto mt-24 max-w-sm px-4">
      <h1 className="mb-1 text-2xl font-bold">Create your account</h1>
      <p className="mb-6 text-sm text-slate-600">Then create a league or join one with an invite code.</p>

      <div className="rounded-lg border border-edge bg-surface p-6">
        <GoogleSignIn label="Sign up with Google" />

        <form onSubmit={handleSubmit} className="space-y-4">
          <label className="block">
            <span className="mb-1 block text-sm text-slate-700">Display name</span>
            <input
              required
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              className="w-full rounded-md border border-edge bg-surface-raised px-3 py-2 outline-none focus:border-sky-500"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-sm text-slate-700">Email</span>
            <input
              type="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="w-full rounded-md border border-edge bg-surface-raised px-3 py-2 outline-none focus:border-sky-500"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-sm text-slate-700">Password</span>
            <input
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="w-full rounded-md border border-edge bg-surface-raised px-3 py-2 outline-none focus:border-sky-500"
            />
            <span className="mt-1 block text-xs text-slate-500">At least 8 characters.</span>
          </label>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <button
            type="submit"
            disabled={pending}
            className="w-full rounded-md bg-sky-600 px-3 py-2 font-medium text-white hover:bg-sky-700 disabled:opacity-50"
          >
            {pending ? "Creating account…" : "Create account"}
          </button>
        </form>
      </div>

      <p className="mt-4 text-center text-sm text-slate-600">
        Already have an account?{" "}
        <Link to="/login" className="text-sky-600 hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}

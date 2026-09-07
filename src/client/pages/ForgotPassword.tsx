import { useState } from "react";
import { Link } from "react-router-dom";
import { useProviders } from "../lib/providers";
import { api } from "../lib/api";

const inputClass =
  "w-full rounded-md border border-edge bg-surface-raised px-3 py-2 outline-none focus:border-sky-500";

export function ForgotPassword() {
  const { passwordReset, google } = useProviders();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      await api.post("/auth/forgot-password", { email });
      setSent(true);
    } catch (caught) {
      // Only throttling gets here — the route answers the same way for known and unknown
      // addresses, so there's nothing to report about whether the account exists.
      setError(caught instanceof Error ? caught.message : "Could not send the reset email");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mx-auto mt-24 max-w-sm px-4">
      <h1 className="mb-1 text-2xl font-bold">Reset your password</h1>

      {!passwordReset ? (
        <div className="mt-6 rounded-lg border border-edge bg-surface p-6">
          <p className="text-sm text-slate-700">
            Password reset isn&rsquo;t available on this deployment &mdash; it has no email provider
            configured, so a reset link can&rsquo;t be sent.
          </p>
          {google && (
            <p className="mt-3 text-sm text-slate-600">
              If you signed up with Google, use <span className="font-medium">Continue with Google</span> on
              the sign-in page instead.
            </p>
          )}
        </div>
      ) : sent ? (
        <div className="mt-6 rounded-lg border border-edge bg-surface p-6">
          <p className="text-sm text-slate-700">
            If <span className="font-medium">{email}</span> has an account, a reset link is on its way. The
            link is good for one hour.
          </p>
          <p className="mt-3 text-sm text-slate-600">Check your spam folder if it doesn&rsquo;t show up.</p>
        </div>
      ) : (
        <>
          <p className="mb-6 text-sm text-slate-600">
            Enter your email and we&rsquo;ll send you a link to set a new password.
          </p>

          <form onSubmit={handleSubmit} className="space-y-4 rounded-lg border border-edge bg-surface p-6">
            <label className="block">
              <span className="mb-1 block text-sm text-slate-700">Email</span>
              <input
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className={inputClass}
              />
            </label>

            {error && <p className="text-sm text-red-600">{error}</p>}

            <button
              type="submit"
              disabled={pending}
              className="w-full rounded-md bg-sky-600 px-3 py-2 font-medium text-white hover:bg-sky-700 disabled:opacity-50"
            >
              {pending ? "Sending…" : "Send reset link"}
            </button>
          </form>
        </>
      )}

      <p className="mt-4 text-center text-sm text-slate-600">
        <Link to="/login" className="text-sky-600 hover:underline">
          Back to sign in
        </Link>
      </p>
    </div>
  );
}

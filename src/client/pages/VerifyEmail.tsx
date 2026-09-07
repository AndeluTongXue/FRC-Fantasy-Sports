import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";

type Status = "working" | "confirmed" | "failed";

export function VerifyEmail() {
  const { user, refresh } = useAuth();
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";

  const [status, setStatus] = useState<Status>(token ? "working" : "failed");
  const [error, setError] = useState(token ? "" : "That confirmation link is missing its token.");

  // Tokens are single-use, so the effect must fire exactly once per token — StrictMode runs
  // effects twice in development, and the second run would redeem an already-spent token and
  // report a perfectly good link as expired.
  const redeemed = useRef("");

  useEffect(() => {
    if (!token || redeemed.current === token) return;
    redeemed.current = token;

    api
      .post("/auth/verify-email", { token })
      .then(async () => {
        setStatus("confirmed");
        // Clears the banner for a session that was already open in this tab.
        await refresh();
      })
      .catch((caught: unknown) => {
        setStatus("failed");
        setError(caught instanceof Error ? caught.message : "That confirmation link didn't work.");
      });
  }, [token, refresh]);

  return (
    <div className="mx-auto mt-24 max-w-sm px-4">
      <h1 className="mb-6 text-2xl font-bold">Confirm your email</h1>

      <div className="rounded-lg border border-edge bg-surface p-6">
        {status === "working" && <p className="text-sm text-slate-600">Confirming…</p>}

        {status === "confirmed" && (
          <>
            <p className="text-sm font-medium text-emerald-700">Your email is confirmed.</p>
            <p className="mt-2 text-sm text-slate-600">You can now create and join leagues.</p>
          </>
        )}

        {status === "failed" && (
          <>
            <p className="text-sm text-red-600">{error}</p>
            <p className="mt-2 text-sm text-slate-600">
              {user
                ? "Use the resend button in the banner at the top of the page to get a fresh link."
                : "Sign in, then use the resend button in the banner at the top of the page."}
            </p>
          </>
        )}
      </div>

      <p className="mt-4 text-center text-sm text-slate-600">
        <Link to={user ? "/" : "/login"} className="text-sky-600 hover:underline">
          {user ? "Go to my leagues" : "Sign in"}
        </Link>
      </p>
    </div>
  );
}

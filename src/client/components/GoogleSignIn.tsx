import { useProviders } from "../lib/providers";

/**
 * Renders nothing until it knows an OAuth client is configured, so a deploy without one
 * doesn't show a button that can only 404.
 *
 * A plain link, not a fetch: the browser has to leave for accounts.google.com and come back,
 * which XHR can't do.
 */
export function GoogleSignIn({ label }: { label: string }) {
  const { google } = useProviders();

  if (!google) return null;

  return (
    <div className="mb-4">
      <a
        href="/api/auth/google/start"
        className="flex w-full items-center justify-center gap-2 rounded-md border border-edge bg-surface px-3 py-2 font-medium text-slate-700 hover:bg-surface-raised"
      >
        <svg viewBox="0 0 18 18" aria-hidden="true" className="h-4 w-4">
          <path
            fill="#4285F4"
            d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z"
          />
          <path
            fill="#34A853"
            d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z"
          />
          <path
            fill="#FBBC05"
            d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z"
          />
          <path
            fill="#EA4335"
            d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z"
          />
        </svg>
        {label}
      </a>

      <div className="mt-4 flex items-center gap-3">
        <span className="h-px flex-1 bg-edge" />
        <span className="text-xs uppercase tracking-wide text-slate-500">or</span>
        <span className="h-px flex-1 bg-edge" />
      </div>
    </div>
  );
}

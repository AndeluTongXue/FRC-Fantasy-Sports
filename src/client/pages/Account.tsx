import { useState } from "react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { User } from "../../shared/types";

export function Account() {
  const { user, adopt } = useAuth();
  const [displayName, setDisplayName] = useState(user?.displayName ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const data = await api.patch<{ user: User }>("/auth/display-name", { displayName });
      adopt(data.user);
      setSaved(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update your display name");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-sm">
      <h1 className="mb-6 text-xl font-semibold">Account</h1>

      <form onSubmit={handleSubmit} className="space-y-4 rounded-lg border border-edge bg-surface p-6">
        <label className="block">
          <span className="mb-1 block text-sm text-slate-700">Display name</span>
          <input
            required
            value={displayName}
            onChange={(event) => {
              setDisplayName(event.target.value);
              setSaved(false);
            }}
            minLength={2}
            maxLength={60}
            className="w-full rounded-md border border-edge bg-surface-raised px-3 py-2 outline-none focus:border-sky-500"
          />
          <span className="mt-1 block text-xs text-slate-500">
            This is what other owners see in your leagues.
          </span>
        </label>

        {error && <p className="text-sm text-red-600">{error}</p>}
        {saved && <p className="text-sm text-emerald-700">Saved.</p>}

        <button
          type="submit"
          disabled={saving || displayName.trim() === user?.displayName}
          className="rounded-md bg-sky-600 px-3 py-2 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </form>

      <div className="mt-4 rounded-lg border border-edge bg-surface p-6 text-sm text-slate-600">
        <span className="block text-slate-500">Email</span>
        <span className="text-slate-900">{user?.email}</span>
      </div>
    </div>
  );
}

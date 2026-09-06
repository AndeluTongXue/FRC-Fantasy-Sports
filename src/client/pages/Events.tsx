import { useEffect, useState } from "react";
import type { FrcEvent } from "../../shared/types";
import { api } from "../lib/api";

export function Events() {
  const [events, setEvents] = useState<FrcEvent[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => {
      setLoading(true);
      api
        .get<{ events: FrcEvent[] }>(`/events?search=${encodeURIComponent(search)}`)
        .then((data) => setEvents(data.events))
        .catch((caught) => setError(caught instanceof Error ? caught.message : "Failed to load events"))
        .finally(() => setLoading(false));
    }, 200);
    return () => clearTimeout(timer);
  }, [search]);

  async function syncEvents() {
    setSyncing(true);
    setError("");
    try {
      await api.post("/admin/sync/events");
      const data = await api.get<{ events: FrcEvent[] }>("/events");
      setEvents(data.events);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Events</h1>
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search events…"
          className="flex-1 rounded-md border border-edge bg-surface px-3 py-2 text-sm outline-none focus:border-sky-500 sm:max-w-xs"
        />
        <button
          type="button"
          onClick={syncEvents}
          disabled={syncing}
          className="rounded-md border border-edge bg-surface px-3 py-2 text-sm hover:border-sky-500 disabled:opacity-50"
        >
          {syncing ? "Syncing…" : "Sync from TBA"}
        </button>
      </div>

      {error && <p className="mb-4 text-sm text-red-400">{error}</p>}

      {loading ? (
        <p className="text-sm text-slate-400">Loading…</p>
      ) : events.length === 0 ? (
        <div className="rounded-lg border border-edge bg-surface p-8 text-center">
          <p className="mb-2 text-slate-300">No events cached yet.</p>
          <p className="text-sm text-slate-500">
            Hit “Sync from TBA” to pull this season's event schedule.
          </p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {events.map((event) => (
            <div key={event.eventKey} className="rounded-lg border border-edge bg-surface p-4">
              <div className="flex items-start justify-between gap-2">
                <h2 className="font-medium">{event.shortName || event.name}</h2>
                {event.week !== null && (
                  <span className="shrink-0 rounded bg-surface-raised px-2 py-0.5 text-xs text-slate-400">
                    Week {event.week + 1}
                  </span>
                )}
              </div>
              <p className="mt-1 text-sm text-slate-400">
                {[event.city, event.stateProv, event.country].filter(Boolean).join(", ")}
              </p>
              <p className="mt-2 font-mono text-xs text-slate-500">
                {event.eventKey} · {event.startDate}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

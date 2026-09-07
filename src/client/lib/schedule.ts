/** Converts an epoch-ms timestamp to a `<input type="datetime-local">` value in local time. */
export function toLocalInputValue(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A sane `min` for the scheduling input — a little slack past the server's own one-minute
 * floor (see MIN_SCHEDULE_LEAD_MS in server/routes/leagues.ts) so the value doesn't go
 * stale by the time the request lands. */
export function earliestScheduleInputValue(): string {
  return toLocalInputValue(Date.now() + 2 * 60 * 1000);
}

export function formatScheduledDraft(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Formats a countdown in seconds as the coarsest unit that's still informative. */
export function formatDuration(totalSeconds: number): string {
  if (totalSeconds <= 0) return "any moment now";
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

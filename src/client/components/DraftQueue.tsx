import { useEffect, useRef, useState } from "react";

export interface QueueTeam {
  teamKey: string;
  teamNumber: number;
  nickname: string | null;
  price: number;
  epa: number | null;
}

interface Props {
  teams: QueueTeam[];
  /** Budget headroom for the manager's next pick, mirroring the server's reserve guard.
   * Entries above it aren't removed — a queue written pre-draft can't know what the budget
   * will look like later, and autopick skips what it can't afford rather than stopping. */
  maxSpend: number;
  /** True once the draft is over, when a queue no longer does anything. */
  locked: boolean;
  onReorder: (teams: QueueTeam[]) => void;
  onRemove: (teamKey: string) => void;
}

function move<T>(items: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= items.length || to < 0 || to >= items.length) return items;
  const next = [...items];
  const [entry] = next.splice(from, 1);
  next.splice(to, 0, entry);
  return next;
}

/**
 * The manager's own autopick order.
 *
 * Dragging is built on Pointer Events rather than the HTML5 drag-and-drop API, which never
 * fires on touch — this list gets reordered on a phone at a competition, and a desktop-only
 * implementation would look fine and do nothing there. The ↑/↓ buttons stay regardless: they
 * are the keyboard path, and a precise fallback when a drag target is small.
 */
export function DraftQueue({ teams, maxSpend, locked, onReorder, onRemove }: Props) {
  const listRef = useRef<HTMLOListElement>(null);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);

  // A ref alongside the state: the window listeners below need the live value, and reading it
  // through a state updater would mean calling onReorder from inside one — which React is
  // free to run twice, saving the queue twice.
  const dragRef = useRef<{ from: number; to: number } | null>(null);
  const latest = useRef({ teams, onReorder });
  latest.current = { teams, onReorder };

  function updateDrag(next: { from: number; to: number } | null) {
    dragRef.current = next;
    setDrag(next);
  }

  // While dragging, the list renders in its would-be order, so the row follows the cursor.
  const shown = drag ? move(teams, drag.from, drag.to) : teams;

  /** Which slot the pointer is over, measured against the rows as currently rendered. */
  function slotAt(clientY: number): number {
    const rows = [...(listRef.current?.querySelectorAll("li") ?? [])];
    for (let index = 0; index < rows.length; index++) {
      const box = rows[index].getBoundingClientRect();
      if (clientY < box.top + box.height / 2) return index;
    }
    return Math.max(rows.length - 1, 0);
  }

  const dragging = drag !== null;

  /**
   * Tracking on `window` rather than on the drag handle. Bound to the handle, a release that
   * lands anywhere else — outside the list, outside the window, or after the browser quietly
   * drops pointer capture — never arrives, and the drag stays stuck to the cursor until the
   * next click happens to end it.
   */
  useEffect(() => {
    if (!dragging) return;

    function onMove(event: PointerEvent) {
      const current = dragRef.current;
      if (!current) return;
      const to = slotAt(event.clientY);
      if (to !== current.to) updateDrag({ ...current, to });
    }

    function commit() {
      const current = dragRef.current;
      updateDrag(null);
      if (!current) return;
      const { from, to } = current;
      const { teams: live, onReorder: save } = latest.current;
      // The list can shrink mid-drag — another manager drafting a queued team removes it —
      // so only commit while both indices still address the list we started from.
      if (from !== to && from < live.length && to < live.length) save(move(live, from, to));
    }

    function cancel() {
      updateDrag(null);
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") cancel();
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", commit);
    window.addEventListener("pointercancel", cancel);
    // Losing the window mid-drag (alt-tab, a dialog) should drop it rather than leave it live.
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", commit);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", onKeyDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- resubscribing per move would
    // churn listeners; the handlers read live values through refs instead.
  }, [dragging]);

  function startDrag(event: React.PointerEvent, from: number) {
    if (locked) return;
    event.preventDefault();
    updateDrag({ from, to: from });
  }

  return (
    <div className="mb-6">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="font-medium">My queue</h2>
        {teams.length > 0 && <span className="text-xs text-slate-500">{teams.length} queued</span>}
      </div>

      {teams.length === 0 ? (
        <p className="rounded-lg border border-dashed border-edge px-3 py-4 text-xs text-slate-500">
          Queue teams from the list and they'll be drafted for you, in this order, if your clock runs
          out. Without a queue, an expired clock takes the best team you can afford.
        </p>
      ) : (
        <ol
          ref={listRef}
          className={`divide-y divide-edge overflow-hidden rounded-lg border border-edge bg-surface ${
            drag ? "select-none" : ""
          }`}
        >
          {shown.map((team, index) => {
            const tooExpensive = team.price > maxSpend;
            const dragging = drag !== null && index === drag.to;
            return (
              <li
                key={team.teamKey}
                className={`flex items-center gap-2 px-2 py-1.5 text-sm ${
                  dragging ? "bg-sky-50 ring-1 ring-inset ring-sky-400" : ""
                }`}
              >
                {locked ? (
                  <span className="w-4 text-right text-xs text-slate-400">{index + 1}</span>
                ) : (
                  <span
                    role="button"
                    tabIndex={-1}
                    aria-label={`Drag ${team.teamNumber} to reorder`}
                    onPointerDown={(event) => startDrag(event, index)}
                    // touch-none stops the browser scrolling the page instead of dragging.
                    className="flex cursor-grab touch-none items-center gap-1 text-slate-300 hover:text-slate-500 active:cursor-grabbing"
                  >
                    <svg viewBox="0 0 10 16" aria-hidden="true" className="h-3.5 w-2.5 fill-current">
                      <circle cx="2" cy="3" r="1.3" />
                      <circle cx="8" cy="3" r="1.3" />
                      <circle cx="2" cy="8" r="1.3" />
                      <circle cx="8" cy="8" r="1.3" />
                      <circle cx="2" cy="13" r="1.3" />
                      <circle cx="8" cy="13" r="1.3" />
                    </svg>
                    <span className="w-3 text-right text-xs text-slate-400">{index + 1}</span>
                  </span>
                )}

                <span className="font-mono font-semibold text-sky-600">{team.teamNumber}</span>
                <span className="flex-1 truncate text-xs text-slate-600">{team.nickname}</span>
                <span
                  className={`font-mono text-xs ${tooExpensive ? "text-amber-600" : "text-slate-600"}`}
                  title={tooExpensive ? "Over your budget right now — autopick will skip it" : undefined}
                >
                  ${team.price}
                </span>

                {!locked && (
                  <span className="flex items-center">
                    <button
                      type="button"
                      aria-label={`Move ${team.teamNumber} up`}
                      disabled={index === 0 || drag !== null}
                      onClick={() => onReorder(move(teams, index, index - 1))}
                      className="px-1 text-slate-400 hover:text-slate-700 disabled:opacity-30"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      aria-label={`Move ${team.teamNumber} down`}
                      disabled={index === teams.length - 1 || drag !== null}
                      onClick={() => onReorder(move(teams, index, index + 1))}
                      className="px-1 text-slate-400 hover:text-slate-700 disabled:opacity-30"
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      aria-label={`Remove ${team.teamNumber} from queue`}
                      disabled={drag !== null}
                      onClick={() => onRemove(team.teamKey)}
                      className="px-1 text-slate-400 hover:text-red-600 disabled:opacity-30"
                    >
                      ✕
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

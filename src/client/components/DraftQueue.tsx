import { useRef, useState } from "react";

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

  // While dragging, the list renders in its would-be order, so the row follows the finger.
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

  function startDrag(event: React.PointerEvent, from: number) {
    if (locked) return;
    event.preventDefault();
    setDrag({ from, to: from });

    // Capturing keeps move/up arriving here once the pointer leaves the handle, and on touch
    // stops the browser reading the gesture as a scroll. It's an enhancement though, not a
    // precondition — it throws if the pointer is already gone by the time this runs, and
    // letting that escape would kill the drag before it started.
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Without capture the drag still tracks while the pointer stays over the list.
    }
  }

  function onDragMove(event: React.PointerEvent) {
    if (!drag) return;
    const to = slotAt(event.clientY);
    if (to !== drag.to) setDrag({ ...drag, to });
  }

  function endDrag() {
    if (!drag) return;
    const { from, to } = drag;
    setDrag(null);
    // The list can shrink mid-drag — another manager drafting a queued team removes it — so
    // only commit while both indices still address the list we started from.
    if (from !== to && from < teams.length && to < teams.length) onReorder(move(teams, from, to));
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
                    onPointerMove={onDragMove}
                    onPointerUp={endDrag}
                    onPointerCancel={endDrag}
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

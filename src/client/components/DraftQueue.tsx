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

function move(teams: QueueTeam[], from: number, to: number): QueueTeam[] {
  if (to < 0 || to >= teams.length) return teams;
  const next = [...teams];
  const [entry] = next.splice(from, 1);
  next.splice(to, 0, entry);
  return next;
}

/**
 * The manager's own autopick order. Up/down rather than drag-and-drop deliberately: this
 * gets used on a phone at a competition, where a drag target a few pixels wide is a good
 * way to lose a pick.
 */
export function DraftQueue({ teams, maxSpend, locked, onReorder, onRemove }: Props) {
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
        <ol className="divide-y divide-edge overflow-hidden rounded-lg border border-edge bg-surface">
          {teams.map((team, index) => {
            const tooExpensive = team.price > maxSpend;
            return (
              <li key={team.teamKey} className="flex items-center gap-2 px-2 py-1.5 text-sm">
                <span className="w-4 text-right text-xs text-slate-400">{index + 1}</span>
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
                      disabled={index === 0}
                      onClick={() => onReorder(move(teams, index, index - 1))}
                      className="px-1 text-slate-400 hover:text-slate-700 disabled:opacity-30"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      aria-label={`Move ${team.teamNumber} down`}
                      disabled={index === teams.length - 1}
                      onClick={() => onReorder(move(teams, index, index + 1))}
                      className="px-1 text-slate-400 hover:text-slate-700 disabled:opacity-30"
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      aria-label={`Remove ${team.teamNumber} from queue`}
                      onClick={() => onRemove(team.teamKey)}
                      className="px-1 text-slate-400 hover:text-red-600"
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

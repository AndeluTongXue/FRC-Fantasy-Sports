import { useEffect, useMemo, useRef, useState } from "react";
import type { FrcEvent } from "../../shared/types";

interface Props {
  events: FrcEvent[];
  value: string;
  onChange: (eventKey: string) => void;
}

/** How many matches to render at once. Typing narrows faster than scrolling does. */
const MAX_VISIBLE = 40;

/** The line under an event's name: where and when it is, and whether it's an offseason or
 * championship event — which changes how its teams are priced, so it's worth showing. */
function subtitle(event: FrcEvent): string {
  const place = [event.city, event.stateProv ?? event.country].filter(Boolean).join(", ");
  const when = event.week !== null ? `Week ${event.week}` : (event.eventTypeString ?? "");
  return [event.eventKey, when, place].filter(Boolean).join(" · ");
}

function matches(event: FrcEvent, query: string): boolean {
  if (!query) return true;
  // Location included deliberately: people look for "the one in Sacramento" as often as they
  // remember an event's official name.
  const haystack = [
    event.name,
    event.shortName,
    event.eventKey,
    event.city,
    event.stateProv,
    event.country,
    event.eventTypeString,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => haystack.includes(term));
}

/**
 * A search box over the season's events, replacing a `<select>` that held 317 of them — a
 * list you can only get through by scrolling, and only if you already know the official name.
 *
 * Filtering is client-side: the whole year is already loaded, 300-odd rows is nothing to
 * scan, and doing it locally means results appear as you type with no request per keystroke.
 */
export function EventPicker({ events, value, onChange }: Props) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const selected = events.find((event) => event.eventKey === value) ?? null;
  const filtered = useMemo(() => events.filter((event) => matches(event, query)), [events, query]);
  const visible = filtered.slice(0, MAX_VISIBLE);

  // A stale highlight can point past the end of a list the query just shortened.
  useEffect(() => setHighlight(0), [query]);

  // Keep the highlighted row in view when arrowing past the edge of the scroll box.
  useEffect(() => {
    listRef.current?.querySelectorAll("li")[highlight]?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  function choose(event: FrcEvent) {
    onChange(event.eventKey);
    setQuery("");
    setOpen(false);
  }

  function onKeyDown(keyEvent: React.KeyboardEvent) {
    if (keyEvent.key === "ArrowDown" || keyEvent.key === "ArrowUp") {
      keyEvent.preventDefault();
      if (!open) return setOpen(true);
      const step = keyEvent.key === "ArrowDown" ? 1 : -1;
      setHighlight((current) => Math.min(Math.max(current + step, 0), visible.length - 1));
    } else if (keyEvent.key === "Enter") {
      // Only swallow Enter when it's choosing something; otherwise it should submit the form.
      if (open && visible[highlight]) {
        keyEvent.preventDefault();
        choose(visible[highlight]);
      }
    } else if (keyEvent.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div ref={containerRef} className="relative">
      {selected && !open ? (
        <div className="flex items-center gap-2 rounded-md border border-edge bg-surface-raised px-3 py-2">
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm">{selected.name}</span>
            <span className="block truncate text-xs text-slate-500">{subtitle(selected)}</span>
          </span>
          <button
            type="button"
            onClick={() => {
              onChange("");
              setQuery("");
              setOpen(true);
            }}
            className="shrink-0 text-xs text-sky-600 hover:underline"
          >
            Change
          </button>
        </div>
      ) : (
        <input
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          autoComplete="off"
          value={query}
          placeholder="Search by name, code, or place…"
          onChange={(changeEvent) => {
            setQuery(changeEvent.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          // Only closes when focus actually leaves the picker. Closing on any blur raced the
          // option's own click: the blur unmounted the list, so the click had no row left to
          // land on and the selection was silently dropped.
          onBlur={(blurEvent) => {
            if (!containerRef.current?.contains(blurEvent.relatedTarget as Node | null)) setOpen(false);
          }}
          onKeyDown={onKeyDown}
          className="w-full rounded-md border border-edge bg-surface-raised px-3 py-2 outline-none focus:border-sky-500"
        />
      )}

      {open && (
        <ul
          ref={listRef}
          role="listbox"
          // Keeps focus in the input so the list survives the press; the row's own mousedown
          // is what actually selects.
          onMouseDown={(mouseEvent) => mouseEvent.preventDefault()}
          className="absolute z-10 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-edge bg-surface shadow-lg"
        >
          {visible.length === 0 && (
            <li className="px-3 py-3 text-sm text-slate-500">No events match “{query}”.</li>
          )}
          {visible.map((event, index) => (
            <li
              key={event.eventKey}
              role="option"
              aria-selected={event.eventKey === value}
              onMouseEnter={() => setHighlight(index)}
              // mousedown, not click: a real press moves focus out of the input, and closing
              // on that blur used to unmount this row before its click could ever fire.
              onMouseDown={(mouseEvent) => {
                mouseEvent.preventDefault();
                choose(event);
              }}
              className={`cursor-pointer px-3 py-2 ${index === highlight ? "bg-cream" : ""}`}
            >
              <span className="block truncate text-sm">{event.name}</span>
              <span className="block truncate text-xs text-slate-500">{subtitle(event)}</span>
            </li>
          ))}
          {filtered.length > visible.length && (
            <li className="px-3 py-2 text-xs text-slate-500">
              {filtered.length - visible.length} more — keep typing to narrow it down.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import type { DraftClientMessage, DraftServerMessage, DraftState } from "../../shared/types";

/** Fires a browser notification, but only when the tab isn't the one the user is looking at. */
function notify(title: string, body: string) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  if (document.visibilityState === "visible" && document.hasFocus()) return;
  try {
    new Notification(title, { body, tag: "frc-fantasy-draft" });
  } catch {
    // Some mobile browsers require a service worker registration for Notification; skip silently.
  }
}

export function useDraft(leagueId: string, userId: string | null) {
  const [state, setState] = useState<DraftState | null>(null);
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
  }, []);

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;
    let previous: DraftState | null = null;

    function open() {
      const protocol = location.protocol === "https:" ? "wss" : "ws";
      const socket = new WebSocket(`${protocol}://${location.host}/api/leagues/${leagueId}/draft/ws`);
      socketRef.current = socket;

      socket.onopen = () => setConnected(true);
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data as string) as DraftServerMessage;
        if (message.type === "state") {
          const next = message.state;
          if (previous) {
            if (previous.status !== "active" && next.status === "active") {
              notify("Draft started", "The draft is underway — head to the draft room.");
            }
            const wasMyTurn = previous.status === "active" && previous.currentUserId === userId;
            const isMyTurn = next.status === "active" && next.currentUserId === userId;
            if (isMyTurn && !wasMyTurn) {
              notify("You're on the clock", "It's your turn to draft.");
            }
          }
          previous = next;
          setState(next);
        } else {
          setError(message.message);
        }
      };
      socket.onclose = () => {
        setConnected(false);
        if (!closed) retry = setTimeout(open, 2000);
      };
    }

    open();
    return () => {
      closed = true;
      clearTimeout(retry);
      socketRef.current?.close();
    };
  }, [leagueId, userId]);

  const send = useCallback((message: DraftClientMessage) => {
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) {
      setError("Lost the draft connection — reconnecting, try again in a moment.");
      return;
    }
    setError("");
    socket.send(JSON.stringify(message));
  }, []);

  return {
    state,
    error,
    connected,
    start: useCallback(() => send({ type: "start" }), [send]),
    pick: useCallback((teamKey: string) => send({ type: "pick", teamKey }), [send]),
    pause: useCallback(() => send({ type: "pause" }), [send]),
    resume: useCallback(() => send({ type: "resume" }), [send]),
    extend: useCallback(() => send({ type: "extend" }), [send]),
    pickFor: useCallback((teamKey: string) => send({ type: "pickFor", teamKey }), [send]),
    undo: useCallback(() => send({ type: "undo" }), [send]),
    dismissError: useCallback(() => setError(""), []),
  };
}

/** Seconds left on the pick clock, ticking locally between server pushes. */
export function useCountdown(deadline: number | null): number | null {
  const [remaining, setRemaining] = useState<number | null>(null);

  useEffect(() => {
    if (deadline === null) {
      setRemaining(null);
      return;
    }
    const tick = () => setRemaining(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 500);
    return () => clearInterval(timer);
  }, [deadline]);

  return remaining;
}

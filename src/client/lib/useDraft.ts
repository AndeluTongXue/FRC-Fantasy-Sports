import { useCallback, useEffect, useRef, useState } from "react";
import type { DraftClientMessage, DraftServerMessage, DraftState } from "../../shared/types";

export function useDraft(leagueId: string) {
  const [state, setState] = useState<DraftState | null>(null);
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;

    function open() {
      const protocol = location.protocol === "https:" ? "wss" : "ws";
      const socket = new WebSocket(`${protocol}://${location.host}/api/leagues/${leagueId}/draft/ws`);
      socketRef.current = socket;

      socket.onopen = () => setConnected(true);
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data as string) as DraftServerMessage;
        if (message.type === "state") setState(message.state);
        else setError(message.message);
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
  }, [leagueId]);

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

import { useCallback, useEffect, useRef, useState } from "react";
import type { DraftState } from "../../shared/types";

export type TurnNotifyStatus = "unsupported" | "denied" | "granted" | "default";

const BASE_TITLE = "FRC Fantasy";

function storageKey(leagueId: string): string {
  return `ffs-turn-alerts:${leagueId}`;
}

function playBeep(): void {
  try {
    const Ctx = window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.start();
    osc.stop(ctx.currentTime + 0.45);
    osc.onended = () => void ctx.close();
  } catch {
    // Audio is best-effort — a blocked AudioContext must never break the draft room.
  }
}

/**
 * Notifies the owner the moment a draft turn becomes theirs.
 *
 * Driven by the live WebSocket `DraftState` (works while the draft room is open,
 * including a background tab). Fires a browser `Notification` when permission is
 * granted, plus a beep, vibration, and tab-title flash so the clock is hard to miss.
 * Only fires once per pick — tracked via `currentPick`.
 */
export function useTurnNotification(
  state: DraftState | null,
  userId: string | undefined,
  leagueId: string,
  leagueName: string,
): {
  status: TurnNotifyStatus;
  alertsOn: boolean;
  request: () => Promise<void>;
  toggle: () => void;
} {
  const [status, setStatus] = useState<TurnNotifyStatus>(() =>
    typeof window === "undefined" || !("Notification" in window) ? "unsupported" : Notification.permission,
  );
  const [alertsOn, setAlertsOn] = useState<boolean>(() => {
    try {
      return localStorage.getItem(storageKey(leagueId)) !== "off";
    } catch {
      return true;
    }
  });
  const lastNotifiedPick = useRef<number>(-1);

  const request = useCallback(async () => {
    if (!("Notification" in window)) return;
    const result = await Notification.requestPermission();
    setStatus(result);
    if (result === "granted") {
      setAlertsOn(true);
      try {
        localStorage.setItem(storageKey(leagueId), "on");
      } catch {
        // ignore
      }
    }
  }, [leagueId]);

  const toggle = useCallback(() => {
    setAlertsOn((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(storageKey(leagueId), next ? "on" : "off");
      } catch {
        // ignore
      }
      return next;
    });
  }, [leagueId]);

  useEffect(() => {
    if (!state || state.status !== "active" || !userId) return;
    const myTurn = state.currentUserId === userId;

    if (!myTurn) {
      if (document.title !== BASE_TITLE) document.title = BASE_TITLE;
      return;
    }

    // Same turn re-render (budget/timer updates) — don't re-notify.
    if (state.currentPick === lastNotifiedPick.current) {
      document.title = `🟢 YOUR PICK — ${leagueName}`;
      return;
    }
    lastNotifiedPick.current = state.currentPick;

    document.title = `🟢 YOUR PICK — ${leagueName}`;
    if (!alertsOn) return;

    playBeep();
    try {
      navigator.vibrate?.(200);
    } catch {
      // ignore
    }

    if (status === "granted") {
      try {
        const notification = new Notification("You're on the clock!", {
          body: `${leagueName}: pick ${state.currentPick + 1} of ${state.totalPicks} — your draft clock is running.`,
          tag: `draft-turn:${leagueId}`,
        });
        notification.onclick = () => {
          window.focus();
          notification.close();
        };
      } catch {
        // Creating a Notification can throw in some embedded webviews — ignore.
      }
    }
  }, [state, userId, leagueId, leagueName, alertsOn, status]);

  useEffect(() => {
    return () => {
      if (document.title !== BASE_TITLE) document.title = BASE_TITLE;
    };
  }, []);

  return { status, alertsOn, request, toggle };
}

import { useEffect, useRef, useState } from "react";

interface Props {
  value: string;
  /** Announced to screen readers and used as the tooltip, e.g. "Copy invite code". */
  label: string;
  className?: string;
}

/**
 * Falls back to a hidden textarea and `execCommand` when the async clipboard isn't
 * available — it needs a secure context and can be refused outright, and silently doing
 * nothing is the worst outcome for a button whose whole job is one small action.
 */
async function copy(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }

  try {
    const scratch = document.createElement("textarea");
    scratch.value = value;
    scratch.setAttribute("readonly", "");
    scratch.style.position = "fixed";
    scratch.style.opacity = "0";
    document.body.appendChild(scratch);
    scratch.select();
    const copied = document.execCommand("copy");
    document.body.removeChild(scratch);
    return copied;
  } catch {
    return false;
  }
}

export function CopyButton({ value, label, className = "" }: Props) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // The reset is on a timer, so it has to be cancelled if the button unmounts first.
  useEffect(() => () => clearTimeout(timer.current), []);

  async function handleClick() {
    const copied = await copy(value);
    setState(copied ? "copied" : "failed");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2000);
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      title={label}
      aria-label={label}
      className={`text-xs ${state === "failed" ? "text-red-600" : "text-sky-600 hover:underline"} ${className}`}
    >
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}
    </button>
  );
}

import { useEffect, useRef, useState } from "react";
import { AlertCircle, Check, Copy } from "lucide-react";

export interface CopyAddressButtonProps {
  value: string;
  label: string;
  copiedLabel: string;
  failedLabel: string;
  ariaLabel?: string;
  className?: string;
  compact?: boolean;
}

let lastAnnouncedCopyStatus = "";

export function CopyAddressButton({
  value,
  label,
  copiedLabel,
  failedLabel,
  ariaLabel,
  className = "",
  compact = false,
}: CopyAddressButtonProps) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const [liveMsg, setLiveMsg] = useState("");
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, []);

  const announce = (nextState: "copied" | "failed") => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
    }
    setState(nextState);
    let msg = nextState === "copied" ? copiedLabel : failedLabel;
    // Append NBSP when identical to previous status so VoiceOver re-announces repeat clicks.
    if (msg === lastAnnouncedCopyStatus) {
      msg += "\u00A0";
    }
    lastAnnouncedCopyStatus = msg;
    setLiveMsg("");
    requestAnimationFrame(() => setLiveMsg(msg));

    timerRef.current = window.setTimeout(() => {
      setState("idle");
      setLiveMsg("");
    }, 2000);
  };

  const handleCopy = async () => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      announce("copied");
    } catch {
      announce("failed");
    }
  };

  const visibleText =
    state === "copied"
      ? copiedLabel
      : state === "failed"
        ? failedLabel
        : label;

  return (
    <span className="inline-flex items-center">
      <button
        type="button"
        onClick={() => void handleCopy()}
        aria-label={compact ? ariaLabel || label : undefined}
        data-copied={state === "copied" ? "" : undefined}
        data-failed={state === "failed" ? "" : undefined}
        className={`inline-flex min-h-7 min-w-7 items-center justify-center gap-1.5 rounded-full bg-[#24282f] px-3 py-1 text-xs font-semibold text-white hover:bg-[#2f343d] transition cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white ${className}`}
      >
        {state === "copied" ? (
          <Check className="h-3.5 w-3.5 text-[#2EC26B] shrink-0" aria-hidden="true" />
        ) : state === "failed" ? (
          <AlertCircle className="h-3.5 w-3.5 text-[#E85D4A] shrink-0" aria-hidden="true" />
        ) : (
          <Copy className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        )}
        {!compact && <span>{visibleText}</span>}
      </button>
      {/* Keep live region outside <button> so screen readers reliably announce status changes */}
      <span role="status" aria-live="polite" className="payoff-visually-hidden">
        {liveMsg}
      </span>
    </span>
  );
}

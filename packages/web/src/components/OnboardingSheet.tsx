import { useEffect, useId, useRef } from "react";
import { X } from "lucide-react";
import type { Locale } from "../lib/i18n";

export const ONBOARDING_SEEN_KEY = "payoff_v7_onboarding_seen";

export function hasSeenOnboarding(): boolean {
  try {
    return window.localStorage.getItem(ONBOARDING_SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function markOnboardingSeen(): void {
  try {
    window.localStorage.setItem(ONBOARDING_SEEN_KEY, "1");
  } catch {
    // ignore storage failures (private browsing / restricted storage)
  }
}

export interface OnboardingSheetProps {
  open: boolean;
  locale: Locale;
  onClose: () => void;
}

export function OnboardingSheet({
  open,
  locale,
  onClose,
}: OnboardingSheetProps) {
  const isZh = locale === "zh";
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  // Safari fallback for declarative <dialog closedby="any">
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) return;
    if ("closedBy" in HTMLDialogElement.prototype) return;

    const isOutside = (e: PointerEvent) => {
      const r = dialog.getBoundingClientRect();
      return (
        e.clientX < r.left ||
        e.clientX > r.right ||
        e.clientY < r.top ||
        e.clientY > r.bottom
      );
    };

    let pressedOutside = false;
    const onPointerDown = (e: PointerEvent) => {
      pressedOutside = isOutside(e);
    };
    const onPointerUp = (e: PointerEvent) => {
      if (pressedOutside && isOutside(e)) {
        dialog.close();
      }
      pressedOutside = false;
    };

    dialog.addEventListener("pointerdown", onPointerDown);
    dialog.addEventListener("pointerup", onPointerUp);
    return () => {
      dialog.removeEventListener("pointerdown", onPointerDown);
      dialog.removeEventListener("pointerup", onPointerUp);
    };
  }, [open]);

  if (!open) return null;

  const rules = isZh
    ? [
        {
          n: "1",
          title: "猜方向",
          desc: "选 BTC / ETH / NVDA，判断到期结算时价格是涨还是跌。",
        },
        {
          n: "2",
          title: "猜对就有钱，涨得越多赢得越多",
          desc: "不会“差一点就归零”，越接近封顶价拿回越多，到封顶价赢满。",
        },
        {
          n: "3",
          title: "最多亏掉本金",
          desc: "盘中插针永不爆仓，最后 30 分钟锁定期前随时可以卖出。",
        },
      ]
    : [
        {
          n: "1",
          title: "Pick a direction",
          desc: "Choose BTC, ETH, or NVDA and predict Up or Down by settlement.",
        },
        {
          n: "2",
          title: "Paid proportionally — no all-or-nothing cliff",
          desc: "Partial moves still pay back linearly; hit the target cap for max payout.",
        },
        {
          n: "3",
          title: "Loss capped at your stake",
          desc: "Zero liquidation on intraday wicks. Exit early anytime before the 30m lock.",
        },
      ];

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      {...({ closedby: "any" } as Record<string, unknown>)}
      onClose={() => {
        if (dialogRef.current) dialogRef.current.returnValue = "";
        markOnboardingSeen();
        onClose();
      }}
      className="payoff-sheet"
    >
      <div className="flex max-h-[90dvh] flex-col md:max-h-[86dvh]">
        <div aria-hidden="true" className="payoff-sheet-handle" />

        <div className="overflow-y-auto px-5 pt-3 pb-6 sm:px-6 safe-pb space-y-5">
          {/* Header */}
          <div className="flex items-start justify-between gap-3">
            <div>
              <h1
                id={titleId}
                className="text-[19px] font-bold tracking-[-0.02em] text-white"
              >
                {isZh ? "30 秒看懂 Payoff" : "Understand Payoff in 30s"}
              </h1>
              <p className="mt-1 text-xs text-[#7e8690]">
                {isZh
                  ? "连续线性赔付 · 一键交易"
                  : "Continuous linear payoff · 1-click trading"}
              </p>
            </div>
            <button
              type="button"
              aria-label={isZh ? "关闭" : "Close"}
              onClick={() => dialogRef.current?.close()}
              className="rounded-full p-1.5 text-[#7e8690] hover:bg-[#24282f] hover:text-white transition cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>

          {/* 3 Concise Rules */}
          <ol className="space-y-3.5">
            {rules.map((rule) => (
              <li key={rule.n} className="flex items-start gap-3">
                <span
                  aria-hidden="true"
                  className="mt-0.5 flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-[#24282f] text-[11.5px] font-bold text-white tabular-nums"
                >
                  {rule.n}
                </span>
                <div className="min-w-0">
                  <div className="text-sm font-bold text-white leading-snug">
                    {rule.title}
                  </div>
                  <p className="mt-0.5 text-xs leading-relaxed text-[#7e8690]">
                    {rule.desc}
                  </p>
                </div>
              </li>
            ))}
          </ol>

          {/* $20 Payoff Comparison Card */}
          <div className="rounded-2xl bg-black border border-[#1d2025] p-3.5 space-y-3">
            <div className="text-xs font-semibold text-white leading-snug tabular-nums">
              {isZh
                ? "同样押 $20 看涨，BTC 涨了 2%（$60,276 → $61,500）"
                : "Same $20 Up bet, BTC rises +2% ($60,276 → $61,500)"}
            </div>

            <div className="space-y-2.5">
              {/* Standard prediction markets row */}
              <div className="grid grid-cols-[minmax(96px,auto)_1fr_54px] items-center gap-2.5 text-xs">
                <span className="text-[#b8bec6] truncate">
                  {isZh ? "普通预测市场" : "Standard prediction markets"}
                </span>
                <div className="h-2.5 rounded-full bg-[#1e2126] overflow-hidden">
                  <div className="h-full w-[4%] rounded-full bg-[#4a5058]" />
                </div>
                <span className="text-right text-[13px] font-bold text-white tabular-nums">
                  $0
                </span>
              </div>

              {/* Payoff row */}
              <div className="grid grid-cols-[minmax(96px,auto)_1fr_54px] items-center gap-2.5 text-xs">
                <span className="font-semibold text-white">Payoff</span>
                <div className="h-2.5 rounded-full bg-[#1e2126] overflow-hidden">
                  <div className="h-full w-[78%] rounded-full bg-[#2EC26B]" />
                </div>
                <span className="text-right text-[13px] font-bold text-[#2EC26B] tabular-nums">
                  {isZh ? "约 $36" : "~$36"}
                </span>
              </div>
            </div>

            <p className="text-[11.5px] leading-relaxed text-[#7e8690]">
              {isZh
                ? "普通市场押的是“$61,750 以上”，差 $250 没过线直接归零。"
                : "Standard markets require crossing $61,750 — miss by $250 and your payout drops to $0."}
            </p>
          </div>

          {/* Pure-white Primary CTA */}
          <button
            type="button"
            autoFocus
            onClick={() => dialogRef.current?.close()}
            className="flex w-full min-h-[50px] items-center justify-center rounded-full bg-white px-5 py-3 text-[15px] font-bold tracking-[-0.01em] text-black hover:bg-white/90 active:scale-[0.99] transition cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          >
            {isZh ? "开始体验" : "Get started"}
          </button>
        </div>
      </div>
    </dialog>
  );
}

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { ArrowLeft, ArrowRight, ShieldCheck, Sparkles } from "lucide-react";
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
  walletConnected?: boolean;
  onClose: () => void;
}

type TourTargetKey = "direction-cap" | "payoff-curve" | "buy-cta";

interface TourStepDef {
  target: TourTargetKey;
  padding: number;
  titleZh: string;
  titleEn: string;
  bodyZh: string;
  bodyEn: string;
  calloutKind: "interactive" | "compare" | "protection";
}

const TOUR_STEPS: readonly TourStepDef[] = [
  {
    target: "direction-cap",
    padding: 8,
    titleZh: "选方向，拉动目标封顶价",
    titleEn: "Pick a direction & target cap",
    bodyZh:
      "选择看涨（Up）或看跌（Down），拖动滑块调节目标封顶价——目标设得越远，潜在赔率倍数越高。",
    bodyEn:
      "Choose Up or Down and slide the target cap to dial in your payout multiplier—further targets unlock higher returns.",
    calloutKind: "interactive",
  },
  {
    target: "payoff-curve",
    padding: 6,
    titleZh: "涨一半也赚钱，不会归零",
    titleEn: "Move halfway, still get paid",
    bodyZh:
      "Payoff 采用连续线性赔付：到期价格越接近封顶价拿回越多。在曲线上左右滑动，可实时预览任意结算价的收益。",
    bodyEn:
      "Unlike all-or-nothing prediction markets, Payoff pays proportionally along a continuous ramp. Slide across the curve to preview payouts at any expiry price.",
    calloutKind: "compare",
  },
  {
    target: "buy-cta",
    padding: 7,
    titleZh: "最多亏本金，盘中插针不爆仓",
    titleEn: "Loss capped at stake · Zero liquidation",
    bodyZh:
      "亏损严格封顶在投入金额内，最后 30 分钟锁定期前随时可提前卖出。确认上方金额后，点击这里即可一键交易。",
    bodyEn:
      "Intraday wicks can never liquidate you, and you can exit early anytime before the 30m lock. Set your stake above and click here to trade.",
    calloutKind: "protection",
  },
];

interface CutoutRect {
  left: number;
  top: number;
  width: number;
  height: number;
  radius: number;
}

const DESKTOP_MEDIA = "(min-width: 1024px)";
const ANCHOR_TOKEN = "--payoff-tour-target";

function getTourFeatureSupport() {
  if (typeof window === "undefined" || typeof HTMLElement === "undefined") {
    return { popover: true, anchorArea: true };
  }
  const popover = Object.hasOwn(HTMLElement.prototype, "popover");
  const anchorArea =
    typeof CSS !== "undefined" &&
    typeof CSS.supports === "function" &&
    CSS.supports("position-area: inline-start") &&
    CSS.supports("align-self: anchor-center");
  return { popover, anchorArea };
}

function queryTourTarget(key: TourTargetKey): HTMLElement | null {
  const el = document.querySelector<HTMLElement>(`[data-tour-target="${key}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? el : null;
}

function measureCutout(el: HTMLElement, step: TourStepDef): CutoutRect {
  const r = el.getBoundingClientRect();
  const pad = step.padding;
  const radius =
    step.target === "buy-cta" && r.height <= 68 ? 9999 : 18;
  return {
    left: Math.round(r.left - pad),
    top: Math.round(r.top - pad),
    width: Math.round(r.width + pad * 2),
    height: Math.round(r.height + pad * 2),
    radius,
  };
}

export function OnboardingSheet({
  open,
  locale,
  walletConnected = false,
  onClose,
}: OnboardingSheetProps) {
  const isZh = locale === "zh";
  const titleId = useId();
  const bodyId = useId();

  const popoverRef = useRef<HTMLDialogElement | null>(null);
  const nextBtnRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const anchoredElRef = useRef<HTMLElement | null>(null);

  const [stepIdx, setStepIdx] = useState(0);
  const [cutout, setCutout] = useState<CutoutRect | null>(null);
  const [animateStep, setAnimateStep] = useState(false);
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window !== "undefined"
      ? window.matchMedia(DESKTOP_MEDIA).matches
      : true
  );

  const support = getTourFeatureSupport();
  const step = TOUR_STEPS[stepIdx] ?? TOUR_STEPS[0]!;
  const isFirstStep = stepIdx === 0;
  const isLastStep = stepIdx === TOUR_STEPS.length - 1;

  // Reset step to 0 whenever the tour opens & capture previously focused element
  useEffect(() => {
    if (!open) return;
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setStepIdx(0);
    setAnimateStep(false);
  }, [open]);

  // Keep desktop/mobile layout mode in sync
  useEffect(() => {
    if (!open || typeof window === "undefined") return;
    const mq = window.matchMedia(DESKTOP_MEDIA);
    const sync = () => setIsDesktop(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, [open]);

  const clearAnchorBinding = useCallback(() => {
    if (anchoredElRef.current) {
      anchoredElRef.current.style.removeProperty("anchor-name");
      anchoredElRef.current = null;
    }
  }, []);

  const dismissTour = useCallback(
    (focusTargetAfter?: boolean) => {
      clearAnchorBinding();
      const popover = popoverRef.current;
      if (support.popover && popover) {
        try {
          if (popover.matches(":popover-open")) {
            popover.hidePopover();
          }
        } catch {
          // ignore if detached
        }
      }
      markOnboardingSeen();
      onClose();

      // Restore focus cleanly without triggering scroll jumps
      requestAnimationFrame(() => {
        if (focusTargetAfter) {
          const buyEl = document.querySelector<HTMLElement>(
            '[data-tour-target="buy-cta"] button, [data-tour-target="buy-cta"] a'
          );
          if (buyEl) {
            buyEl.focus({ preventScroll: true });
            return;
          }
        }
        const prev = previousFocusRef.current;
        if (prev && prev !== document.body && prev.isConnected) {
          prev.focus({ preventScroll: true });
        }
      });
    },
    [clearAnchorBinding, onClose, support.popover]
  );

  // Position JS fallback on desktop browsers without native CSS Anchor Positioning
  const positionDesktopFallback = useCallback(
    (rect: CutoutRect | null) => {
      const popover = popoverRef.current;
      if (!popover) return;

      if (!isDesktop || support.anchorArea || !rect) {
        popover.removeAttribute("data-js-positioned");
        popover.style.left = "";
        popover.style.top = "";
        return;
      }

      const gap = 16;
      const edge = 16;
      const pr = popover.getBoundingClientRect();
      const cardW = pr.width || popover.offsetWidth || 344;
      const cardH = pr.height || popover.offsetHeight || 220;

      let left = rect.left - cardW - gap;
      if (left < edge) {
        // Not enough room on the left -> place to the right or clamp inside viewport
        const rightCandidate = rect.left + rect.width + gap;
        left =
          rightCandidate + cardW <= window.innerWidth - edge
            ? rightCandidate
            : Math.max(edge, Math.min(rect.left, window.innerWidth - cardW - edge));
      }

      let top = rect.top + rect.height / 2 - cardH / 2;
      top = Math.max(68, Math.min(top, window.innerHeight - cardH - edge));

      popover.setAttribute("data-js-positioned", "true");
      popover.style.left = `${Math.round(left)}px`;
      popover.style.top = `${Math.round(top)}px`;
    },
    [isDesktop, support.anchorArea]
  );

  // Promote manual popover to Top Layer when open (useEffect runs after any closing modal dialog finishes close())
  useEffect(() => {
    const popover = popoverRef.current;
    if (!open || !popover) return;

    const rafId = requestAnimationFrame(() => {
      if (support.popover && popover.isConnected) {
        try {
          if (!popover.matches(":popover-open")) {
            popover.showPopover();
          }
        } catch {
          // ignore if already open
        }
      }

      // Route focus into the tour card when explicitly triggered by the user (e.g. Replay button)
      const prev = previousFocusRef.current;
      const isExplicitUserTrigger =
        prev !== null &&
        prev !== document.body &&
        prev !== document.documentElement;
      if (isExplicitUserTrigger) {
        nextBtnRef.current?.focus({ preventScroll: true });
      }
    });

    return () => {
      cancelAnimationFrame(rafId);
      clearAnchorBinding();
      if (support.popover && popover.isConnected) {
        try {
          if (popover.matches(":popover-open")) {
            popover.hidePopover();
          }
        } catch {
          // ignore
        }
      }
    };
  }, [open, support.popover, clearAnchorBinding]);

  // Step 3 graduation: if the user directly clicks the highlighted Buy / Sign-in CTA, seamlessly close the tour
  useEffect(() => {
    if (!open || step.target !== "buy-cta") return;
    const buyTarget = queryTourTarget("buy-cta");
    if (!buyTarget) return;
    const onDirectCtaClick = () => {
      dismissTour(false);
    };
    buyTarget.addEventListener("click", onDirectCtaClick, {
      capture: true,
      once: true,
    });
    return () => {
      buyTarget.removeEventListener("click", onDirectCtaClick, true);
    };
  }, [open, step.target, cutout, dismissTour]);

  // Locate active target, scroll smoothly into safe view, bind CSS anchor-name, and track live geometry
  useEffect(() => {
    if (!open) return;

    let rafId = 0;
    let settleTimer = 0;
    let ro: ResizeObserver | null = null;
    let mo: MutationObserver | null = null;

    const syncGeometry = (allowStepGlide: boolean) => {
      const targetEl = queryTourTarget(step.target);
      if (!targetEl) {
        clearAnchorBinding();
        setCutout(null);
        positionDesktopFallback(null);
        return false;
      }

      // Bind CSS Anchor Positioning on desktop when supported
      if (isDesktop && support.anchorArea) {
        if (anchoredElRef.current !== targetEl) {
          clearAnchorBinding();
          targetEl.style.setProperty("anchor-name", ANCHOR_TOKEN);
          anchoredElRef.current = targetEl;
        }
      } else {
        clearAnchorBinding();
      }

      const nextRect = measureCutout(targetEl, step);
      setAnimateStep(allowStepGlide);
      setCutout(nextRect);
      requestAnimationFrame(() => positionDesktopFallback(nextRect));
      return true;
    };

    const ensureTargetInSafeView = (targetEl: HTMLElement) => {
      const prefersReduced = window.matchMedia(
        "(prefers-reduced-motion: reduce)"
      ).matches;
      const behavior: ScrollBehavior = prefersReduced ? "auto" : "smooth";
      const rect = targetEl.getBoundingClientRect();

      if (isDesktop) {
        if (rect.top < 72 || rect.bottom > window.innerHeight - 24) {
          targetEl.scrollIntoView({ behavior, block: "center" });
        }
      } else {
        // Mobile: keep target centered in the upper safe zone above the fixed bottom tour card
        const safeTop = 68;
        const cardH = popoverRef.current?.offsetHeight || 228;
        const safeBottom = Math.max(
          safeTop + 120,
          window.innerHeight - cardH - 24
        );
        if (rect.top < safeTop || rect.bottom > safeBottom) {
          const targetCenterDocY = window.scrollY + rect.top + rect.height / 2;
          const desiredViewportCenterY = (safeTop + safeBottom) / 2;
          const nextY = Math.max(0, targetCenterDocY - desiredViewportCenterY);
          window.scrollTo({ top: nextY, behavior });
        }
      }
    };

    const attachTarget = () => {
      const targetEl = queryTourTarget(step.target);
      if (!targetEl) return false;

      ensureTargetInSafeView(targetEl);
      syncGeometry(true);

      ro?.disconnect();
      ro = new ResizeObserver(() => {
        cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(() => syncGeometry(false));
      });
      ro.observe(targetEl);

      // Re-measure once after smooth scroll settles
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => {
        syncGeometry(false);
      }, 320);
      return true;
    };

    if (!attachTarget()) {
      // Target may still be mounting asynchronously; watch DOM briefly until it appears
      setCutout(null);
      mo = new MutationObserver(() => {
        if (attachTarget()) {
          mo?.disconnect();
          mo = null;
        }
      });
      mo.observe(document.body, { childList: true, subtree: true });
    }

    const onViewportChange = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => syncGeometry(false));
    };

    window.addEventListener("scroll", onViewportChange, {
      capture: true,
      passive: true,
    });
    window.addEventListener("resize", onViewportChange, { passive: true });

    return () => {
      cancelAnimationFrame(rafId);
      window.clearTimeout(settleTimer);
      ro?.disconnect();
      mo?.disconnect();
      window.removeEventListener("scroll", onViewportChange, true);
      window.removeEventListener("resize", onViewportChange);
    };
  }, [
    open,
    step,
    isDesktop,
    support.anchorArea,
    clearAnchorBinding,
    positionDesktopFallback,
  ]);

  // Keyboard shortcuts: Escape always closes; Arrow keys navigate only when focus is inside the tour card
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        dismissTour(false);
        return;
      }
      const insideCard =
        popoverRef.current &&
        document.activeElement &&
        popoverRef.current.contains(document.activeElement);
      if (!insideCard) return;

      if (e.key === "ArrowRight") {
        e.preventDefault();
        if (stepIdx < TOUR_STEPS.length - 1) {
          setStepIdx((prev) => prev + 1);
        } else {
          dismissTour(true);
        }
      } else if (e.key === "ArrowLeft" && stepIdx > 0) {
        e.preventDefault();
        setStepIdx((prev) => prev - 1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, stepIdx, dismissTour]);

  if (!open) return null;

  const handleNext = () => {
    if (isLastStep) {
      dismissTour(true);
    } else {
      setStepIdx((prev) => Math.min(TOUR_STEPS.length - 1, prev + 1));
    }
  };

  const handlePrev = () => {
    setStepIdx((prev) => Math.max(0, prev - 1));
  };

  const stepTitle = isZh ? step.titleZh : step.titleEn;
  const stepBody = isZh ? step.bodyZh : step.bodyEn;
  const isAnchoredDesktop = Boolean(cutout && isDesktop && support.anchorArea);

  return (
    <>
      {/* Visual Spotlight Backdrop + Morphing White Highlight Frame (never blocks scrolling or spotlight interaction) */}
      <div
        aria-hidden="true"
        className="fixed inset-0 z-40 overflow-hidden pointer-events-none"
      >
        {cutout ? (
          <div
            data-step-animate={animateStep ? "true" : "false"}
            className="payoff-tour-ring"
            style={{
              left: `${cutout.left}px`,
              top: `${cutout.top}px`,
              width: `${cutout.width}px`,
              height: `${cutout.height}px`,
              borderRadius: `${cutout.radius}px`,
            }}
          />
        ) : (
          <div className="absolute inset-0 bg-black/56" />
        )}
      </div>

      {/* 4-Quadrant Surround Shields: prevent accidental clicks outside the white box while keeping the highlighted control 100% live */}
      {cutout ? (
        <div aria-hidden="true" className="fixed inset-0 z-40 pointer-events-none">
          {/* Top shield */}
          <div
            className="fixed left-0 right-0 top-0 pointer-events-auto"
            style={{ height: `${Math.max(0, cutout.top)}px` }}
          />
          {/* Bottom shield */}
          <div
            className="fixed left-0 right-0 bottom-0 pointer-events-auto"
            style={{ top: `${Math.max(0, cutout.top + cutout.height)}px` }}
          />
          {/* Left shield */}
          <div
            className="fixed left-0 pointer-events-auto"
            style={{
              top: `${Math.max(0, cutout.top)}px`,
              height: `${Math.max(0, cutout.height)}px`,
              width: `${Math.max(0, cutout.left)}px`,
            }}
          />
          {/* Right shield */}
          <div
            className="fixed right-0 pointer-events-auto"
            style={{
              top: `${Math.max(0, cutout.top)}px`,
              height: `${Math.max(0, cutout.height)}px`,
              left: `${Math.max(0, cutout.left + cutout.width)}px`,
            }}
          />
        </div>
      ) : (
        <div
          aria-hidden="true"
          className="fixed inset-0 z-40 pointer-events-auto"
        />
      )}

      {/* Top-Layer Manual Popover Tour Card */}
      <dialog
        ref={popoverRef}
        {...(support.popover ? { popover: "manual" } : { open: true })}
        data-anchored={isAnchoredDesktop ? "true" : undefined}
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        tabIndex={-1}
        className="payoff-tour-popover"
      >
        <div className="p-4 sm:p-5 space-y-3.5">
          {/* Top Row: Step Progress Pill + Skip */}
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-0.5 text-[11px] font-semibold text-white tabular-nums">
              <span>
                {stepIdx + 1} / {TOUR_STEPS.length}
              </span>
            </span>

            <button
              type="button"
              onClick={() => dismissTour(false)}
              className="inline-flex min-h-[30px] items-center rounded-full px-2.5 text-xs font-medium text-[#8b939d] hover:bg-[#1f2329] hover:text-white transition cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              {isZh ? "跳过引导" : "Skip"}
            </button>
          </div>

          {/* Step Heading + Concise Self-Contained Explanation */}
          <div className="space-y-1.5" aria-live="polite">
            <h2
              id={titleId}
              className="text-[16px] font-bold leading-snug tracking-[-0.02em] text-white"
            >
              {stepTitle}
            </h2>
            <p
              id={bodyId}
              className="text-[12.5px] leading-relaxed text-[#a8b0ba]"
            >
              {stepBody}
            </p>
          </div>

          {/* Contextual Micro-Callout per Step */}
          {step.calloutKind === "interactive" && (
            <div className="flex items-center gap-2 rounded-xl border border-[#1d2025] bg-[#0b0c0e] px-3 py-2 text-[11.5px] text-[#b8bec6]">
              <Sparkles
                className="h-3.5 w-3.5 shrink-0 text-[#2EC26B]"
                aria-hidden="true"
              />
              <span>
                {isZh
                  ? "支持直接在白框内点击方向或拖动滑块试试"
                  : "Try clicking Up/Down or dragging inside the frame"}
              </span>
            </div>
          )}

          {step.calloutKind === "compare" && (
            <div className="rounded-xl border border-[#1d2025] bg-[#0b0c0e] px-3 py-2 space-y-1 text-[11.5px] tabular-nums">
              <div className="flex items-center justify-between gap-2 text-[#7e8690]">
                <span>{isZh ? "普通二元市场（差一点未过线）" : "Binary markets (just short)"}</span>
                <span className="font-bold text-[#b8bec6]">$0</span>
              </div>
              <div className="flex items-center justify-between gap-2 text-white">
                <span className="font-semibold">
                  {isZh ? "Payoff 连续线性赔付" : "Payoff continuous linear"}
                </span>
                <span className="font-bold text-[#2EC26B]">
                  {isZh ? "按比例照付" : "Paid proportionally"}
                </span>
              </div>
            </div>
          )}

          {step.calloutKind === "protection" && (
            <div className="flex items-center gap-2 rounded-xl border border-[#1d2025] bg-[#0b0c0e] px-3 py-2 text-[11.5px] text-[#b8bec6]">
              <ShieldCheck
                className="h-3.5 w-3.5 shrink-0 text-[#2EC26B]"
                aria-hidden="true"
              />
              <span>
                {walletConnected
                  ? isZh
                    ? "无 Gas 费交易 · 顶部 Mint 随时免费领测试币"
                    : "Gas-free trading · Mint free test tUSDT anytime"
                  : isZh
                    ? "支持邮箱 1 秒登录 · 自动发放测试币免费体验"
                    : "1-click email sign-in · Free testnet tUSDT included"}
              </span>
            </div>
          )}

          {/* Bottom Controls: Clickable Step Dots + Back / Next CTA */}
          <div className="flex items-center justify-between gap-3 pt-1">
            <div
              role="group"
              aria-label={isZh ? "引导步骤" : "Tour steps"}
              className="flex items-center gap-1.5"
            >
              {TOUR_STEPS.map((s, idx) => {
                const active = idx === stepIdx;
                return (
                  <button
                    key={s.target}
                    type="button"
                    aria-label={
                      isZh
                        ? `第 ${idx + 1} 步：${s.titleZh}`
                        : `Step ${idx + 1}: ${s.titleEn}`
                    }
                    aria-current={active ? "step" : undefined}
                    onClick={() => setStepIdx(idx)}
                    className={`h-1.5 rounded-full transition-all cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white ${
                      active
                        ? "w-5 bg-white"
                        : "w-1.5 bg-[#323741] hover:bg-[#58606d]"
                    }`}
                  />
                );
              })}
            </div>

            <div className="flex items-center gap-2">
              {!isFirstStep && (
                <button
                  type="button"
                  onClick={handlePrev}
                  className="inline-flex min-h-[36px] items-center gap-1 rounded-full bg-[#1f2329] px-3.5 py-1.5 text-xs font-semibold text-[#d0d6de] hover:bg-[#2a2f38] hover:text-white transition cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
                >
                  <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>{isZh ? "上一步" : "Back"}</span>
                </button>
              )}

              <button
                ref={nextBtnRef}
                type="button"
                onClick={handleNext}
                className="inline-flex min-h-[36px] items-center gap-1.5 rounded-full bg-white px-4 py-1.5 text-xs font-bold text-black hover:bg-white/90 active:scale-[0.98] transition cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
              >
                <span>
                  {isLastStep
                    ? isZh
                      ? "开始交易"
                      : "Start trading"
                    : isZh
                      ? "下一步"
                      : "Next"}
                </span>
                {!isLastStep && (
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                )}
              </button>
            </div>
          </div>
        </div>
      </dialog>
    </>
  );
}

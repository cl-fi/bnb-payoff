import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Loader2,
  RefreshCw,
  X,
} from "lucide-react";
import {
  ASSET_SPECS,
  type CloseRfqResponse,
  type PositionView,
} from "@payoff/shared";
import { formatExpiryDateTime, formatStrikePrice } from "../lib/format";
import { getCopy, type Locale } from "../lib/i18n";

export type EarlyCloseStage =
  | "IDLE"
  | "QUOTING"
  | "SLIPPAGE_CONFIRM"
  | "EXECUTING";

export interface CloseSlippagePauseState {
  rfq: CloseRfqResponse;
  estimatedUsdt: number;
  firmUsdt: number;
  dropPct: number;
}

export interface EarlyCloseModalProps {
  locale: Locale;
  position: PositionView;
  stage: EarlyCloseStage;
  slippagePause?: CloseSlippagePauseState;
  errorMsg?: string;
  onInstantSell: (closeRatio: number) => void;
  onConfirmSlippageClose: () => void;
  onClearSlippagePause: () => void;
  onCloseModal: () => void;
}

const FULL_EXIT_RATIO_THRESHOLD = 0.995;
const QUICK_PRESET_RATIOS = [0.25, 0.5, 0.75, 1] as const;

function formatExpiryCompact(expirySec: number, locale: Locale): string {
  const formatted = formatExpiryDateTime(expirySec, locale);
  if (formatted === "--") return formatted;
  return locale === "zh" ? `${formatted} 结算` : formatted;
}

function formatSignedUsd(v: number): string {
  const sign = v >= 0 ? "+" : "−";
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

export function EarlyCloseModal({
  locale,
  position,
  stage,
  slippagePause,
  errorMsg,
  onInstantSell,
  onConfirmSlippageClose,
  onClearSlippagePause,
  onCloseModal,
}: EarlyCloseModalProps) {
  const isZh = locale === "zh";
  const t = getCopy(locale);
  const titleId = useId();
  const usdInputId = useId();
  const usdHintId = useId();
  const usdErrId = useId();
  const sliderId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);

  const [ratio, setRatio] = useState(1);
  // Raw draft string only while user is actively editing the USD input so live WS quotes never fight typing
  const [usdDraft, setUsdDraft] = useState<string | null>(null);
  const [usdTouched, setUsdTouched] = useState(false);
  const [nowSec, setNowSec] = useState<number>(() =>
    Math.floor(Date.now() / 1000)
  );

  const isBusy = stage === "QUOTING" || stage === "EXECUTING";
  const totalExitUsdt = Math.max(0, position.indicativeExitUsdt);
  const minSellUsd = totalExitUsdt > 1 ? 1 : 0.01;

  // Resolve effective ratio & validation state
  const parsedDraft = usdDraft !== null ? Number(usdDraft.trim()) : null;
  const draftIsEmpty = usdDraft !== null && usdDraft.trim() === "";
  const draftIsInvalid =
    usdDraft !== null &&
    (draftIsEmpty ||
      parsedDraft === null ||
      !Number.isFinite(parsedDraft) ||
      parsedDraft <= 0);

  const rawRatio =
    draftIsInvalid || totalExitUsdt <= 0
      ? 0
      : Math.max(0, Math.min(1, ratio));
  const isFullExit = rawRatio >= FULL_EXIT_RATIO_THRESHOLD;
  const submitRatio = isFullExit ? 1 : rawRatio;

  const estimatedUsdt = totalExitUsdt * submitRatio;
  const soldStakeUsdt = position.totalStakeUsdt * submitRatio;
  const soldPnlUsdt = estimatedUsdt - soldStakeUsdt;
  const soldMaxPayoutUsdt = position.remainingBalanceUsdt * submitRatio;
  const remainingExitUsdt = Math.max(0, totalExitUsdt * (1 - submitRatio));
  const remainingMaxPayoutUsdt = Math.max(
    0,
    position.remainingBalanceUsdt * (1 - submitRatio)
  );
  const maxMult =
    position.totalStakeUsdt > 0
      ? position.initialMaxPayoutUsdt / position.totalStakeUsdt
      : 0;

  const sliderPct =
    submitRatio <= 0 ? 1 : Math.max(1, Math.min(100, Math.round(submitRatio * 100)));
  const sliderProgressPct = ((sliderPct - 1) / 99) * 100;

  const belowMinSell =
    !draftIsInvalid &&
    !isFullExit &&
    totalExitUsdt > 1 &&
    estimatedUsdt < minSellUsd - 1e-6;
  const exceedsMax =
    usdDraft !== null &&
    parsedDraft !== null &&
    Number.isFinite(parsedDraft) &&
    parsedDraft > totalExitUsdt + 0.01;

  const validationError = (() => {
    if (draftIsEmpty) {
      return isZh ? "请输入要卖出的金额" : "Enter an amount to sell";
    }
    if (draftIsInvalid) {
      return isZh ? "卖出金额必须大于 0" : "Sell amount must be greater than 0";
    }
    if (belowMinSell) {
      return isZh
        ? `单次最少卖出 $${minSellUsd.toFixed(2)}`
        : `Minimum partial sell is $${minSellUsd.toFixed(2)}`;
    }
    return null;
  })();

  const showValidationError = Boolean(validationError && usdTouched);
  const canSubmit = !isBusy && !validationError && submitRatio > 0 && totalExitUsdt > 0;

  const showSlippageCard =
    Boolean(slippagePause) &&
    (stage === "SLIPPAGE_CONFIRM" || stage === "EXECUTING");

  useEffect(() => {
    if (!showSlippageCard || !slippagePause) return;
    setNowSec(Math.floor(Date.now() / 1000));
    const id = setInterval(() => {
      setNowSec(Math.floor(Date.now() / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [showSlippageCard, slippagePause]);

  const countdown =
    showSlippageCard && slippagePause
      ? Math.max(
          0,
          slippagePause.rfq.quote.validUntil -
            Math.max(nowSec, Math.floor(Date.now() / 1000))
        )
      : 0;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) {
      dialog.showModal();
    }

    if (!("closedBy" in HTMLDialogElement.prototype)) {
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
        if (!isBusy && pressedOutside && isOutside(e)) {
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
    }
  }, [isBusy]);

  const spec = ASSET_SPECS[position.underlying];
  const dirLabel = position.isUp ? t.bull : t.bear;

  const handleSelectPreset = (nextRatio: number) => {
    setUsdDraft(null);
    setUsdTouched(false);
    setRatio(nextRatio);
    onClearSlippagePause();
  };

  const handleUsdChange = (nextStr: string) => {
    // Allow digits and a single decimal point while typing
    if (!/^\d*\.?\d{0,2}$/.test(nextStr.trim())) return;
    setUsdDraft(nextStr);
    onClearSlippagePause();
    const trimmed = nextStr.trim();
    if (!trimmed) {
      return;
    }
    const val = Number(trimmed);
    if (!Number.isFinite(val) || val <= 0 || totalExitUsdt <= 0) {
      return;
    }
    const nextRatio = Math.min(1, val / totalExitUsdt);
    setRatio(nextRatio >= FULL_EXIT_RATIO_THRESHOLD ? 1 : nextRatio);
  };

  const handleUsdBlur = () => {
    setUsdTouched(true);
    if (usdDraft === null) return;
    const trimmed = usdDraft.trim();
    const val = Number(trimmed);
    if (!trimmed || !Number.isFinite(val) || val <= 0) {
      return;
    }
    if (totalExitUsdt > 0) {
      const clampedRatio = Math.max(0.01, Math.min(1, val / totalExitUsdt));
      setRatio(clampedRatio >= FULL_EXIT_RATIO_THRESHOLD ? 1 : clampedRatio);
    }
    setUsdDraft(null);
  };

  const handleSliderChange = (pct: number) => {
    const clampedPct = Math.max(1, Math.min(100, pct));
    setUsdDraft(null);
    setUsdTouched(false);
    setRatio(clampedPct >= 100 ? 1 : clampedPct / 100);
    onClearSlippagePause();
  };

  const sliderStyle = {
    "--slider-progress": `${sliderProgressPct}%`,
    "--slider-fill-color": "#ffffff",
    "--slider-track-color": "#24282f",
    "--attr-min": "1",
    "--attr-max": "100",
    "--control-value": String(sliderPct),
  } as CSSProperties;

  const displayedUsdValue =
    usdDraft !== null
      ? usdDraft
      : estimatedUsdt > 0
        ? estimatedUsdt.toFixed(2)
        : "0.00";

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      {...({ closedby: isBusy ? "none" : "any" } as Record<string, unknown>)}
      onCancel={(e) => {
        if (isBusy) e.preventDefault();
      }}
      onClose={() => {
        if (dialogRef.current) dialogRef.current.returnValue = "";
        onCloseModal();
      }}
      className="payoff-sheet md:!w-[min(92vw,420px)] md:!max-w-[420px]"
    >
      <div className="flex max-h-[90dvh] flex-col md:max-h-[86dvh]">
        <div aria-hidden="true" className="payoff-sheet-handle" />

        <div className="overflow-y-auto px-5 pt-3 pb-6 sm:px-6 safe-pb space-y-4">
          {/* Header */}
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h1
                id={titleId}
                className="text-[19px] font-bold tracking-[-0.02em] text-white tabular-nums"
              >
                {isZh ? "卖出" : "Sell"} {spec.displaySymbol}{" "}
                <span
                  className={
                    position.isUp ? "text-[#2EC26B]" : "text-[#E85D4A]"
                  }
                >
                  {dirLabel}
                </span>
                {maxMult > 0 ? ` ${maxMult.toFixed(2)}x` : ""}
              </h1>
              <p className="mt-0.5 text-xs text-[#7e8690] tabular-nums">
                {formatStrikePrice(position.startPrice, position.underlying)} →{" "}
                {formatStrikePrice(position.capPrice, position.underlying)} ·{" "}
                {formatExpiryCompact(position.expiry, locale)}
              </p>
            </div>
            <button
              type="button"
              disabled={isBusy}
              aria-label={t.cancel}
              onClick={() => dialogRef.current?.close()}
              className="rounded-full p-1.5 text-[#7e8690] hover:bg-[#24282f] hover:text-white disabled:opacity-40 transition cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>

          {errorMsg && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-2xl bg-[#15171b] border border-[#E85D4A]/35 px-3.5 py-2.5 text-xs text-[#E85D4A]"
            >
              <AlertCircle
                aria-hidden="true"
                className="mt-0.5 h-3.5 w-3.5 shrink-0"
              />
              <span>{errorMsg}</span>
            </div>
          )}

          {/* Slippage Guard View (>1.5% adverse move) vs Option A Custom USD Sell Form */}
          {showSlippageCard && slippagePause ? (
            <div className="space-y-4">
              <div
                role="alert"
                className="rounded-2xl bg-[#15171b] border border-[#E6BA5C]/30 p-4 space-y-2.5"
              >
                <div className="flex items-center justify-between text-xs">
                  <span className="inline-flex items-center gap-2 font-bold text-white">
                    <span
                      aria-hidden="true"
                      className="h-2 w-2 rounded-full bg-[#E6BA5C]"
                    />
                    {t.slippageTitle}
                  </span>
                  <span
                    className={`inline-flex items-center gap-1 font-bold tabular-nums ${
                      countdown === 0 ? "text-[#E85D4A]" : "text-[#E6BA5C]"
                    }`}
                  >
                    <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                    {countdown}s
                  </span>
                </div>

                <div className="text-center pt-1">
                  <div className="text-xs font-semibold text-[#7e8690]">
                    {isZh ? "最新锁定到手" : "Updated firm payout"}
                  </div>
                  <div className="mt-1 text-[38px] font-bold leading-none tracking-[-0.035em] text-white tabular-nums">
                    ${slippagePause.firmUsdt.toFixed(2)}
                  </div>
                  <p className="mt-2 text-xs leading-relaxed text-[#b8bec6] tabular-nums">
                    {t.slippageSellDesc(
                      slippagePause.estimatedUsdt.toFixed(2),
                      slippagePause.firmUsdt.toFixed(2),
                      slippagePause.dropPct.toFixed(2)
                    )}
                  </p>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="space-y-2">
                {countdown === 0 && stage !== "EXECUTING" ? (
                  <button
                    type="button"
                    onClick={() => onInstantSell(submitRatio)}
                    className="flex w-full min-h-[50px] items-center justify-center gap-2 rounded-full bg-white px-5 py-3 text-[15px] font-bold text-black hover:bg-white/90 transition cursor-pointer"
                  >
                    <RefreshCw className="h-4 w-4" aria-hidden="true" />
                    <span>{t.quoteExpiredRefresh}</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={stage === "EXECUTING" || countdown === 0}
                    onClick={onConfirmSlippageClose}
                    className="flex w-full min-h-[50px] items-center justify-center gap-2 rounded-full bg-white px-5 py-3 text-[15px] font-bold text-black hover:bg-white/90 disabled:opacity-50 transition cursor-pointer tabular-nums"
                  >
                    {stage === "EXECUTING" ? (
                      <>
                        <Loader2
                          className="h-4 w-4 animate-spin"
                          aria-hidden="true"
                        />
                        <span>{t.confirmingTx}</span>
                      </>
                    ) : (
                      <>
                        <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                        <span>
                          {isZh
                            ? `按新价卖出 $${slippagePause.firmUsdt.toFixed(2)} · ${countdown}s`
                            : `Sell for $${slippagePause.firmUsdt.toFixed(2)} · ${countdown}s`}
                        </span>
                      </>
                    )}
                  </button>
                )}

                <button
                  type="button"
                  disabled={stage === "EXECUTING"}
                  onClick={() => dialogRef.current?.close()}
                  className="flex w-full min-h-[44px] items-center justify-center rounded-full bg-[#24282f] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#2f343d] disabled:opacity-50 transition cursor-pointer"
                >
                  {t.keepHolding}
                </button>
              </div>
            </div>
          ) : (
            <form
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                setUsdTouched(true);
                if (canSubmit) {
                  onInstantSell(submitRatio);
                }
              }}
              className="space-y-4"
            >
              {/* Option A: Editable USD Cashout Input Box */}
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2 text-xs tabular-nums">
                  <label
                    htmlFor={usdInputId}
                    className="font-semibold text-[#b8bec6]"
                  >
                    {isZh ? "卖出金额" : "Sell amount"}
                  </label>
                  <span id={usdHintId} className="text-[#7e8690]">
                    {isZh ? "当前可卖" : "Available"}{" "}
                    <strong className="font-semibold text-white">
                      ${totalExitUsdt.toFixed(2)}
                    </strong>
                  </span>
                </div>

                <div
                  className={`flex items-center justify-between gap-3 rounded-2xl border bg-[#0b0c0e] px-4 py-3 transition-colors ${
                    showValidationError
                      ? "border-[#E85D4A]"
                      : "border-[#262a31] focus-within:border-white/40"
                  }`}
                >
                  <div className="flex min-w-0 flex-1 items-baseline gap-1">
                    <span
                      aria-hidden="true"
                      className="text-xl font-bold text-[#7e8690]"
                    >
                      $
                    </span>
                    <input
                      id={usdInputId}
                      type="text"
                      inputMode="decimal"
                      disabled={isBusy}
                      value={displayedUsdValue}
                      aria-invalid={showValidationError ? "true" : "false"}
                      aria-describedby={
                        showValidationError
                          ? `${usdHintId} ${usdErrId}`
                          : usdHintId
                      }
                      onFocus={() => {
                        setUsdDraft(
                          estimatedUsdt > 0 ? estimatedUsdt.toFixed(2) : ""
                        );
                      }}
                      onChange={(e) => handleUsdChange(e.target.value)}
                      onBlur={handleUsdBlur}
                      className="w-full min-w-0 bg-transparent text-[28px] font-bold leading-none tracking-[-0.03em] text-white tabular-nums placeholder:text-[#555c66] focus:outline-none disabled:opacity-50"
                      placeholder="0.00"
                    />
                  </div>

                  {submitRatio > 0 && (
                    <div className="shrink-0 text-right tabular-nums">
                      <div
                        className={`text-xs font-bold ${
                          soldPnlUsdt >= 0 ? "text-[#2EC26B]" : "text-[#E85D4A]"
                        }`}
                      >
                        {formatSignedUsd(soldPnlUsdt)}
                      </div>
                      <div className="mt-0.5 text-[11px] font-semibold text-[#7e8690]">
                        {isFullExit
                          ? isZh
                            ? "全部"
                            : "100%"
                          : `${sliderPct}%`}
                      </div>
                    </div>
                  )}
                </div>

                {showValidationError && validationError ? (
                  <p
                    id={usdErrId}
                    className="flex items-center gap-1.5 text-xs text-[#E85D4A]"
                  >
                    <AlertCircle
                      className="h-3.5 w-3.5 shrink-0"
                      aria-hidden="true"
                    />
                    <span>{validationError}</span>
                  </p>
                ) : exceedsMax ? (
                  <p className="text-[11px] text-[#7e8690]">
                    {isZh
                      ? `已按全额估值 $${totalExitUsdt.toFixed(2)} 全仓计算`
                      : `Capped at full exit value ($${totalExitUsdt.toFixed(2)})`}
                  </p>
                ) : null}
              </div>

              {/* Continuous Native Range Slider + 4 Quick Preset Chips */}
              <div className="space-y-2">
                <label htmlFor={sliderId} className="payoff-visually-hidden">
                  {isZh ? "卖出比例" : "Sell percentage"}
                </label>
                <input
                  id={sliderId}
                  type="range"
                  min={1}
                  max={100}
                  step={1}
                  disabled={isBusy || totalExitUsdt <= 0}
                  value={sliderPct}
                  aria-valuetext={`${sliderPct}%, ~$${estimatedUsdt.toFixed(2)}`}
                  style={sliderStyle}
                  onChange={(e) => handleSliderChange(Number(e.target.value))}
                  className="w-full"
                />

                <div
                  className="grid grid-cols-4 gap-1.5"
                  role="group"
                  aria-label={isZh ? "快捷卖出比例" : "Quick sell presets"}
                >
                  {QUICK_PRESET_RATIOS.map((r) => {
                    const active =
                      usdDraft === null &&
                      (r === 1 ? isFullExit : Math.abs(submitRatio - r) < 0.008);
                    return (
                      <button
                        key={r}
                        type="button"
                        disabled={isBusy}
                        aria-pressed={active}
                        onClick={() => handleSelectPreset(r)}
                        className={`min-h-[34px] rounded-full text-xs font-semibold tabular-nums transition cursor-pointer disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white ${
                          active
                            ? "bg-[#24282f] border border-white/25 text-white font-bold"
                            : "bg-[#15171b] border border-transparent text-[#b8bec6] hover:bg-[#1e2229] hover:text-white"
                        }`}
                      >
                        {r === 1 ? "Max" : `${Math.round(r * 100)}%`}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Side-by-Side Comparison: Sell Now + Remaining vs Hold to Settlement */}
              <div className="grid grid-cols-2 gap-2.5">
                <div className="rounded-2xl bg-[#15171b] border border-[#1d2025] p-3 space-y-1 tabular-nums">
                  <div className="text-[11px] font-semibold text-[#7e8690]">
                    {isZh ? "卖出后 + 剩余" : "Sell now + remaining"}
                  </div>
                  <div className="text-xs font-bold text-white">
                    {isZh ? "到手" : "Cash"} ~${estimatedUsdt.toFixed(2)}
                  </div>
                  <div className="text-[11px] text-[#b8bec6]">
                    {!isFullExit && submitRatio > 0
                      ? isZh
                        ? `余仓 ~$${remainingExitUsdt.toFixed(2)} · 封顶 $${remainingMaxPayoutUsdt.toFixed(2)}`
                        : `Left ~$${remainingExitUsdt.toFixed(2)} · Max $${remainingMaxPayoutUsdt.toFixed(2)}`
                      : isZh
                        ? "全部平仓 · 无剩余持仓"
                        : "Full exit · $0 remaining"}
                  </div>
                </div>

                <div className="rounded-2xl bg-[#15171b] border border-[#1d2025] p-3 space-y-1 tabular-nums">
                  <div className="text-[11px] font-semibold text-[#7e8690]">
                    {isZh ? "持有到结算" : "Hold to settlement"}
                  </div>
                  <div className="text-xs font-bold text-[#2EC26B]">
                    {isZh ? "最多" : "Max"} $
                    {position.remainingBalanceUsdt.toFixed(2)}
                  </div>
                  <div className="text-[11px] text-[#b8bec6]">
                    {!isFullExit && submitRatio > 0
                      ? isZh
                        ? `本次减封顶 $${soldMaxPayoutUsdt.toFixed(2)}`
                        : `Selling $${soldMaxPayoutUsdt.toFixed(2)} cap`
                      : isZh
                        ? "最少 $0.00"
                        : "Worst $0.00"}
                  </div>
                </div>
              </div>

              {/* Primary Pure-White CTA + Charcoal Keep Holding */}
              <div className="space-y-2 pt-0.5">
                <button
                  type="submit"
                  disabled={!canSubmit}
                  className={`relative flex w-full min-h-[50px] items-center justify-center gap-2 overflow-hidden rounded-full px-5 py-3 text-[15px] font-bold tracking-[-0.01em] transition cursor-pointer disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white tabular-nums ${
                    isBusy
                      ? "bg-[#15171b] text-white"
                      : "bg-white text-black hover:bg-white/90 active:scale-[0.99]"
                  }`}
                >
                  {isBusy && (
                    <span
                      aria-hidden="true"
                      className="absolute inset-y-0 left-0 w-2/3 bg-[#2EC26B]/22"
                    />
                  )}
                  <span className="relative z-10 inline-flex items-center gap-2">
                    {stage === "QUOTING" ? (
                      <>
                        <Loader2
                          className="h-4 w-4 animate-spin"
                          aria-hidden="true"
                        />
                        <span>{t.fetchingAndSelling}</span>
                      </>
                    ) : stage === "EXECUTING" ? (
                      <>
                        <Loader2
                          className="h-4 w-4 animate-spin"
                          aria-hidden="true"
                        />
                        <span>{t.confirmingTx}</span>
                      </>
                    ) : isFullExit ? (
                      <span>
                        {isZh
                          ? `全部卖出 · 到手约 $${estimatedUsdt.toFixed(2)}`
                          : `Sell All · Get ~$${estimatedUsdt.toFixed(2)}`}
                      </span>
                    ) : (
                      <span>
                        {isZh
                          ? `卖出 $${estimatedUsdt.toFixed(2)} (${sliderPct}%)`
                          : `Sell $${estimatedUsdt.toFixed(2)} (${sliderPct}%)`}
                      </span>
                    )}
                  </span>
                </button>

                <button
                  type="button"
                  autoFocus
                  disabled={isBusy}
                  onClick={() => dialogRef.current?.close()}
                  className="flex w-full min-h-[44px] items-center justify-center rounded-full bg-[#24282f] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#2f343d] disabled:opacity-50 transition cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
                >
                  {t.keepHolding}
                </button>

                <p className="text-center text-[11px] text-[#7e8690]">
                  {isZh
                    ? "一键成交 · 价格变动超 1.5% 会先停下确认"
                    : "Instant exit · Auto-pauses if price moves > 1.5%"}
                </p>
              </div>
            </form>
          )}
        </div>
      </div>
    </dialog>
  );
}

import { useEffect, useId, useRef, useState } from "react";
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
  const soldPnlPct = soldStakeUsdt > 0 ? (soldPnlUsdt / soldStakeUsdt) * 100 : 0;
  const remainingExitUsdt = Math.max(0, totalExitUsdt * (1 - submitRatio));
  const remainingMaxPayoutUsdt = Math.max(
    0,
    position.remainingBalanceUsdt * (1 - submitRatio)
  );
  const maxMult =
    position.totalStakeUsdt > 0
      ? position.initialMaxPayoutUsdt / position.totalStakeUsdt
      : 0;
  const sellPct =
    submitRatio <= 0 ? 0 : Math.max(1, Math.min(100, Math.round(submitRatio * 100)));

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
  const canSubmit =
    !isBusy && !validationError && submitRatio > 0 && totalExitUsdt > 0;

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
    if (!/^\d*\.?\d{0,2}$/.test(nextStr.trim())) return;
    setUsdDraft(nextStr);
    onClearSlippagePause();
    const trimmed = nextStr.trim();
    if (!trimmed) return;
    const val = Number(trimmed);
    if (!Number.isFinite(val) || val <= 0 || totalExitUsdt <= 0) return;
    const nextRatio = Math.min(1, val / totalExitUsdt);
    setRatio(nextRatio >= FULL_EXIT_RATIO_THRESHOLD ? 1 : nextRatio);
  };

  const handleUsdBlur = () => {
    setUsdTouched(true);
    if (usdDraft === null) return;
    const trimmed = usdDraft.trim();
    const val = Number(trimmed);
    if (!trimmed || !Number.isFinite(val) || val <= 0) return;
    if (totalExitUsdt > 0) {
      const clampedRatio = Math.max(0.01, Math.min(1, val / totalExitUsdt));
      setRatio(clampedRatio >= FULL_EXIT_RATIO_THRESHOLD ? 1 : clampedRatio);
    }
    setUsdDraft(null);
  };

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
      className="payoff-sheet md:!w-[min(92vw,410px)] md:!max-w-[410px]"
    >
      <div className="flex max-h-[90dvh] flex-col md:max-h-[86dvh]">
        <div aria-hidden="true" className="payoff-sheet-handle" />

        <div className="overflow-y-auto px-5 pt-3 pb-6 sm:px-6 safe-pb space-y-4">
          {/* Header (Top-right close X replaces Keep holding) */}
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
              autoFocus
              disabled={isBusy}
              aria-label={isZh ? "关闭" : "Close"}
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

          {/* Slippage Guard View (>1.5% adverse move) vs Option B Streamlined Sell Form */}
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
              {/* Unified Amount Card (Exact match with Buy Amount Box, Zero Slider) */}
              <div className="space-y-1.5">
                <div
                  className={`rounded-2xl border bg-[#131519] px-3.5 py-2.5 space-y-2 transition-colors ${
                    showValidationError
                      ? "border-[#E85D4A]"
                      : "border-[#262A31] focus-within:border-white/35"
                  }`}
                >
                  {/* Top Row: Amount Label | Clickable Available Exit Value */}
                  <div className="flex items-center justify-between gap-2 text-[11.5px]">
                    <label
                      htmlFor={usdInputId}
                      className="font-semibold text-[#7e8690]"
                    >
                      {t.stakeInputLabel}
                    </label>
                    <button
                      type="button"
                      id={usdHintId}
                      disabled={isBusy || totalExitUsdt <= 0}
                      onClick={() => handleSelectPreset(1)}
                      aria-label={
                        isZh
                          ? `卖出全部当前可卖金额 $${totalExitUsdt.toFixed(2)}`
                          : `Sell full available value $${totalExitUsdt.toFixed(2)}`
                      }
                      className="group inline-flex items-center gap-1 text-[#7e8690] hover:text-white disabled:opacity-50 disabled:cursor-not-allowed transition cursor-pointer tabular-nums rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/75"
                    >
                      <span>{t.available}</span>
                      <strong className="font-semibold text-[#b8bec6] group-hover:text-white underline decoration-[#3a3f47] group-hover:decoration-white underline-offset-2">
                        ${totalExitUsdt.toFixed(2)}
                      </strong>
                    </button>
                  </div>

                  {/* Middle Row: Full-Width Editable Dollar Input + tUSDT Unit */}
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 flex-1 items-baseline">
                      <span
                        aria-hidden="true"
                        className="mr-1 text-lg font-bold text-[#7e8690]"
                      >
                        $
                      </span>
                      <input
                        id={usdInputId}
                        name="sellUsd"
                        type="text"
                        inputMode="decimal"
                        enterKeyHint="done"
                        autoComplete="off"
                        spellCheck={false}
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
                        className="w-full min-w-[52px] bg-transparent text-[24px] leading-tight font-bold tracking-[-0.025em] text-white tabular-nums placeholder:text-[#555c66] outline-none disabled:opacity-50"
                        placeholder="0.00"
                      />
                    </div>
                    <span className="shrink-0 text-[11px] font-semibold text-[#7e8690]">
                      tUSDT
                    </span>
                  </div>

                  {/* Bottom Row: 25% / 50% / 75% / Max inside the card */}
                  <div
                    role="group"
                    aria-label={isZh ? "快捷卖出比例" : "Quick sell presets"}
                    className="grid grid-cols-4 gap-1.5 border-t border-[#1e2228] pt-2"
                  >
                    {QUICK_PRESET_RATIOS.map((r) => {
                      const active =
                        usdDraft === null &&
                        (r === 1
                          ? isFullExit
                          : Math.abs(submitRatio - r) < 0.008);
                      return (
                        <button
                          key={r}
                          type="button"
                          disabled={isBusy}
                          aria-pressed={active}
                          onClick={() => handleSelectPreset(r)}
                          className={`min-h-[30px] [@media(pointer:coarse)]:min-h-[36px] rounded-full text-[11.5px] font-semibold tabular-nums transition cursor-pointer disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/75 ${
                            active
                              ? "bg-[#262b33] border border-white/24 text-white font-bold"
                              : "bg-[#1b1f25] border border-transparent text-[#b8bec6] hover:bg-[#242932] hover:text-white"
                          }`}
                        >
                          {r === 1 ? t.amountMax : `${Math.round(r * 100)}%`}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {showValidationError && validationError ? (
                  <p
                    id={usdErrId}
                    className="flex items-center gap-1.5 px-1 text-xs text-[#E85D4A]"
                  >
                    <AlertCircle
                      className="h-3.5 w-3.5 shrink-0"
                      aria-hidden="true"
                    />
                    <span>{validationError}</span>
                  </p>
                ) : exceedsMax ? (
                  <p className="px-1 text-[11px] text-[#7e8690]">
                    {isZh
                      ? `已按全额估值 $${totalExitUsdt.toFixed(2)} 全仓计算`
                      : `Capped at full exit value ($${totalExitUsdt.toFixed(2)})`}
                  </p>
                ) : null}
              </div>

              {/* Option B: Minimal 3-Row Semantic Receipt */}
              <dl className="divide-y divide-[#1d2025] border-t border-b border-[#1d2025] text-xs tabular-nums">
                <div className="flex items-center justify-between gap-2 py-2.5">
                  <dt className="font-medium text-[#7e8690]">
                    {isZh ? "预计到手" : "You receive"}
                  </dt>
                  <dd className="text-sm font-bold text-white">
                    ~${estimatedUsdt.toFixed(2)}
                  </dd>
                </div>

                <div className="flex items-center justify-between gap-2 py-2.5">
                  <dt className="font-medium text-[#7e8690]">
                    {isZh ? "本次盈亏" : "Realized PnL"}
                  </dt>
                  <dd
                    className={`font-semibold ${
                      submitRatio <= 0
                        ? "text-[#7e8690]"
                        : soldPnlUsdt >= 0
                          ? "text-[#2EC26B]"
                          : "text-[#E85D4A]"
                    }`}
                  >
                    {submitRatio <= 0
                      ? "$0.00"
                      : `${formatSignedUsd(soldPnlUsdt)} (${soldPnlPct >= 0 ? "+" : ""}${soldPnlPct.toFixed(1)}%)`}
                  </dd>
                </div>

                <div className="flex items-center justify-between gap-2 py-2.5">
                  <dt className="font-medium text-[#7e8690]">
                    {isZh ? "剩余持仓" : "Remaining"}
                  </dt>
                  <dd className="font-semibold text-[#d0d6de]">
                    {isFullExit
                      ? isZh
                        ? "$0 · 全部平仓"
                        : "$0 · Full exit"
                      : isZh
                        ? `~$${remainingExitUsdt.toFixed(2)} · 封顶 $${remainingMaxPayoutUsdt.toFixed(2)}`
                        : `~$${remainingExitUsdt.toFixed(2)} · Max $${remainingMaxPayoutUsdt.toFixed(2)}`}
                  </dd>
                </div>
              </dl>

              {/* Single Pure-White Primary CTA */}
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
                        ? `全部卖出 · ~$${estimatedUsdt.toFixed(2)}`
                        : `Sell All · ~$${estimatedUsdt.toFixed(2)}`}
                    </span>
                  ) : (
                    <span>
                      {isZh
                        ? `卖出 $${estimatedUsdt.toFixed(2)} (${sellPct}%)`
                        : `Sell $${estimatedUsdt.toFixed(2)} (${sellPct}%)`}
                    </span>
                  )}
                </span>
              </button>
            </form>
          )}
        </div>
      </div>
    </dialog>
  );
}

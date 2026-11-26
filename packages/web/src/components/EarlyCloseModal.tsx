import { useEffect, useId, useRef, useState } from "react";
import { CheckCircle2, Clock, Loader2, RefreshCw, X } from "lucide-react";
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

function formatExpiryCompact(expirySec: number, locale: Locale): string {
  const formatted = formatExpiryDateTime(expirySec, locale);
  if (formatted === "--") return formatted;
  return locale === "zh" ? `${formatted} 结算` : formatted;
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
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [ratio, setRatio] = useState(1);
  const [nowSec, setNowSec] = useState<number>(() =>
    Math.floor(Date.now() / 1000)
  );

  const isBusy = stage === "QUOTING" || stage === "EXECUTING";
  const estimatedUsdt = position.indicativeExitUsdt * ratio;
  const soldStakeUsdt = position.totalStakeUsdt * ratio;
  const soldPnlUsdt = estimatedUsdt - soldStakeUsdt;
  const remainingStakeUsdt = position.totalStakeUsdt * (1 - ratio);
  const remainingMaxPayoutUsdt = position.remainingBalanceUsdt * (1 - ratio);
  const maxMult =
    position.totalStakeUsdt > 0
      ? position.initialMaxPayoutUsdt / position.totalStakeUsdt
      : 0;

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
  const pctLabel =
    ratio === 1
      ? isZh
        ? "全部"
        : "100%"
      : `${Math.round(ratio * 100)}%`;

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
      className="payoff-sheet"
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
                {isZh ? "卖出" : "Sell"} {spec.displaySymbol} {dirLabel}
                {maxMult > 0 ? ` ${maxMult.toFixed(2)}x` : ""}
              </h1>
              <p className="mt-0.5 text-xs text-[#7e8690] tabular-nums">
                {isZh ? "投入" : "Stake"} ${position.totalStakeUsdt.toFixed(2)}{" "}
                · {isZh ? "现值" : "Now"} $
                {position.indicativeExitUsdt.toFixed(2)} ·{" "}
                {formatExpiryCompact(position.expiry, locale)}
              </p>
              <p className="mt-0.5 text-[11px] text-[#7e8690] tabular-nums">
                {formatStrikePrice(position.startPrice, position.underlying)} →{" "}
                {formatStrikePrice(position.capPrice, position.underlying)}
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

          {/* Ratio Pills: 25% / 50% / All */}
          <div className="flex items-center gap-3">
            <span className="text-xs font-semibold text-[#7e8690] shrink-0">
              {isZh ? "卖多少" : "Amount"}
            </span>
            <div
              className="grid flex-1 grid-cols-3 gap-1.5"
              role="group"
              aria-label={isZh ? "选择卖出比例" : "Select sell ratio"}
            >
              {[0.25, 0.5, 1].map((r) => {
                const active = ratio === r;
                return (
                  <button
                    key={r}
                    type="button"
                    disabled={isBusy}
                    aria-pressed={active}
                    onClick={() => {
                      setRatio(r);
                      onClearSlippagePause();
                    }}
                    className={`h-9 rounded-full text-xs font-semibold transition cursor-pointer disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white ${
                      active
                        ? "bg-[#24282f] border border-white/22 text-white font-bold"
                        : "bg-[#15171b] border border-transparent text-[#b8bec6] hover:bg-[#1e2229]"
                    }`}
                  >
                    {r === 1
                      ? isZh
                        ? "全部"
                        : "All"
                      : `${Math.round(r * 100)}%`}
                  </button>
                );
              })}
            </div>
          </div>

          {errorMsg && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-2xl bg-[#15171b] border border-[#E85D4A]/35 px-3.5 py-2.5 text-xs text-[#E85D4A]"
            >
              <span
                aria-hidden="true"
                className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[#E85D4A]"
              />
              <span>{errorMsg}</span>
            </div>
          )}

          {/* Slippage Guard View (>1.5% adverse move) vs Normal Sell View */}
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
                    onClick={() => onInstantSell(ratio)}
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
            <div className="space-y-4">
              {/* 38px Centered Estimated Payout */}
              <div className="py-2 text-center">
                <div className="text-xs font-semibold text-[#7e8690]">
                  {isZh ? "现在到手约" : "Estimated payout now"}
                </div>
                <div className="mt-1 text-[38px] font-bold leading-none tracking-[-0.035em] text-white tabular-nums">
                  ${estimatedUsdt.toFixed(2)}
                </div>
                <div
                  className={`mt-1.5 text-[13px] font-bold tabular-nums ${
                    soldPnlUsdt >= 0 ? "text-[#2EC26B]" : "text-[#E85D4A]"
                  }`}
                >
                  {isZh
                    ? soldPnlUsdt >= 0
                      ? `这部分赚 +$${soldPnlUsdt.toFixed(2)}`
                      : `这部分亏 −$${Math.abs(soldPnlUsdt).toFixed(2)}`
                    : soldPnlUsdt >= 0
                      ? `+$${soldPnlUsdt.toFixed(2)} on sold portion`
                      : `−$${Math.abs(soldPnlUsdt).toFixed(2)} on sold portion`}
                </div>
              </div>

              {/* Side-by-Side Comparison: Sell Now + Remaining vs Hold to Settlement */}
              <div className="grid grid-cols-2 gap-2.5">
                <div className="rounded-2xl bg-[#15171b] border border-[#1d2025] p-3 space-y-1">
                  <div className="text-[11px] font-semibold text-[#7e8690]">
                    {isZh ? "卖出后 + 剩余" : "Sell now + remaining"}
                  </div>
                  <div className="text-xs font-bold text-white tabular-nums">
                    {isZh ? "到手" : "Cash"} ~${estimatedUsdt.toFixed(2)}
                  </div>
                  <div className="text-[11.5px] text-[#b8bec6] tabular-nums">
                    {ratio < 1
                      ? isZh
                        ? `余本 $${remainingStakeUsdt.toFixed(2)} · 封顶 $${remainingMaxPayoutUsdt.toFixed(2)}`
                        : `Left $${remainingStakeUsdt.toFixed(2)} · Cap $${remainingMaxPayoutUsdt.toFixed(2)}`
                      : isZh
                        ? "全部平仓 · 无剩余持仓"
                        : "Full exit · $0 remaining"}
                  </div>
                </div>

                <div className="rounded-2xl bg-[#15171b] border border-[#1d2025] p-3 space-y-1">
                  <div className="text-[11px] font-semibold text-[#7e8690]">
                    {isZh ? "持有到结算" : "Hold to settlement"}
                  </div>
                  <div className="text-xs font-bold text-[#2EC26B] tabular-nums">
                    {isZh ? "最多" : "Best"} $
                    {position.remainingBalanceUsdt.toFixed(2)}
                  </div>
                  <div className="text-[11.5px] text-[#b8bec6] tabular-nums">
                    {isZh ? "最少 $0.00" : "Worst $0.00"}
                  </div>
                </div>
              </div>

              {/* Primary Pure-White CTA + Charcoal Keep Holding */}
              <div className="space-y-2 pt-1">
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => onInstantSell(ratio)}
                  className={`relative flex w-full min-h-[50px] items-center justify-center gap-2 overflow-hidden rounded-full px-5 py-3 text-[15px] font-bold tracking-[-0.01em] transition cursor-pointer disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white tabular-nums ${
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
                    ) : (
                      <span>
                        {isZh
                          ? `卖出 ${pctLabel} · 拿回约 $${estimatedUsdt.toFixed(2)}`
                          : `Sell ${pctLabel} · Get ~$${estimatedUsdt.toFixed(2)}`}
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
            </div>
          )}
        </div>
      </div>
    </dialog>
  );
}

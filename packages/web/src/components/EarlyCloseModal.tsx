import { useEffect, useId, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Loader2,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";
import type { CloseRfqResponse, PositionView } from "@payoff/shared";
import { getCopy, type Locale } from "../lib/i18n";
import { UsdtIcon } from "./PayoffMark";

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

interface Props {
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
}: Props) {
  const t = getCopy(locale);
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [ratio, setRatio] = useState(1);
  const [nowSec, setNowSec] = useState<number>(() =>
    Math.floor(Date.now() / 1000)
  );

  const isBusy = stage === "QUOTING" || stage === "EXECUTING";
  const estimatedUsdt = position.indicativeExitUsdt * ratio;
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
      className="m-auto w-full max-w-md rounded-t-2xl sm:rounded-2xl bg-white p-6 shadow-2xl border border-[#e2e5e8] space-y-5 text-[#14202a]"
    >
      <div className="flex items-center justify-between">
        <div>
          <h1 id={titleId} className="text-lg font-bold text-[#14202a]">
            {t.earlyCloseTitle}
          </h1>
          <p className="text-xs text-[#667080] mt-0.5 tabular-nums">
            {position.underlying} {position.isUp ? t.bull : t.bear} · $
            {position.startPrice.toLocaleString()} → $
            {position.capPrice.toLocaleString()}
          </p>
        </div>
        <button
          type="button"
          disabled={isBusy}
          aria-label={t.cancel}
          onClick={() => dialogRef.current?.close()}
          className="rounded-lg p-1.5 text-[#667080] hover:bg-[#eef0f2] hover:text-[#14202a] disabled:opacity-50 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#14202a]"
        >
          <X className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>

      {/* Sell Ratio Controls */}
      <div>
        <div className="mb-2 text-xs font-semibold text-[#667080]">
          {t.chooseSellRatio}
        </div>
        <div
          className="grid grid-cols-3 gap-2"
          role="group"
          aria-label={t.chooseSellRatio}
        >
          {[0.25, 0.5, 1].map((r) => (
            <button
              key={r}
              type="button"
              disabled={isBusy}
              aria-pressed={ratio === r}
              onClick={() => {
                setRatio(r);
                onClearSlippagePause();
              }}
              className={`min-h-[40px] rounded-lg py-2 text-xs font-semibold transition cursor-pointer disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#14202a] ${
                ratio === r
                  ? "bg-[#14202a] text-white"
                  : "bg-[#eef0f2] text-[#3a4552] hover:bg-[#e2e5e8]"
              }`}
            >
              {r === 1 ? t.sellAll : t.sellPct(r * 100)}
            </button>
          ))}
        </div>
      </div>

      {errorMsg && (
        <div
          role="alert"
          className="rounded-lg bg-[#fbeeea] px-3.5 py-2.5 text-xs font-medium text-[#b54134]"
        >
          {errorMsg}
        </div>
      )}

      {/* Slippage Circuit Breaker View (>1.5% adverse move) vs Seamless Indicative View */}
      {(stage === "SLIPPAGE_CONFIRM" || stage === "EXECUTING") &&
      slippagePause ? (
        <div className="space-y-4">
          <div
            role="alert"
            className="rounded-xl bg-[#fbf3dd]/60 border border-[#e6cf8b] p-4 space-y-2.5"
          >
            <div className="flex items-center justify-between text-xs">
              <span className="inline-flex items-center gap-1.5 font-semibold text-[#8a6410]">
                <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
                {t.slippageTitle}
              </span>
              <span
                className={`flex items-center gap-1 font-bold tabular-nums ${
                  countdown === 0 ? "text-[#b54134]" : "text-[#8a6410]"
                }`}
              >
                <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                {countdown}s
              </span>
            </div>

            <div className="text-center space-y-1 pt-1">
              <div className="text-xs text-[#667080]">{t.instantReceive}</div>
              <div className="inline-flex items-center justify-center gap-2 text-3xl font-bold text-[#0e7c72] tabular-nums">
                <UsdtIcon size={24} />
                {slippagePause.firmUsdt.toFixed(2)}{" "}
                <span className="text-base font-semibold">USDT</span>
              </div>
              <p className="text-[11px] text-[#3a4552] leading-relaxed tabular-nums">
                {t.slippageSellDesc(
                  slippagePause.estimatedUsdt.toFixed(2),
                  slippagePause.firmUsdt.toFixed(2),
                  slippagePause.dropPct.toFixed(2)
                )}
              </p>
            </div>
          </div>

          <div className="flex items-start gap-2 rounded-xl bg-[#f7f8f9] border border-[#e2e5e8] px-3.5 py-2.5 text-[11px] text-[#667080]">
            <ShieldCheck
              className="mt-0.5 h-4 w-4 shrink-0 text-[#0e7c72]"
              aria-hidden="true"
            />
            <span>
              {t.fallbackGuarantee(
                position.expiryIso.slice(0, 16).replace("T", " ")
              )}
            </span>
          </div>

          <div className="flex gap-2">
            {countdown === 0 && stage !== "EXECUTING" ? (
              <button
                type="button"
                onClick={() => onInstantSell(ratio)}
                className="flex-1 min-h-[48px] rounded-lg bg-[#14202a] py-3 text-sm font-semibold text-white hover:bg-[#000a12] cursor-pointer flex items-center justify-center gap-2"
              >
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
                <span>{t.quoteExpiredRefresh}</span>
              </button>
            ) : (
              <button
                type="button"
                disabled={stage === "EXECUTING" || countdown === 0}
                onClick={onConfirmSlippageClose}
                className="flex-1 min-h-[48px] rounded-lg bg-[#14202a] py-3 text-sm font-semibold text-white hover:bg-[#000a12] disabled:opacity-50 cursor-pointer flex items-center justify-center gap-2"
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
                      {t.slippageConfirmSellCta(
                        slippagePause.firmUsdt.toFixed(2)
                      )}
                    </span>
                  </>
                )}
              </button>
            )}
            <button
              type="button"
              disabled={stage === "EXECUTING"}
              onClick={() => dialogRef.current?.close()}
              className="min-h-[48px] rounded-lg border border-[#c8ccd1] px-4 py-3 text-xs font-semibold text-[#3a4552] hover:bg-[#f7f8f9] disabled:opacity-50 cursor-pointer"
            >
              {t.keepHolding}
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="rounded-xl bg-[#f7f8f9] border border-[#e2e5e8] p-4 text-center space-y-1">
            <div className="text-xs text-[#667080]">
              {t.indicativeExitTitle}
            </div>
            <div className="inline-flex items-center justify-center gap-2 text-3xl font-bold text-[#14202a] tabular-nums">
              <UsdtIcon size={24} />
              ~{estimatedUsdt.toFixed(2)}{" "}
              <span className="text-base font-semibold">USDT</span>
            </div>
            <div className="text-[11px] text-[#667080]">
              {t.indicativeExitSubSeamless}
            </div>
          </div>

          <div className="flex items-start gap-2 rounded-xl bg-[#f7f8f9] border border-[#e2e5e8] px-3.5 py-2.5 text-[11px] text-[#667080]">
            <ShieldCheck
              className="mt-0.5 h-4 w-4 shrink-0 text-[#0e7c72]"
              aria-hidden="true"
            />
            <span>
              {t.fallbackGuarantee(
                position.expiryIso.slice(0, 16).replace("T", " ")
              )}
            </span>
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              disabled={isBusy}
              onClick={() => onInstantSell(ratio)}
              className="flex-1 min-h-[48px] rounded-lg bg-[#14202a] py-3 text-sm font-semibold text-white hover:bg-[#000a12] disabled:opacity-50 cursor-pointer flex items-center justify-center gap-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#14202a]"
            >
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
                <span>{t.confirmSellApprox(estimatedUsdt.toFixed(2))}</span>
              )}
            </button>
            <button
              type="button"
              autoFocus
              onClick={() => dialogRef.current?.close()}
              disabled={isBusy}
              className="min-h-[48px] rounded-lg border border-[#c8ccd1] px-4 py-3 text-xs font-semibold text-[#3a4552] hover:bg-[#f7f8f9] disabled:opacity-50 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#14202a]"
            >
              {t.keepHolding}
            </button>
          </div>
        </div>
      )}
    </dialog>
  );
}

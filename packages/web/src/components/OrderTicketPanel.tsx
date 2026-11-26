import { useEffect, useId, useState } from "react";
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  CheckCircle2,
  Clock,
  Loader2,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import {
  ASSET_SPECS,
  type Direction,
  type FixedGridMeta,
  type OpenRfqResponse,
  type TicketSummary,
} from "@payoff/shared";
import { formatStrikeNumber, formatStrikePrice } from "../lib/format";
import { getCopy, type Locale } from "../lib/i18n";
import { UsdtIcon } from "./PayoffMark";

export type InstantBuyStage =
  | "IDLE"
  | "APPROVING"
  | "QUOTING"
  | "SLIPPAGE_CONFIRM"
  | "FILLING"
  | "SUCCESS";

export interface SlippagePauseState {
  rfq: OpenRfqResponse;
  previewMaxPayoutUsdt: number;
  firmMaxPayoutUsdt: number;
  dropPct: number;
}

interface Props {
  locale: Locale;
  direction: Direction;
  onChangeDirection: (dir: Direction) => void;
  tiers: TicketSummary[];
  selectedTargetKey: string;
  onSelectTarget: (ticket: TicketSummary) => void;
  ticket: TicketSummary;
  grid?: FixedGridMeta;
  stakeUsdt: number;
  onChangeStake: (val: number) => void;
  walletConnected: boolean;
  usdtBalance: number;
  isShelfSynced?: boolean;
  quotingPaused?: boolean;
  rwaPaused?: boolean;
  rwaPauseReason?: string | null;
  stage: InstantBuyStage;
  slippagePause?: SlippagePauseState;
  txHash?: string;
  errorMsg?: string;
  onOpenWallet: () => void;
  onInstantBuy: () => void;
  onConfirmSlippageQuote: () => void;
  onRefreshSlippageQuote: () => void;
  onCancelFlow: () => void;
  onGoToPositions: () => void;
}

const PRESETS = [10, 20, 50, 100];

function getTargetKey(t: Pick<TicketSummary, "lowerStrike" | "upperStrike">) {
  return `${t.lowerStrike}-${t.upperStrike}`;
}

export function OrderTicketPanel({
  locale,
  direction,
  onChangeDirection,
  tiers,
  selectedTargetKey,
  onSelectTarget,
  ticket,
  grid,
  stakeUsdt,
  onChangeStake,
  walletConnected,
  usdtBalance,
  isShelfSynced = true,
  quotingPaused = false,
  rwaPaused = false,
  rwaPauseReason = null,
  stage,
  slippagePause,
  txHash,
  errorMsg,
  onOpenWallet,
  onInstantBuy,
  onConfirmSlippageQuote,
  onRefreshSlippageQuote,
  onCancelFlow,
  onGoToPositions,
}: Props) {
  const t = getCopy(locale);
  const stakeInputId = useId();
  const stakeHintId = useId();
  const formHeadingId = useId();

  const [stakeText, setStakeText] = useState<string>(String(stakeUsdt));
  const [nowSec, setNowSec] = useState<number>(() =>
    Math.floor(Date.now() / 1000)
  );

  useEffect(() => {
    setStakeText((prev) =>
      Number(prev) === stakeUsdt ? prev : String(stakeUsdt)
    );
  }, [stakeUsdt]);

  const showSlippageCard =
    Boolean(slippagePause) &&
    (stage === "SLIPPAGE_CONFIRM" || stage === "FILLING");

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

  const activeTicket =
    showSlippageCard && slippagePause ? slippagePause.rfq.ticket : ticket;
  const isBull = direction === "BULL";
  const dataColor = isBull ? "text-[#0e7c72]" : "text-[#b54134]";
  const anchorStartPrice = grid?.anchorStartPrice ?? activeTicket.startPrice;

  const isBusy =
    stage === "APPROVING" || stage === "QUOTING" || stage === "FILLING";
  const parsedStakeText = Number(stakeText);
  const invalidStake =
    stakeText.trim() === "" ||
    !Number.isFinite(parsedStakeText) ||
    parsedStakeText < 1 ||
    !Number.isFinite(stakeUsdt) ||
    stakeUsdt < 1;
  const insufficientBalance = walletConnected && usdtBalance < stakeUsdt;
  const canBuy =
    walletConnected &&
    isShelfSynced &&
    !quotingPaused &&
    activeTicket.guardrails.valid &&
    !invalidStake &&
    !insufficientBalance;

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!walletConnected) {
      onOpenWallet();
      return;
    }
    if (stage === "SLIPPAGE_CONFIRM") {
      if (countdown === 0) {
        onRefreshSlippageQuote();
      } else {
        onConfirmSlippageQuote();
      }
      return;
    }
    if (canBuy && !isBusy) {
      onInstantBuy();
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      aria-labelledby={formHeadingId}
      noValidate
      className="rounded-2xl border border-[#e2e5e8] bg-white p-5 shadow-[0_4px_12px_rgba(20,32,42,0.06)] space-y-5 lg:sticky lg:top-20"
    >
      <h2 id={formHeadingId} className="sr-only">
        {ASSET_SPECS[activeTicket.underlying].displaySymbol}{" "}
        {isBull ? t.bull : t.bear}
      </h2>

      {/* 1. Large Top UP / DOWN Toggle */}
      <div
        className="grid grid-cols-2 gap-2"
        role="group"
        aria-label={isBull ? t.upButtonLabel : t.downButtonLabel}
      >
        <button
          type="button"
          disabled={isBusy}
          aria-pressed={isBull}
          onClick={() => onChangeDirection("BULL")}
          className={`min-h-[48px] flex items-center justify-center gap-1.5 rounded-xl px-3 py-2.5 text-sm font-bold transition cursor-pointer disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#14202a] ${
            isBull
              ? "bg-[#0e7c72] text-white shadow-xs"
              : "bg-[#eef0f2] text-[#3a4552] hover:bg-[#e2e5e8] hover:text-[#14202a]"
          }`}
        >
          <ArrowUpRight className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{t.upButtonLabel}</span>
        </button>

        <button
          type="button"
          disabled={isBusy}
          aria-pressed={!isBull}
          onClick={() => onChangeDirection("BEAR")}
          className={`min-h-[48px] flex items-center justify-center gap-1.5 rounded-xl px-3 py-2.5 text-sm font-bold transition cursor-pointer disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#14202a] ${
            !isBull
              ? "bg-[#b54134] text-white shadow-xs"
              : "bg-[#eef0f2] text-[#3a4552] hover:bg-[#e2e5e8] hover:text-[#14202a]"
          }`}
        >
          <ArrowDownRight className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{t.downButtonLabel}</span>
        </button>
      </div>

      {/* 2. 2x2 Fixed Target Pill Grid + Fixed Start Line Hint */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs">
          <span className="font-semibold text-[#14202a]">
            {t.selectTargetTitle}
          </span>
          <span className="text-[11px] font-medium text-[#667080]">
            {t.maxMultiplier}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2">
          {tiers.slice(0, 4).map((item) => {
            const key = getTargetKey(item);
            const selected = key === selectedTargetKey;
            const capArrow = isBull ? "≥" : "≤";
            return (
              <button
                key={key}
                type="button"
                disabled={isBusy}
                aria-pressed={selected}
                onClick={() => onSelectTarget(item)}
                className={`min-h-[60px] flex flex-col items-start justify-between rounded-xl border px-3 py-2.5 text-left transition cursor-pointer disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#14202a] ${
                  selected
                    ? "border-[#14202a] bg-[#14202a] text-white shadow-xs"
                    : "border-[#e2e5e8] bg-[#f7f8f9] text-[#14202a] hover:border-[#c8ccd1] hover:bg-white"
                }`}
              >
                <span className="text-sm font-bold tabular-nums tracking-tight whitespace-nowrap">
                  {capArrow} {formatStrikePrice(item.capPrice, item.underlying)}
                </span>
                <div className="mt-1 flex w-full items-center justify-between gap-1.5">
                  <span
                    className={`text-xs font-bold tabular-nums whitespace-nowrap ${
                      selected
                        ? isBull
                          ? "text-[#8de4d8]"
                          : "text-[#fcbcb4]"
                        : dataColor
                    }`}
                  >
                    {item.maxMultiplier.toFixed(2)}x
                  </span>
                  {item.isSharedCenterPool && (
                    <span
                      className={`rounded px-1.5 py-0.5 text-[9px] font-semibold leading-none whitespace-nowrap shrink-0 ${
                        selected
                          ? "bg-white/15 text-white/90"
                          : "bg-[#e9f3f1] text-[#0e7c72]"
                      }`}
                    >
                      {t.sharedPoolTag}
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>

        <p className="text-[11px] leading-snug text-[#667080] tabular-nums">
          {t.fixedStartLineHint(
            formatStrikeNumber(anchorStartPrice, activeTicket.underlying),
            isBull
          )}
        </p>
      </div>

      {/* 3. Stake Input + Quick Presets */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs">
          <label htmlFor={stakeInputId} className="font-semibold text-[#14202a]">
            {t.buyAmount}
          </label>
          {walletConnected && (
            <span
              id={stakeHintId}
              className="inline-flex items-center gap-1 text-[#667080] tabular-nums"
            >
              {t.available} <UsdtIcon size={13} /> {usdtBalance.toFixed(2)} USDT
            </span>
          )}
        </div>

        <div className="relative">
          <input
            id={stakeInputId}
            name="stakeUsdt"
            type="text"
            inputMode="decimal"
            enterKeyHint="done"
            autoComplete="off"
            disabled={isBusy}
            value={stakeText}
            aria-invalid={invalidStake || insufficientBalance}
            aria-describedby={walletConnected ? stakeHintId : undefined}
            onChange={(e) => {
              const raw = e.target.value
                .replace(/[^\d.]/g, "")
                .replace(/(\..*)\./g, "$1");
              setStakeText(raw);
              const parsed = Number(raw);
              if (Number.isFinite(parsed) && parsed >= 1) {
                onChangeStake(Math.min(50000, Math.round(parsed * 100) / 100));
              }
            }}
            onBlur={() => {
              const parsed = Number(stakeText);
              const clamped =
                Number.isFinite(parsed) && parsed >= 1
                  ? Math.min(50000, Math.round(parsed * 100) / 100)
                  : 10;
              setStakeText(String(clamped));
              if (clamped !== stakeUsdt) {
                onChangeStake(clamped);
              }
            }}
            className="w-full min-h-[48px] rounded-xl border border-[#c8ccd1] bg-[#f7f8f9] px-4 py-2.5 pr-24 text-base sm:text-lg font-bold text-[#14202a] tabular-nums focus:border-[#14202a] focus:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#14202a] disabled:opacity-60 transition"
          />
          <span className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 inline-flex items-center gap-1.5 text-xs font-semibold text-[#3a4552]">
            <UsdtIcon size={16} />
            USDT
          </span>
        </div>

        <div className="grid grid-cols-4 gap-2">
          {PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              disabled={isBusy}
              aria-pressed={stakeUsdt === p}
              onClick={() => {
                setStakeText(String(p));
                onChangeStake(p);
              }}
              className={`min-h-[36px] rounded-lg py-1.5 text-xs font-semibold tabular-nums transition cursor-pointer disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#14202a] ${
                stakeUsdt === p
                  ? "bg-[#14202a] text-white"
                  : "bg-[#eef0f2] text-[#3a4552] hover:bg-[#e2e5e8]"
              }`}
            >
              ${p}
            </button>
          ))}
        </div>
      </div>

      {/* 4. Concise Summary Receipt */}
      <div className="space-y-2.5 border-t border-[#eef0f2] pt-4 text-xs">
        <div className="flex items-center justify-between">
          <span className="text-[#667080]">{t.breakevenCompactLabel}</span>
          <span className="font-semibold text-[#14202a] tabular-nums">
            {formatStrikePrice(
              activeTicket.breakevenPrice,
              activeTicket.underlying
            )}{" "}
            ({activeTicket.breakevenPct >= 0 ? "+" : ""}
            {activeTicket.breakevenPct.toFixed(2)}%)
          </span>
        </div>

        {activeTicket.flatPayoutUsdt > 0 && (
          <div className="flex items-center justify-between">
            <span className="text-[#667080]">{t.flatReturnCompactLabel}</span>
            <span className="font-semibold text-[#0e7c72] tabular-nums">
              {activeTicket.flatPayoutUsdt.toFixed(2)} USDT (
              {activeTicket.flatReturnPct.toFixed(0)}%)
            </span>
          </div>
        )}

        <div className="flex items-center justify-between rounded-xl bg-[#f7f8f9] border border-[#e2e5e8] px-3.5 py-3">
          <div>
            <div className="text-[11px] font-semibold text-[#667080]">
              {t.toWinLabel}
            </div>
            <div className="text-[11px] text-[#667080] tabular-nums">
              {activeTicket.maxMultiplier.toFixed(2)}x ·{" "}
              {formatStrikePrice(
                activeTicket.fullPayoutPrice,
                activeTicket.underlying
              )}
            </div>
          </div>
          <div
            className={`inline-flex items-center gap-1.5 text-2xl font-bold tracking-tight tabular-nums ${dataColor}`}
          >
            <UsdtIcon size={20} />
            <span>{activeTicket.maxPayoutUsdt.toFixed(2)}</span>
            <span className="text-xs font-semibold text-[#667080]">USDT</span>
          </div>
        </div>
      </div>

      {quotingPaused && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-[#f1ccc6] bg-[#fbeeea] px-3.5 py-2.5 text-xs font-medium text-[#b54134]"
        >
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            {rwaPaused
              ? t.rwaBlackoutPausedNotice(rwaPauseReason)
              : t.quotingPausedNotice}
          </span>
        </div>
      )}

      {errorMsg && (
        <div
          role="alert"
          className="rounded-lg bg-[#fbeeea] px-3.5 py-2.5 text-xs font-medium text-[#b54134]"
        >
          {errorMsg}
        </div>
      )}

      {/* 5. Seamless 1-Click Primary CTA / Slippage Circuit-Breaker / Success */}
      {stage === "SUCCESS" && txHash ? (
        <div
          role="status"
          aria-live="polite"
          className="rounded-xl bg-[#e9f3f1] p-4 space-y-3"
        >
          <div className="flex items-center gap-2 text-sm font-semibold text-[#0e7c72]">
            <CheckCircle2 className="h-5 w-5 shrink-0" aria-hidden="true" />
            <span>{t.buySuccess}</span>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onGoToPositions}
              className="flex-1 min-h-[44px] rounded-lg bg-[#14202a] py-2.5 text-xs font-semibold text-white hover:bg-[#000a12] cursor-pointer"
            >
              {t.viewPositions}
            </button>
            <button
              type="button"
              onClick={onCancelFlow}
              className="min-h-[44px] rounded-lg border border-[#c8ccd1] bg-white px-4 py-2.5 text-xs font-semibold text-[#14202a] hover:bg-[#f7f8f9] cursor-pointer"
            >
              {t.continueTrading}
            </button>
          </div>
        </div>
      ) : (stage === "SLIPPAGE_CONFIRM" || stage === "FILLING") &&
        slippagePause ? (
        <div
          role="alert"
          className="rounded-xl border border-[#e6cf8b] bg-[#fbf3dd]/60 p-4 space-y-3"
        >
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="flex items-center gap-1.5 font-semibold text-[#8a6410]">
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
              {t.slippageTitle}
            </span>
            <span
              className={`flex items-center gap-1 font-bold tabular-nums shrink-0 ${
                countdown === 0 ? "text-[#b54134]" : "text-[#8a6410]"
              }`}
            >
              <Clock className="h-3.5 w-3.5" aria-hidden="true" />
              {countdown}s
            </span>
          </div>

          <p className="text-xs leading-relaxed text-[#3a4552] tabular-nums">
            {t.slippageBuyDesc(
              slippagePause.previewMaxPayoutUsdt.toFixed(2),
              slippagePause.firmMaxPayoutUsdt.toFixed(2),
              slippagePause.dropPct.toFixed(2)
            )}
          </p>

          <div className="flex gap-2">
            {countdown === 0 && stage !== "FILLING" ? (
              <button
                type="submit"
                className="flex-1 min-h-[44px] rounded-lg bg-[#14202a] px-3 py-2.5 text-xs font-semibold text-white hover:bg-[#000a12] cursor-pointer flex items-center justify-center gap-1.5"
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                <span>{t.quoteExpiredRefresh}</span>
              </button>
            ) : (
              <button
                type="submit"
                disabled={stage === "FILLING"}
                className="flex-1 min-h-[44px] rounded-lg bg-[#14202a] px-3 py-2.5 text-xs font-semibold text-white hover:bg-[#000a12] disabled:opacity-60 cursor-pointer flex items-center justify-center gap-1.5"
              >
                {stage === "FILLING" ? (
                  <>
                    <Loader2
                      className="h-3.5 w-3.5 animate-spin"
                      aria-hidden="true"
                    />
                    <span>{t.openingWallet}</span>
                  </>
                ) : (
                  <span>
                    {t.slippageConfirmBuyCta(
                      slippagePause.firmMaxPayoutUsdt.toFixed(2)
                    )}
                  </span>
                )}
              </button>
            )}
            <button
              type="button"
              disabled={stage === "FILLING"}
              onClick={onCancelFlow}
              className="min-h-[44px] rounded-lg border border-[#c8ccd1] bg-white px-3.5 py-2.5 text-xs font-semibold text-[#3a4552] hover:bg-[#f7f8f9] disabled:opacity-50 cursor-pointer"
            >
              {t.cancel}
            </button>
          </div>
        </div>
      ) : !walletConnected ? (
        <button
          type="button"
          onClick={onOpenWallet}
          className="flex w-full min-h-[48px] items-center justify-center gap-2 rounded-xl bg-[#14202a] py-3.5 text-sm font-semibold text-white transition hover:bg-[#000a12] cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#14202a]"
        >
          <Wallet className="h-4 w-4" aria-hidden="true" />
          <span>{t.connectToBuy}</span>
        </button>
      ) : (
        <div className="space-y-2">
          <button
            type="submit"
            disabled={!canBuy || isBusy}
            className="flex w-full min-h-[48px] items-center justify-center gap-2 rounded-xl bg-[#14202a] py-3.5 text-sm font-semibold text-white transition hover:bg-[#000a12] disabled:cursor-not-allowed disabled:bg-[#e2e5e8] disabled:text-[#667080] cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#14202a]"
          >
            {stage === "APPROVING" ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                <span>{t.approvingUsdt}</span>
              </>
            ) : stage === "QUOTING" ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                <span>{t.lockingBestPrice}</span>
              </>
            ) : stage === "FILLING" ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                <span>{t.openingWallet}</span>
              </>
            ) : quotingPaused ? (
              rwaPaused ? (
                t.rwaQuotingPausedCta
              ) : (
                t.quotingPausedCta
              )
            ) : insufficientBalance ? (
              t.insufficientUsdt
            ) : !activeTicket.guardrails.valid ? (
              t.adjustRangeFirst
            ) : (
              t.buyOneClickCta(isBull ? t.bull : t.bear, stakeUsdt)
            )}
          </button>

          <div className="flex items-center justify-center gap-1.5 text-[11px] text-[#667080]">
            <ShieldCheck
              className="h-3.5 w-3.5 text-[#0e7c72] shrink-0"
              aria-hidden="true"
            />
            <span>{t.instantRfqFootNote}</span>
          </div>
        </div>
      )}

      {/* 6. Subtle Bottom Block RFQ Coming Soon Placeholder */}
      <div className="border-t border-[#eef0f2] pt-3 text-center text-[11px] font-medium text-[#667080]">
        {t.blockRfqComingSoon}
      </div>
    </form>
  );
}

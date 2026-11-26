import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  CheckCircle2,
  Clock,
  Loader2,
  RefreshCw,
} from "lucide-react";
import {
  ASSET_SPECS,
  type Direction,
  type FixedGridMeta,
  type OpenRfqResponse,
  type TicketSummary,
  type UnderlyingSymbol,
} from "@payoff/shared";
import { formatStrikePrice } from "../lib/format";
import { getCopy, type Locale } from "../lib/i18n";

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

export interface MergePreviewInfo {
  existingStakeUsdt: number;
  combinedStakeUsdt: number;
  combinedMaxPayoutUsdt: number;
  isMerge?: boolean;
}

export interface OrderTicketPanelProps {
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
  onGoToPositions?: () => void;
  sheetMode?: boolean;
  mergePreview?: MergePreviewInfo | null;
}

const UP_GREEN = "#2EC26B";
const DOWN_CORAL = "#E85D4A";
const MAX_STAKE_USDT = 50_000;

function getTargetKey(t: Pick<TicketSummary, "lowerStrike" | "upperStrike">) {
  return `${t.lowerStrike}-${t.upperStrike}`;
}

function formatCompactTickPrice(
  price: number,
  underlying: UnderlyingSymbol
): string {
  if (!Number.isFinite(price)) return "--";
  if (price >= 10_000) {
    const k = price / 1000;
    const rounded = Math.round(k * 10) / 10;
    return `$${rounded.toFixed(1)}k`;
  }
  return formatStrikePrice(price, underlying);
}

function formatCompactBalance(val: number): string {
  if (!Number.isFinite(val)) return "0";
  const isWhole = Math.abs(val - Math.round(val)) < 0.005;
  return val.toLocaleString("en-US", {
    minimumFractionDigits: isWhole ? 0 : 2,
    maximumFractionDigits: isWhole ? 0 : 2,
  });
}

function formatStakeDisplay(val: number): string {
  if (!Number.isFinite(val)) return "0";
  const isWhole = Math.abs(val - Math.round(val)) < 0.005;
  return val.toLocaleString("en-US", {
    minimumFractionDigits: isWhole ? 0 : 2,
    maximumFractionDigits: isWhole ? 0 : 2,
  });
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
  sheetMode = false,
  mergePreview = null,
}: OrderTicketPanelProps) {
  const t = getCopy(locale);
  const stakeInputId = useId();
  const stakeHintId = useId();
  const sliderId = useId();
  const formHeadingId = useId();
  const stakeInputRef = useRef<HTMLInputElement | null>(null);

  const [stakeText, setStakeText] = useState<string>(String(stakeUsdt));
  const [stakeTouched, setStakeTouched] = useState(false);
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
  const accentColor = isBull ? UP_GREEN : DOWN_CORAL;
  const anchorStartPrice = grid?.anchorStartPrice ?? activeTicket.startPrice;

  const sliderTiers = tiers.slice(0, 4);
  const foundIdx = sliderTiers.findIndex(
    (item) => getTargetKey(item) === selectedTargetKey
  );
  const selectedIdx = foundIdx >= 0 ? foundIdx : 0;
  const maxIdx = Math.max(1, sliderTiers.length - 1);
  const sliderProgressPct =
    sliderTiers.length > 1 ? (selectedIdx / maxIdx) * 100 : 0;

  const capDeltaPct =
    activeTicket.spot > 0
      ? ((activeTicket.capPrice - activeTicket.spot) / activeTicket.spot) * 100
      : 0;
  const capArrow = isBull ? "≥" : "≤";

  const isBusy =
    stage === "APPROVING" || stage === "QUOTING" || stage === "FILLING";
  const parsedStakeText = Number(stakeText);
  const invalidStake =
    stakeText.trim() === "" ||
    !Number.isFinite(parsedStakeText) ||
    parsedStakeText < 1 ||
    parsedStakeText > MAX_STAKE_USDT ||
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

  const maxAllowedStake = walletConnected
    ? Math.min(
        MAX_STAKE_USDT,
        Math.max(1, Math.floor(usdtBalance * 100) / 100)
      )
    : 1000;

  const handleQuickAdd = (delta: number) => {
    const base =
      Number.isFinite(parsedStakeText) && parsedStakeText >= 0
        ? parsedStakeText
        : stakeUsdt;
    const cap = walletConnected
      ? Math.min(MAX_STAKE_USDT, Math.floor(usdtBalance * 100) / 100)
      : MAX_STAKE_USDT;
    const target =
      cap >= 1
        ? Math.min(cap, Math.max(1, Math.round((base + delta) * 100) / 100))
        : Math.min(MAX_STAKE_USDT, Math.max(1, Math.round((base + delta) * 100) / 100));
    setStakeTouched(false);
    setStakeText(String(target));
    onChangeStake(target);
  };

  const handleQuickMax = () => {
    const next = Math.max(1, Math.min(MAX_STAKE_USDT, maxAllowedStake));
    setStakeTouched(false);
    setStakeText(String(next));
    onChangeStake(next);
  };

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
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
    if (invalidStake || insufficientBalance) {
      setStakeTouched(true);
      stakeInputRef.current?.focus();
      return;
    }
    if (canBuy && !isBusy) {
      onInstantBuy();
    }
  };

  const busyProgressPct =
    stage === "APPROVING" ? 36 : stage === "QUOTING" ? 58 : 80;
  const busyText =
    stage === "APPROVING"
      ? t.approvingGasless
      : stage === "QUOTING"
        ? t.lockingBestPrice
        : t.executingGasless;

  const sliderStyle = {
    "--attr-min": 0,
    "--attr-max": Math.max(1, sliderTiers.length - 1),
    "--control-value": selectedIdx,
    "--slider-progress": `${sliderProgressPct}%`,
    "--slider-fill-color": accentColor,
    "--slider-thumb-border": sheetMode ? "#121417" : "#000000",
  } as CSSProperties;

  return (
    <form
      onSubmit={handleSubmit}
      aria-labelledby={formHeadingId}
      noValidate
      className={
        sheetMode
          ? "space-y-3 sm:space-y-4 bg-transparent"
          : "space-y-3 sm:space-y-4 bg-black lg:sticky lg:top-20"
      }
    >
      <h2 id={formHeadingId} className="sr-only">
        {ASSET_SPECS[activeTicket.underlying].displaySymbol}{" "}
        {isBull ? t.bull : t.bear}
      </h2>

      {/* 1. Direction Pill Switch (#131519 track, #1f2329 active pill) */}
      <div
        className="grid grid-cols-2 gap-[3px] rounded-full bg-[#131519] p-[3px]"
        role="group"
        aria-label={locale === "zh" ? "方向选择" : "Direction"}
      >
        <button
          type="button"
          disabled={isBusy}
          aria-pressed={isBull}
          onClick={() => onChangeDirection("BULL")}
          className={`min-h-[40px] flex items-center justify-center gap-1.5 rounded-full px-3 text-sm font-bold transition cursor-pointer disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/70 ${
            isBull
              ? "bg-[#1f2329] text-[#2EC26B]"
              : "text-[#7e8690] hover:text-[#b8bec6]"
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
          className={`min-h-[40px] flex items-center justify-center gap-1.5 rounded-full px-3 text-sm font-bold transition cursor-pointer disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/70 ${
            !isBull
              ? "bg-[#1f2329] text-[#E85D4A]"
              : "text-[#7e8690] hover:text-[#b8bec6]"
          }`}
        >
          <ArrowDownRight className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{t.downButtonLabel}</span>
        </button>
      </div>

      {/* 2. Option A: 4-Tick Snap Target-Price Slider */}
      <div className="space-y-1.5 pt-0.5">
        <div className="flex items-baseline justify-between gap-2">
          <div className="flex items-baseline gap-1.5 min-w-0">
            <label
              htmlFor={sliderId}
              className="text-xs font-semibold text-[#7e8690] shrink-0"
            >
              {t.capPriceLabel}
            </label>
            <span className="text-base font-bold text-white tabular-nums tracking-tight whitespace-nowrap">
              {capArrow}{" "}
              {formatStrikePrice(activeTicket.capPrice, activeTicket.underlying)}
            </span>
            <span className="text-xs font-semibold text-[#7e8690] tabular-nums whitespace-nowrap">
              ({capDeltaPct >= 0 ? "+" : ""}
              {capDeltaPct.toFixed(1)}%)
            </span>
          </div>
          <span
            className="text-base font-bold tabular-nums shrink-0"
            style={{ color: accentColor }}
          >
            {activeTicket.maxMultiplier.toFixed(2)}x
          </span>
        </div>

        {/* Visual 4-Tick Track + Native Accessible Range Input (native 22px white thumb on top) */}
        <div className="relative flex h-9 items-center">
          {/* Base track + direction-colored active fill spanning thumb centers */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-[11px] top-1/2 -translate-y-1/2 h-1 rounded-full bg-[#22262d]"
          >
            <div
              className="h-full rounded-full transition-[width] duration-150"
              style={{
                width: `${sliderProgressPct}%`,
                backgroundColor: accentColor,
              }}
            />
          </div>

          {/* 4 discrete tick dots aligned to exact centers of native 22px thumb stops */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-[6px] top-1/2 -translate-y-1/2 flex items-center justify-between"
          >
            {sliderTiers.map((item, idx) => {
              const passed = idx <= selectedIdx;
              return (
                <span
                  key={getTargetKey(item)}
                  className="block h-2.5 w-2.5 rounded-full"
                  style={{
                    backgroundColor: passed ? accentColor : "#2c313a",
                    border: `2px solid ${sheetMode ? "#121417" : "#000000"}`,
                  }}
                />
              );
            })}
          </div>

          {/* Native Range Control with transparent track & styled 22px white thumb from index.css */}
          <input
            id={sliderId}
            name="targetTier"
            type="range"
            min={0}
            max={Math.max(0, sliderTiers.length - 1)}
            step={1}
            disabled={isBusy || sliderTiers.length <= 1}
            value={selectedIdx}
            aria-valuetext={`${capArrow} ${formatStrikePrice(activeTicket.capPrice, activeTicket.underlying)}, ${activeTicket.maxMultiplier.toFixed(2)}x`}
            style={sliderStyle}
            onChange={(e) => {
              const nextIdx = Number(e.target.value);
              const nextTier = sliderTiers[nextIdx];
              if (nextTier) {
                onSelectTarget(nextTier);
              }
            }}
            className={`payoff-range--transparent-track relative z-10 w-full cursor-pointer disabled:cursor-not-allowed ${
              !isBull ? "payoff-range--bear" : ""
            }`}
          />
        </div>

        {/* Clickable Compact Tick Labels */}
        <div className="flex items-center justify-between gap-1">
          {sliderTiers.map((item, idx) => {
            const isSelected = idx === selectedIdx;
            return (
              <button
                key={getTargetKey(item)}
                type="button"
                disabled={isBusy}
                aria-pressed={isSelected}
                onClick={() => onSelectTarget(item)}
                className={`min-h-[26px] rounded-md px-1 py-0.5 text-[11px] tabular-nums transition cursor-pointer disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-white/70 ${
                  isSelected
                    ? "font-bold text-white"
                    : "font-semibold text-[#7e8690] hover:text-[#b8bec6]"
                }`}
              >
                {formatCompactTickPrice(item.capPrice, item.underlying)}
              </button>
            );
          })}
        </div>
      </div>

      {/* 3. Option A: Single-Row Editable Amount Bar (#131519, 1px solid #262A31) */}
      <div
        className={`flex items-center justify-between gap-2.5 rounded-2xl border bg-[#131519] px-3.5 py-2.5 transition-colors ${
          stakeTouched && (invalidStake || insufficientBalance)
            ? "border-[#E85D4A]"
            : "border-[#262A31] focus-within:border-white/35"
        }`}
      >
        <div className="flex min-w-0 flex-1 flex-col">
          <label
            htmlFor={stakeInputId}
            id={stakeHintId}
            className="block truncate text-[11px] font-semibold text-[#7e8690] tabular-nums"
          >
            {t.stakeInputLabel}
            {walletConnected
              ? ` · ${t.available} $${formatCompactBalance(usdtBalance)}`
              : ""}
          </label>
          <div className="mt-0.5 flex items-baseline">
            <span
              aria-hidden="true"
              className="mr-1 text-lg font-bold text-[#7e8690]"
            >
              $
            </span>
            <input
              ref={stakeInputRef}
              id={stakeInputId}
              name="stakeUsdt"
              type="text"
              inputMode="decimal"
              enterKeyHint="done"
              autoComplete="off"
              spellCheck={false}
              disabled={isBusy}
              value={stakeText}
              aria-invalid={
                stakeTouched && (invalidStake || insufficientBalance)
              }
              aria-describedby={stakeHintId}
              onChange={(e) => {
                const raw = e.target.value
                  .replace(/[^\d.]/g, "")
                  .replace(/(\..*)\./g, "$1");
                setStakeText(raw);
                const parsed = Number(raw);
                if (Number.isFinite(parsed) && parsed >= 1) {
                  const clamped = Math.min(
                    MAX_STAKE_USDT,
                    Math.round(parsed * 100) / 100
                  );
                  setStakeTouched(false);
                  onChangeStake(clamped);
                }
              }}
              onBlur={() => {
                setStakeTouched(true);
                const parsed = Number(stakeText);
                const clamped =
                  Number.isFinite(parsed) && parsed >= 1
                    ? Math.min(MAX_STAKE_USDT, Math.round(parsed * 100) / 100)
                    : 10;
                setStakeText(String(clamped));
                if (clamped !== stakeUsdt) {
                  onChangeStake(clamped);
                }
              }}
              className="w-full min-w-[52px] bg-transparent text-[22px] leading-tight font-bold tracking-[-0.025em] text-white tabular-nums outline-none disabled:opacity-60"
            />
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            disabled={isBusy}
            onClick={() => handleQuickAdd(10)}
            className="min-h-[32px] rounded-full bg-[#1e2228] px-2.5 py-1 text-[11.5px] font-semibold text-[#b8bec6] tabular-nums transition hover:bg-[#282d35] hover:text-white cursor-pointer disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-white/70"
          >
            {t.amountQuickAdd10}
          </button>
          <button
            type="button"
            disabled={isBusy}
            onClick={() => handleQuickAdd(50)}
            className="min-h-[32px] rounded-full bg-[#1e2228] px-2.5 py-1 text-[11.5px] font-semibold text-[#b8bec6] tabular-nums transition hover:bg-[#282d35] hover:text-white cursor-pointer disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-white/70"
          >
            {t.amountQuickAdd50}
          </button>
          <button
            type="button"
            disabled={isBusy}
            onClick={handleQuickMax}
            className="min-h-[32px] rounded-full bg-[#1e2228] px-2.5 py-1 text-[11.5px] font-semibold text-white transition hover:bg-[#282d35] cursor-pointer disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-white/70"
          >
            {t.amountMax}
          </button>
        </div>
      </div>

      {/* 4. Single Compact Math Line */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-[#7e8690] tabular-nums">
        <span>
          {t.mathStartShort(
            formatStrikePrice(anchorStartPrice, activeTicket.underlying)
          )}{" "}
          ·{" "}
          {t.mathBreakevenShort(
            formatStrikePrice(
              activeTicket.breakevenPrice,
              activeTicket.underlying
            )
          )}
        </span>
        <span className="font-semibold" style={{ color: accentColor }}>
          {t.mathMaxWin(activeTicket.maxPayoutUsdt.toFixed(2))}
        </span>
      </div>

      {/* Optional Merge Preview Callout (for B3 Add-to-Position Sheet) */}
      {mergePreview && (
        <div className="rounded-xl bg-[#15171b] px-3.5 py-2.5 text-xs leading-relaxed text-[#b8bec6] tabular-nums">
          {mergePreview.existingStakeUsdt > 0 && mergePreview.isMerge !== false
            ? t.mergeNoticeSameSeries(
                formatStakeDisplay(mergePreview.existingStakeUsdt),
                formatStakeDisplay(mergePreview.combinedStakeUsdt),
                mergePreview.combinedMaxPayoutUsdt.toFixed(2)
              )
            : t.mergeNoticeNewSeries}
        </div>
      )}

      {/* C6 Dark Circuit-Breaker Card */}
      {quotingPaused && (
        <div
          role="alert"
          className="rounded-2xl bg-[#121417] px-3.5 py-3 text-xs leading-relaxed text-[#b8bec6]"
        >
          <div className="flex items-center gap-2 font-semibold text-white">
            <span
              aria-hidden="true"
              className="h-2 w-2 shrink-0 rounded-full bg-[#E85D4A]"
            />
            <span>
              {rwaPaused ? t.rwaQuotingPausedCta : t.quotingPausedCta}
            </span>
          </div>
          <p className="mt-1 text-[#7e8690]">
            {rwaPaused
              ? t.rwaBlackoutPausedNotice(rwaPauseReason)
              : t.quotingPausedNotice}
          </p>
        </div>
      )}

      {/* C6 Dark Error Card */}
      {errorMsg && (
        <div
          role="alert"
          className="rounded-2xl bg-[#121417] px-3.5 py-3 text-xs leading-relaxed text-[#b8bec6]"
        >
          <div className="flex items-start gap-2">
            <span
              aria-hidden="true"
              className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-[#E85D4A]"
            />
            <span>{errorMsg}</span>
          </div>
        </div>
      )}

      {/* 5. Single Pure-White Pill CTA / Slippage Confirmation / In-Place Progress */}
      {stage === "SUCCESS" && txHash ? (
        <div
          role="status"
          aria-live="polite"
          className="rounded-2xl bg-[#121417] p-4 space-y-3"
        >
          <div className="flex items-center gap-2 text-sm font-semibold text-[#2EC26B]">
            <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{t.buySuccess}</span>
          </div>
          <div className="flex gap-2">
            {onGoToPositions && (
              <button
                type="button"
                onClick={onGoToPositions}
                className="flex-1 min-h-[44px] rounded-full bg-white py-2.5 text-xs font-bold text-black hover:bg-white/90 cursor-pointer"
              >
                {t.viewPositions}
              </button>
            )}
            <button
              type="button"
              onClick={onCancelFlow}
              className="flex-1 min-h-[44px] rounded-full bg-[#1f2329] px-4 py-2.5 text-xs font-semibold text-white hover:bg-[#282d35] cursor-pointer"
            >
              {t.continueTrading}
            </button>
          </div>
        </div>
      ) : (stage === "SLIPPAGE_CONFIRM" || stage === "FILLING") &&
        slippagePause ? (
        <div
          role="alert"
          className="rounded-2xl bg-[#121417] p-4 space-y-3"
        >
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="flex items-center gap-2 font-semibold text-white">
              <span
                aria-hidden="true"
                className="h-2 w-2 shrink-0 rounded-full bg-[#E6BA5C]"
              />
              {t.slippageTitle}
            </span>
            <span
              className={`flex items-center gap-1 font-bold tabular-nums shrink-0 ${
                countdown === 0 ? "text-[#E85D4A]" : "text-[#E6BA5C]"
              }`}
            >
              <Clock className="h-3.5 w-3.5" aria-hidden="true" />
              {countdown}s
            </span>
          </div>

          <p className="text-xs leading-relaxed text-[#7e8690] tabular-nums">
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
                className="flex-1 min-h-[46px] rounded-full bg-white px-3 py-2.5 text-xs font-bold text-black hover:bg-white/90 cursor-pointer flex items-center justify-center gap-1.5"
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                <span>{t.quoteExpiredRefresh}</span>
              </button>
            ) : (
              <button
                type="submit"
                disabled={stage === "FILLING"}
                className="relative flex-1 min-h-[46px] overflow-hidden rounded-full bg-white px-3 py-2.5 text-xs font-bold text-black hover:bg-white/90 disabled:bg-[#15171b] disabled:text-white cursor-pointer flex items-center justify-center gap-1.5"
              >
                {stage === "FILLING" ? (
                  <>
                    <span
                      aria-hidden="true"
                      className="absolute inset-y-0 left-0 w-4/5 bg-[#2EC26B]/22 transition-all"
                    />
                    <Loader2
                      className="relative z-10 h-3.5 w-3.5 animate-spin text-[#2EC26B]"
                      aria-hidden="true"
                    />
                    <span className="relative z-10">{busyText}</span>
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
              className="min-h-[46px] rounded-full bg-[#1f2329] px-4 py-2.5 text-xs font-semibold text-[#b8bec6] hover:bg-[#282d35] hover:text-white disabled:opacity-50 cursor-pointer"
            >
              {t.cancel}
            </button>
          </div>
        </div>
      ) : !walletConnected ? (
        <button
          type="button"
          onClick={onOpenWallet}
          className="flex min-h-[52px] w-full items-center justify-center rounded-full bg-white px-5 py-3 text-[15px] font-bold tracking-[-0.01em] text-black transition hover:bg-white/90 active:scale-[0.99] cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
        >
          {t.buyCtaSignIn}
        </button>
      ) : isBusy ? (
        <button
          type="button"
          disabled
          aria-busy="true"
          className="relative flex min-h-[52px] w-full items-center justify-center gap-2 overflow-hidden rounded-full bg-[#15171b] px-5 py-3 text-[15px] font-bold text-white cursor-not-allowed"
        >
          <span
            aria-hidden="true"
            className="absolute inset-y-0 left-0 bg-[#2EC26B]/22 transition-[width] duration-300"
            style={{ width: `${busyProgressPct}%` }}
          />
          <Loader2
            className="relative z-10 h-4 w-4 animate-spin text-[#2EC26B]"
            aria-hidden="true"
          />
          <span className="relative z-10">{busyText}</span>
        </button>
      ) : (
        <button
          type="submit"
          disabled={!canBuy}
          className="flex min-h-[52px] w-full items-center justify-center rounded-full bg-white px-5 py-3 text-[15px] font-bold tracking-[-0.01em] text-black tabular-nums transition hover:bg-white/90 active:scale-[0.99] disabled:cursor-not-allowed disabled:bg-[#1a1d23] disabled:text-[#7e8690] cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
        >
          {quotingPaused
            ? rwaPaused
              ? t.rwaQuotingPausedCta
              : t.quotingPausedCta
            : insufficientBalance
              ? t.insufficientUsdt
              : !activeTicket.guardrails.valid
                ? t.adjustRangeFirst
                : isBull
                  ? t.buyCtaBull(
                      formatStakeDisplay(stakeUsdt),
                      activeTicket.maxPayoutUsdt.toFixed(2)
                    )
                  : t.buyCtaBear(
                      formatStakeDisplay(stakeUsdt),
                      activeTicket.maxPayoutUsdt.toFixed(2)
                    )}
        </button>
      )}
    </form>
  );
}

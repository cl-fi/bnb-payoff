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
  ChevronLeft,
  ChevronRight,
  Clock,
  Loader2,
  RefreshCw,
} from "lucide-react";
import {
  ASSET_SPECS,
  type CustomClampReason,
  type CustomRangeConfig,
  type Direction,
  type FixedGridMeta,
  type OpenRfqResponse,
  type TicketSummary,
  type UnderlyingSymbol,
} from "@payoff/shared";
import { formatStrikePrice } from "../lib/format";
import { getCopy, type Locale } from "../lib/i18n";
import { MiniPayoffPnlChart } from "./MiniPayoffPnlChart";

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

export type RangeMode = "QUICK" | "CUSTOM";

export interface OrderTicketPanelProps {
  locale: Locale;
  direction: Direction;
  onChangeDirection: (dir: Direction) => void;
  tiers: TicketSummary[];
  /** Dense fine-grained Quick-mode slider options within guardrails (falls back to `tiers`) */
  quickTiers?: TicketSummary[];
  selectedTargetKey: string;
  onSelectTarget: (ticket: TicketSummary) => void;
  rangeMode?: RangeMode;
  onChangeRangeMode?: (mode: RangeMode) => void;
  customConfig?: CustomRangeConfig;
  customStartPrice?: number;
  customCapPrice?: number;
  customClampReason?: CustomClampReason;
  customStartClamped?: boolean;
  customCapClamped?: boolean;
  customSyncing?: boolean;
  onChangeCustomStart?: (startPrice: number) => void;
  onChangeCustomCap?: (capPrice: number) => void;
  ticket: TicketSummary;
  spot?: number;
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

function pickAnchorIndices(length: number, maxAnchors = 4): number[] {
  if (length <= 0) return [];
  if (length <= maxAnchors) {
    return Array.from({ length }, (_, idx) => idx);
  }
  const indices = new Set<number>([0, length - 1]);
  const interiorSlots = Math.max(0, maxAnchors - 2);
  for (let i = 1; i <= interiorSlots; i++) {
    indices.add(Math.round(((length - 1) * i) / (interiorSlots + 1)));
  }
  return Array.from(indices).sort((a, b) => a - b);
}

interface AlignedLabelAnchor {
  idx: number;
  pct: number;
  align: "left" | "center" | "right";
}

function buildAlignedLabelAnchors(
  indices: readonly number[],
  length: number,
  minEdgeGapPct = 20,
  minBetweenGapPct = 24
): AlignedLabelAnchor[] {
  if (length <= 0 || indices.length === 0) return [];
  if (length === 1) {
    return [{ idx: 0, pct: 0, align: "left" }];
  }
  const denom = Math.max(1, length - 1);
  const firstIdx = indices[0]!;
  const lastIdx = indices[indices.length - 1]!;
  const result: AlignedLabelAnchor[] = [];
  const lastKeptPctRef = { value: 0 };

  for (const idx of indices) {
    const pct = (idx / denom) * 100;
    if (idx === firstIdx) {
      result.push({ idx, pct: 0, align: "left" });
      lastKeptPctRef.value = 0;
    } else if (idx === lastIdx) {
      result.push({ idx, pct: 100, align: "right" });
    } else {
      if (
        pct >= minEdgeGapPct &&
        pct <= 100 - minEdgeGapPct &&
        pct - lastKeptPctRef.value >= minBetweenGapPct
      ) {
        result.push({ idx, pct, align: "center" });
        lastKeptPctRef.value = pct;
      }
    }
  }
  return result;
}

function findClosestIndex(values: readonly number[], target: number): number {
  if (values.length === 0) return 0;
  let bestIdx = 0;
  let bestDist = Math.abs(values[0]! - target);
  for (let i = 1; i < values.length; i++) {
    const d = Math.abs(values[i]! - target);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bestIdx;
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
  quickTiers,
  selectedTargetKey,
  onSelectTarget,
  rangeMode = "QUICK",
  onChangeRangeMode,
  customConfig,
  customStartPrice,
  customCapPrice,
  customClampReason = "NONE",
  customStartClamped = false,
  customCapClamped = false,
  customSyncing = false,
  onChangeCustomStart,
  onChangeCustomCap,
  ticket,
  spot,
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
  const customStartSliderId = useId();
  const customCapSliderId = useId();
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

  // Quick mode fine-grained slider options (all valid strikes within guardrails)
  const sliderTiers =
    quickTiers && quickTiers.length > 0 ? quickTiers : tiers;
  const foundIdx = sliderTiers.findIndex(
    (item) => getTargetKey(item) === selectedTargetKey
  );
  const selectedIdx = foundIdx >= 0 ? foundIdx : 0;
  const maxIdx = Math.max(1, sliderTiers.length - 1);
  const sliderProgressPct =
    sliderTiers.length > 1 ? (selectedIdx / maxIdx) * 100 : 0;
  const quickAnchorIndices = pickAnchorIndices(sliderTiers.length, 4);

  // Custom mode dual-slider state (Start + Target cap with auto width & fair-pricing bounds)
  const customAvailable = Boolean(
    onChangeRangeMode &&
      customConfig &&
      customConfig.validStarts.length > 0 &&
      onChangeCustomStart &&
      onChangeCustomCap
  );
  const isCustomMode = rangeMode === "CUSTOM" && customAvailable && Boolean(customConfig);
  const customValidStarts = customConfig?.validStarts ?? [];
  const effectiveCustomStart =
    customStartPrice ?? customConfig?.defaultStart ?? activeTicket.startPrice;
  const customStartIdx = findClosestIndex(
    customValidStarts,
    effectiveCustomStart
  );
  const resolvedStartStrike =
    customValidStarts[customStartIdx] ?? effectiveCustomStart;
  const customStartMaxIdx = Math.max(1, customValidStarts.length - 1);
  const customStartProgressPct =
    customValidStarts.length > 1
      ? (customStartIdx / customStartMaxIdx) * 100
      : 0;

  const customValidCaps =
    customConfig?.validCapsByStart[String(resolvedStartStrike)] ?? [];
  const effectiveCustomCap =
    customCapPrice ?? customConfig?.defaultCap ?? activeTicket.capPrice;
  const customCapIdx = findClosestIndex(customValidCaps, effectiveCustomCap);
  const resolvedCapStrike =
    customValidCaps[customCapIdx] ?? effectiveCustomCap;
  const customCapMaxIdx = Math.max(1, customValidCaps.length - 1);
  const customCapProgressPct =
    customValidCaps.length > 1 ? (customCapIdx / customCapMaxIdx) * 100 : 0;

  // Anchor points for Start slider (ITM edge, ATM/anchor landmark, OTM edge)
  const customAtmStartIdx =
    customValidStarts.length > 2
      ? findClosestIndex(customValidStarts, anchorStartPrice)
      : -1;
  const customStartAnchorIndices = (() => {
    const len = customValidStarts.length;
    if (len <= 3) return pickAnchorIndices(len, 3);
    const set = new Set<number>([0, len - 1]);
    if (customAtmStartIdx > 0 && customAtmStartIdx < len - 1) {
      set.add(customAtmStartIdx);
    } else {
      set.add(Math.round((len - 1) / 2));
    }
    return Array.from(set).sort((a, b) => a - b);
  })();
  const customCapAnchorIndices = pickAnchorIndices(customValidCaps.length, 4);

  const quickLabelAnchors = buildAlignedLabelAnchors(
    quickAnchorIndices,
    sliderTiers.length,
    18,
    22
  );
  const customStartLabelAnchors = buildAlignedLabelAnchors(
    customStartAnchorIndices,
    customValidStarts.length,
    20,
    24
  );
  const customCapLabelAnchors = buildAlignedLabelAnchors(
    customCapAnchorIndices,
    customValidCaps.length,
    18,
    22
  );

  const spotRef =
    activeTicket.spot > 0
      ? activeTicket.spot
      : customConfig?.pricingParams.spot ?? 0;
  const startDeltaPct =
    spotRef > 0
      ? (((isCustomMode ? resolvedStartStrike : activeTicket.startPrice) -
          spotRef) /
          spotRef) *
        100
      : 0;
  const capDeltaPct =
    spotRef > 0
      ? (((isCustomMode ? resolvedCapStrike : activeTicket.capPrice) -
          spotRef) /
          spotRef) *
        100
      : 0;
  const capArrow = isBull ? "≥" : "≤";

  const isStartOnlyClamp = customStartClamped && !customCapClamped;
  const clampNotice =
    isCustomMode && customConfig && customClampReason !== "NONE"
      ? customClampReason === "WIDTH_CAP"
        ? t.customClampWidthCap(customConfig.maxAllowedWidthPct.toFixed(1))
        : customClampReason === "OTM_FAIR_LIMIT"
          ? isStartOnlyClamp
            ? t.customClampStartOtmFair(
                String(Math.round(customConfig.maxMultiplier))
              )
            : t.customClampOtmFair(
                String(Math.round(customConfig.maxMultiplier))
              )
          : customClampReason === "ITM_FAIR_LIMIT"
            ? isStartOnlyClamp
              ? t.customClampStartItmFair(customConfig.minMultiplier.toFixed(2))
              : t.customClampItmFair(customConfig.minMultiplier.toFixed(2))
            : customClampReason === "ORDERING"
              ? t.customClampOrdering
              : customClampReason === "STRIKE_ALIGN"
                ? t.customClampStrikeAlign
                : null
      : null;

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

  const thumbBorderColor = sheetMode ? "#121417" : "#000000";
  const customThumbBorderColor = "#0d0f12";

  // Keep native runnable-track transparent via `.payoff-range--transparent-track` (never set inline `--slider-fill-color`,
  // which would out-specify the class rule and double-paint over the inset underlay track & anchor stop dots).
  const quickSliderStyle = {
    "--attr-min": 0,
    "--attr-max": maxIdx,
    "--control-value": selectedIdx,
    "--slider-progress": `${sliderProgressPct}%`,
    "--slider-thumb-border": thumbBorderColor,
  } as CSSProperties;

  const customStartSliderStyle = {
    "--attr-min": 0,
    "--attr-max": customStartMaxIdx,
    "--control-value": customStartIdx,
    "--slider-progress": `${customStartProgressPct}%`,
    "--slider-thumb-border": customThumbBorderColor,
  } as CSSProperties;

  const customCapSliderStyle = {
    "--attr-min": 0,
    "--attr-max": customCapMaxIdx,
    "--control-value": customCapIdx,
    "--slider-progress": `${customCapProgressPct}%`,
    "--slider-thumb-border": customThumbBorderColor,
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

      {/* 2. Quick (Fine-Step Target Cap) / Custom (Dual Start + Target Cap with Auto-Clamps) */}
      <div className="space-y-2 pt-0.5">
        {/* Lightweight Quick / Custom Segmented Mode Switch + Live Payout Multiplier */}
        <div className="flex items-center justify-between gap-2">
          {onChangeRangeMode ? (
            <div
              role="group"
              aria-label={t.rangeModeGroupLabel}
              className="inline-flex items-center rounded-full bg-[#131519] p-[2px]"
            >
              <button
                type="button"
                disabled={isBusy}
                aria-pressed={!isCustomMode}
                onClick={() => onChangeRangeMode("QUICK")}
                className={`min-h-[26px] rounded-full px-2.5 text-[11.5px] font-semibold transition cursor-pointer disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-white/70 ${
                  !isCustomMode
                    ? "bg-[#1f2329] text-white"
                    : "text-[#7e8690] hover:text-[#b8bec6]"
                }`}
              >
                {t.modeQuick}
              </button>
              <button
                type="button"
                disabled={isBusy || !customAvailable}
                aria-pressed={isCustomMode}
                onClick={() => onChangeRangeMode("CUSTOM")}
                className={`min-h-[26px] rounded-full px-2.5 text-[11.5px] font-semibold transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-white/70 ${
                  isCustomMode
                    ? "bg-[#1f2329] text-white"
                    : "text-[#7e8690] hover:text-[#b8bec6]"
                }`}
              >
                {t.modeCustom}
              </button>
            </div>
          ) : (
            <span className="text-xs font-semibold text-[#7e8690]">
              {t.capPriceLabel}
            </span>
          )}

          <span
            className={`text-base font-bold tabular-nums shrink-0 transition-opacity ${
              customSyncing ? "opacity-75" : "opacity-100"
            }`}
            style={{ color: accentColor }}
          >
            {activeTicket.maxMultiplier.toFixed(2)}x
          </span>
        </div>

        {isCustomMode && customConfig ? (
          /* CUSTOM MODE: Dual Start & Target Cap Sliders with Auto Width + Fair-Bounds Clamping */
          <div className="rounded-2xl border border-[#1d2025] bg-[#0d0f12] p-3 space-y-2.5">
            {/* Start Price Control */}
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-baseline gap-1.5 min-w-0">
                  <label
                    htmlFor={customStartSliderId}
                    className="text-xs font-semibold text-[#7e8690] shrink-0"
                  >
                    {isBull ? t.startPriceLabelBull : t.startPriceLabelBear}
                  </label>
                  <span className="text-[15px] font-bold text-white tabular-nums tracking-tight whitespace-nowrap">
                    {formatStrikePrice(
                      resolvedStartStrike,
                      activeTicket.underlying
                    )}
                  </span>
                  <span className="text-[11px] font-semibold text-[#7e8690] tabular-nums whitespace-nowrap">
                    ({startDeltaPct >= 0 ? "+" : ""}
                    {startDeltaPct.toFixed(1)}%)
                  </span>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    disabled={isBusy || customStartIdx <= 0}
                    aria-label={
                      customStartIdx > 0
                        ? t.stepPrevLabel(
                            formatStrikePrice(
                              customValidStarts[customStartIdx - 1],
                              activeTicket.underlying
                            )
                          )
                        : t.startPriceLabel
                    }
                    onClick={() => {
                      const prev = customValidStarts[customStartIdx - 1];
                      if (prev !== undefined) onChangeCustomStart?.(prev);
                    }}
                    className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-[#1a1d23] text-[#b8bec6] hover:bg-[#24282f] hover:text-white disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer focus-visible:outline-2 focus-visible:outline-white/70"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    disabled={
                      isBusy || customStartIdx >= customValidStarts.length - 1
                    }
                    aria-label={
                      customStartIdx < customValidStarts.length - 1
                        ? t.stepNextLabel(
                            formatStrikePrice(
                              customValidStarts[customStartIdx + 1],
                              activeTicket.underlying
                            )
                          )
                        : t.startPriceLabel
                    }
                    onClick={() => {
                      const next = customValidStarts[customStartIdx + 1];
                      if (next !== undefined) onChangeCustomStart?.(next);
                    }}
                    className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-[#1a1d23] text-[#b8bec6] hover:bg-[#24282f] hover:text-white disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer focus-visible:outline-2 focus-visible:outline-white/70"
                  >
                    <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>
              </div>

              <div className="relative flex h-8 items-center">
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-x-[11px] top-1/2 -translate-y-1/2 h-1 rounded-full bg-[#22262d]"
                >
                  <div
                    className="h-full rounded-full bg-[#9aa2ad] transition-[width] duration-100"
                    style={{ width: `${customStartProgressPct}%` }}
                  />
                  {customStartAnchorIndices.map((idx) => {
                    const pct =
                      customValidStarts.length > 1
                        ? (idx / customStartMaxIdx) * 100
                        : 0;
                    const isAtm = idx === customAtmStartIdx;
                    const passed = idx <= customStartIdx;
                    return (
                      <span
                        key={customValidStarts[idx]}
                        className={`absolute top-1/2 -translate-x-1/2 -translate-y-1/2 block rounded-full ${
                          isAtm ? "h-2.5 w-2.5" : "h-2 w-2"
                        }`}
                        style={{
                          left: `${pct}%`,
                          backgroundColor: isAtm
                            ? "#ffffff"
                            : passed
                              ? "#9aa2ad"
                              : "#2c313a",
                          border: `2px solid ${customThumbBorderColor}`,
                        }}
                      />
                    );
                  })}
                </div>

                <input
                  id={customStartSliderId}
                  name="customStartStrike"
                  type="range"
                  min={0}
                  max={customStartMaxIdx}
                  step={1}
                  disabled={isBusy || customValidStarts.length <= 1}
                  value={customStartIdx}
                  aria-valuetext={`${t.startPriceLabel} ${formatStrikePrice(resolvedStartStrike, activeTicket.underlying)} (${startDeltaPct >= 0 ? "+" : ""}${startDeltaPct.toFixed(1)}%)`}
                  style={customStartSliderStyle}
                  onChange={(e) => {
                    const nextStrike = customValidStarts[Number(e.target.value)];
                    if (nextStrike !== undefined) {
                      onChangeCustomStart?.(nextStrike);
                    }
                  }}
                  className="payoff-range--transparent-track relative z-10 w-full cursor-pointer disabled:cursor-not-allowed"
                />
              </div>

              <div className="relative mx-[11px] h-6">
                {customStartLabelAnchors.map(({ idx, pct, align }) => {
                  const strike = customValidStarts[idx]!;
                  const isSelected = idx === customStartIdx;
                  const isAtm = idx === customAtmStartIdx;
                  return (
                    <button
                      key={strike}
                      type="button"
                      disabled={isBusy}
                      aria-pressed={isSelected}
                      onClick={() => onChangeCustomStart?.(strike)}
                      style={
                        align === "center" ? { left: `${pct}%` } : undefined
                      }
                      className={`absolute top-0 min-h-[22px] whitespace-nowrap rounded-md px-1 py-0.5 text-[10.5px] tabular-nums transition cursor-pointer disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-white/70 ${
                        align === "left"
                          ? "-left-[11px]"
                          : align === "right"
                            ? "-right-[11px]"
                            : "-translate-x-1/2"
                      } ${
                        isSelected
                          ? "font-bold text-white"
                          : isAtm
                            ? "font-semibold text-[#b8bec6] hover:text-white"
                            : "font-medium text-[#7e8690] hover:text-[#b8bec6]"
                      }`}
                    >
                      {formatCompactTickPrice(strike, activeTicket.underlying)}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="border-t border-[#1a1d23]" />

            {/* Target Cap Control (dynamically bounded for selected Start) */}
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-baseline gap-1.5 min-w-0">
                  <label
                    htmlFor={customCapSliderId}
                    className="text-xs font-semibold text-[#7e8690] shrink-0"
                  >
                    {isBull ? t.capPriceLabelBull : t.capPriceLabelBear}
                  </label>
                  <span className="text-[15px] font-bold text-white tabular-nums tracking-tight whitespace-nowrap">
                    {capArrow}{" "}
                    {formatStrikePrice(
                      resolvedCapStrike,
                      activeTicket.underlying
                    )}
                  </span>
                  <span className="text-[11px] font-semibold text-[#7e8690] tabular-nums whitespace-nowrap">
                    ({capDeltaPct >= 0 ? "+" : ""}
                    {capDeltaPct.toFixed(1)}%)
                  </span>
                </div>

                {customValidCaps.length <= 1 ? (
                  <span className="shrink-0 rounded-full bg-[#1a1d23] px-2 py-0.5 text-[10.5px] font-medium text-[#7e8690]">
                    {t.customSingleCapHint}
                  </span>
                ) : (
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      disabled={isBusy || customCapIdx <= 0}
                      aria-label={
                        customCapIdx > 0
                          ? t.stepPrevLabel(
                              formatStrikePrice(
                                customValidCaps[customCapIdx - 1],
                                activeTicket.underlying
                              )
                            )
                          : t.capPriceLabel
                      }
                      onClick={() => {
                        const prev = customValidCaps[customCapIdx - 1];
                        if (prev !== undefined) onChangeCustomCap?.(prev);
                      }}
                      className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-[#1a1d23] text-[#b8bec6] hover:bg-[#24282f] hover:text-white disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer focus-visible:outline-2 focus-visible:outline-white/70"
                    >
                      <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      disabled={
                        isBusy || customCapIdx >= customValidCaps.length - 1
                      }
                      aria-label={
                        customCapIdx < customValidCaps.length - 1
                          ? t.stepNextLabel(
                              formatStrikePrice(
                                customValidCaps[customCapIdx + 1],
                                activeTicket.underlying
                              )
                            )
                          : t.capPriceLabel
                      }
                      onClick={() => {
                        const next = customValidCaps[customCapIdx + 1];
                        if (next !== undefined) onChangeCustomCap?.(next);
                      }}
                      className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-[#1a1d23] text-[#b8bec6] hover:bg-[#24282f] hover:text-white disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer focus-visible:outline-2 focus-visible:outline-white/70"
                    >
                      <ChevronRight
                        className="h-3.5 w-3.5"
                        aria-hidden="true"
                      />
                    </button>
                  </div>
                )}
              </div>

              <div className="relative flex h-8 items-center">
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-x-[11px] top-1/2 -translate-y-1/2 h-1 rounded-full bg-[#22262d]"
                >
                  <div
                    className="h-full rounded-full transition-[width] duration-100"
                    style={{
                      width: `${customCapProgressPct}%`,
                      backgroundColor: accentColor,
                    }}
                  />
                  {customCapAnchorIndices.map((idx) => {
                    const pct =
                      customValidCaps.length > 1
                        ? (idx / customCapMaxIdx) * 100
                        : 0;
                    const passed = idx <= customCapIdx;
                    return (
                      <span
                        key={customValidCaps[idx]}
                        className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 block h-2 w-2 rounded-full"
                        style={{
                          left: `${pct}%`,
                          backgroundColor: passed ? accentColor : "#2c313a",
                          border: `2px solid ${customThumbBorderColor}`,
                        }}
                      />
                    );
                  })}
                </div>

                <input
                  id={customCapSliderId}
                  name="customCapStrike"
                  type="range"
                  min={0}
                  max={customCapMaxIdx}
                  step={1}
                  disabled={isBusy || customValidCaps.length <= 1}
                  value={customCapIdx}
                  aria-valuetext={`${capArrow} ${formatStrikePrice(resolvedCapStrike, activeTicket.underlying)}, ${activeTicket.maxMultiplier.toFixed(2)}x`}
                  style={customCapSliderStyle}
                  onChange={(e) => {
                    const nextCap = customValidCaps[Number(e.target.value)];
                    if (nextCap !== undefined) {
                      onChangeCustomCap?.(nextCap);
                    }
                  }}
                  className="payoff-range--transparent-track relative z-10 w-full cursor-pointer disabled:cursor-not-allowed"
                />
              </div>

              <div className="relative mx-[11px] h-6">
                {customCapLabelAnchors.map(({ idx, pct, align }) => {
                  const cap = customValidCaps[idx]!;
                  const isSelected = idx === customCapIdx;
                  return (
                    <button
                      key={cap}
                      type="button"
                      disabled={isBusy}
                      aria-pressed={isSelected}
                      onClick={() => onChangeCustomCap?.(cap)}
                      style={
                        align === "center" ? { left: `${pct}%` } : undefined
                      }
                      className={`absolute top-0 min-h-[22px] whitespace-nowrap rounded-md px-1 py-0.5 text-[10.5px] tabular-nums transition cursor-pointer disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-white/70 ${
                        align === "left"
                          ? "-left-[11px]"
                          : align === "right"
                            ? "-right-[11px]"
                            : "-translate-x-1/2"
                      } ${
                        isSelected
                          ? "font-bold text-white"
                          : "font-medium text-[#7e8690] hover:text-[#b8bec6]"
                      }`}
                    >
                      {formatCompactTickPrice(cap, activeTicket.underlying)}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Guardrail Width & Fair-Pricing Bounds Summary + Auto-Clamp Feedback */}
            <div className="space-y-1 border-t border-[#1a1d23] pt-2">
              <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 text-[11px] text-[#7e8690] tabular-nums">
                <span>
                  {t.customWidthSummary(
                    activeTicket.guardrails.widthPct.toFixed(1),
                    customConfig.maxAllowedWidthPct.toFixed(1)
                  )}
                </span>
                <span>
                  {t.customFairRangeSummary(
                    customConfig.minMultiplier.toFixed(2),
                    String(Math.round(customConfig.maxMultiplier))
                  )}
                </span>
              </div>
              {clampNotice && (
                <p
                  role="status"
                  aria-live="polite"
                  className="text-[11px] font-medium text-[#E6BA5C] tabular-nums"
                >
                  {clampNotice}
                </p>
              )}
            </div>
          </div>
        ) : (
          /* QUICK MODE: Fine-Step Target-Price Slider within Guardrails */
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-baseline gap-1.5 min-w-0">
                <label
                  htmlFor={sliderId}
                  className="text-xs font-semibold text-[#7e8690] shrink-0"
                >
                  {isBull ? t.capPriceLabelBull : t.capPriceLabelBear}
                </label>
                <span className="text-base font-bold text-white tabular-nums tracking-tight whitespace-nowrap">
                  {capArrow}{" "}
                  {formatStrikePrice(
                    activeTicket.capPrice,
                    activeTicket.underlying
                  )}
                </span>
                <span className="text-xs font-semibold text-[#7e8690] tabular-nums whitespace-nowrap">
                  ({capDeltaPct >= 0 ? "+" : ""}
                  {capDeltaPct.toFixed(1)}%)
                </span>
              </div>

              {sliderTiers.length > 1 && (
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    disabled={isBusy || selectedIdx <= 0}
                    aria-label={
                      selectedIdx > 0
                        ? t.stepPrevLabel(
                            formatStrikePrice(
                              sliderTiers[selectedIdx - 1]?.capPrice,
                              activeTicket.underlying
                            )
                          )
                        : t.capPriceLabel
                    }
                    onClick={() => {
                      const prev = sliderTiers[selectedIdx - 1];
                      if (prev) onSelectTarget(prev);
                    }}
                    className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-[#15171b] text-[#b8bec6] hover:bg-[#24282f] hover:text-white disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer focus-visible:outline-2 focus-visible:outline-white/70"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    disabled={isBusy || selectedIdx >= sliderTiers.length - 1}
                    aria-label={
                      selectedIdx < sliderTiers.length - 1
                        ? t.stepNextLabel(
                            formatStrikePrice(
                              sliderTiers[selectedIdx + 1]?.capPrice,
                              activeTicket.underlying
                            )
                          )
                        : t.capPriceLabel
                    }
                    onClick={() => {
                      const next = sliderTiers[selectedIdx + 1];
                      if (next) onSelectTarget(next);
                    }}
                    className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-[#15171b] text-[#b8bec6] hover:bg-[#24282f] hover:text-white disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer focus-visible:outline-2 focus-visible:outline-white/70"
                  >
                    <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>
              )}
            </div>

            {/* Visual Fine-Step Track + Anchor Dots + Native Accessible Range Input */}
            <div className="relative flex h-9 items-center">
              {/* Base track + direction-colored active fill + anchor stop dots spanning thumb centers */}
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-[11px] top-1/2 -translate-y-1/2 h-1 rounded-full bg-[#22262d]"
              >
                <div
                  className="h-full rounded-full transition-[width] duration-100"
                  style={{
                    width: `${sliderProgressPct}%`,
                    backgroundColor: accentColor,
                  }}
                />
                {quickAnchorIndices.map((idx) => {
                  const pct =
                    sliderTiers.length > 1 ? (idx / maxIdx) * 100 : 0;
                  const passed = idx <= selectedIdx;
                  return (
                    <span
                      key={getTargetKey(sliderTiers[idx]!)}
                      className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 block h-2.5 w-2.5 rounded-full"
                      style={{
                        left: `${pct}%`,
                        backgroundColor: passed ? accentColor : "#2c313a",
                        border: `2px solid ${thumbBorderColor}`,
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
                max={maxIdx}
                step={1}
                disabled={isBusy || sliderTiers.length <= 1}
                value={selectedIdx}
                aria-valuetext={`${capArrow} ${formatStrikePrice(activeTicket.capPrice, activeTicket.underlying)}, ${activeTicket.maxMultiplier.toFixed(2)}x`}
                style={quickSliderStyle}
                onChange={(e) => {
                  const nextIdx = Number(e.target.value);
                  const nextTier = sliderTiers[nextIdx];
                  if (nextTier) {
                    onSelectTarget(nextTier);
                  }
                }}
                className="payoff-range--transparent-track relative z-10 w-full cursor-pointer disabled:cursor-not-allowed"
              />
            </div>

            {/* Clickable Anchor Tick Labels aligned directly beneath track dots */}
            <div className="relative mx-[11px] h-7">
              {quickLabelAnchors.map(({ idx, pct, align }) => {
                const item = sliderTiers[idx]!;
                const isSelected = idx === selectedIdx;
                return (
                  <button
                    key={getTargetKey(item)}
                    type="button"
                    disabled={isBusy}
                    aria-pressed={isSelected}
                    onClick={() => onSelectTarget(item)}
                    style={align === "center" ? { left: `${pct}%` } : undefined}
                    className={`absolute top-0 min-h-[26px] whitespace-nowrap rounded-md px-1 py-0.5 text-[11px] tabular-nums transition cursor-pointer disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-white/70 ${
                      align === "left"
                        ? "-left-[11px]"
                        : align === "right"
                          ? "-right-[11px]"
                          : "-translate-x-1/2"
                    } ${
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
        )}
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
            onClick={() => handleQuickAdd(100)}
            className="min-h-[32px] rounded-full bg-[#1e2228] px-2.5 py-1 text-[11.5px] font-semibold text-[#b8bec6] tabular-nums transition hover:bg-[#282d35] hover:text-white cursor-pointer disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-white/70"
          >
            {t.amountQuickAdd100}
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

      {/* 4. Option A: Polymarket-Style "To win" Readout + Compact Red/Green PnL Curve */}
      <MiniPayoffPnlChart
        locale={locale}
        direction={direction}
        ticket={activeTicket}
        spot={spot}
      />

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

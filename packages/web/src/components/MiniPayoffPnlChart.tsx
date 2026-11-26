import { useId, useMemo, useState, type PointerEvent } from "react";
import {
  computeSpreadPayoffFraction,
  type Direction,
  type TicketSummary,
} from "@payoff/shared";
import { formatStrikePrice } from "../lib/format";
import type { Locale } from "../lib/i18n";

export interface MiniPayoffPnlChartProps {
  locale: Locale;
  direction: Direction;
  ticket: TicketSummary;
  spot?: number;
}

const VIEW_W = 328;
const VIEW_H = 58;
const PAD_L = 5;
const PAD_R = 5;
const PAD_T = 7;
const PAD_B = 7;
const PLOT_W = VIEW_W - PAD_L - PAD_R;
const PLOT_H = VIEW_H - PAD_T - PAD_B;

function formatSignedUsd(v: number): string {
  const sign = v >= 0 ? "+" : "−";
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

export function MiniPayoffPnlChart({
  locale,
  direction,
  ticket,
  spot,
}: MiniPayoffPnlChartProps) {
  const isZh = locale === "zh";
  const uid = useId().replace(/:/g, "");
  const isBull = direction === "BULL";

  const [hoverRatio, setHoverRatio] = useState<number | null>(null);

  const lower = ticket.lowerStrike;
  const upper = ticket.upperStrike;
  const width = Math.max(1e-6, upper - lower);
  const stake = Math.max(0.01, ticket.stakeUsdt);
  const maxPayout = Math.max(0, ticket.maxPayoutUsdt);
  const maxNetPnl = maxPayout - stake;
  const liveSpot =
    Number.isFinite(spot) && (spot ?? 0) > 0 ? (spot as number) : ticket.spot;

  const {
    xMin,
    xMax,
    bePrice,
    yZero,
    yLoss,
    yWin,
    xStart,
    xBe,
    xCap,
    xSpot,
    ySpot,
    lossLine,
    lossArea,
    winLine,
    winArea,
  } = useMemo(() => {
    const minX = lower - width * 0.26;
    const maxX = upper + width * 0.26;
    const spanX = Math.max(1e-6, maxX - minX);

    const be =
      Number.isFinite(ticket.breakevenPrice) &&
      ticket.breakevenPrice >= lower &&
      ticket.breakevenPrice <= upper
        ? ticket.breakevenPrice
        : maxPayout > 0
          ? isBull
            ? lower + width * Math.min(1, stake / maxPayout)
            : upper - width * Math.min(1, stake / maxPayout)
          : (lower + upper) / 2;

    const xOf = (px: number) => PAD_L + ((px - minX) / spanX) * PLOT_W;

    const yMin = -stake * 1.15;
    const yMax = Math.max(stake * 0.3, maxNetPnl) * 1.12;
    const ySpan = Math.max(1e-6, yMax - yMin);
    const yOf = (pnl: number) => PAD_T + PLOT_H - ((pnl - yMin) / ySpan) * PLOT_H;

    const y0 = yOf(0);
    const yL = yOf(-stake);
    const yW = yOf(maxNetPnl);

    const startPx = isBull ? lower : upper;
    const capPx = isBull ? upper : lower;
    const xS = xOf(startPx);
    const xB = xOf(be);
    const xC = xOf(capPx);

    const clampedSpot = Math.max(minX, Math.min(maxX, liveSpot));
    const spotFrac = computeSpreadPayoffFraction(isBull, lower, upper, liveSpot);
    const spotPnl = maxPayout * spotFrac - stake;
    const xSp = xOf(clampedSpot);
    const ySp = yOf(spotPnl);

    const xLeft = PAD_L;
    const xRight = VIEW_W - PAD_R;

    let lLine: string;
    let lArea: string;
    let wLine: string;
    let wArea: string;

    if (isBull) {
      lLine = `M ${xLeft},${yL} L ${xS},${yL} L ${xB},${y0}`;
      lArea = `${lLine} L ${xB},${y0} L ${xLeft},${y0} Z`;
      wLine = `M ${xB},${y0} L ${xC},${yW} L ${xRight},${yW}`;
      wArea = `${wLine} L ${xRight},${y0} L ${xB},${y0} Z`;
    } else {
      wLine = `M ${xLeft},${yW} L ${xC},${yW} L ${xB},${y0}`;
      wArea = `${wLine} L ${xB},${y0} L ${xLeft},${y0} Z`;
      lLine = `M ${xB},${y0} L ${xS},${yL} L ${xRight},${yL}`;
      lArea = `${lLine} L ${xRight},${y0} L ${xB},${y0} Z`;
    }

    return {
      xMin: minX,
      xMax: maxX,
      bePrice: be,
      yZero: y0,
      yLoss: yL,
      yWin: yW,
      xStart: xS,
      xBe: xB,
      xCap: xC,
      xSpot: xSp,
      ySpot: ySp,
      lossLine: lLine,
      lossArea: lArea,
      winLine: wLine,
      winArea: wArea,
    };
  }, [isBull, lower, upper, width, stake, maxPayout, maxNetPnl, ticket.breakevenPrice, liveSpot]);

  const hovered = useMemo(() => {
    if (hoverRatio === null) return null;
    const price = xMin + hoverRatio * (xMax - xMin);
    const frac = computeSpreadPayoffFraction(isBull, lower, upper, price);
    const payout = maxPayout * frac;
    const pnl = payout - stake;

    const yMin = -stake * 1.15;
    const yMax = Math.max(stake * 0.3, maxNetPnl) * 1.12;
    const ySpan = Math.max(1e-6, yMax - yMin);
    const cx = PAD_L + hoverRatio * PLOT_W;
    const cy = PAD_T + PLOT_H - ((pnl - yMin) / ySpan) * PLOT_H;

    return { price, payout, pnl, cx, cy };
  }, [hoverRatio, xMin, xMax, isBull, lower, upper, maxPayout, stake, maxNetPnl]);

  const updatePointer = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const padLPx = (PAD_L / VIEW_W) * rect.width;
    const padRPx = (PAD_R / VIEW_W) * rect.width;
    const usable = Math.max(1, rect.width - padLPx - padRPx);
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left - padLPx) / usable));
    setHoverRatio(ratio);
  };

  const startPriceText = formatStrikePrice(ticket.startPrice, ticket.underlying);
  const bePriceText = formatStrikePrice(bePrice, ticket.underlying);
  const capPriceText = formatStrikePrice(ticket.capPrice, ticket.underlying);

  const summaryCaption = isZh
    ? `到期损益曲线：起赚 ${startPriceText}，回本 ${bePriceText}，拿满 ${capPriceText} 最多赢 $${maxPayout.toFixed(2)}（净盈亏 ${formatSignedUsd(maxNetPnl)}）。`
    : `Expiry payoff curve: start ${startPriceText}, breakeven ${bePriceText}, full win $${maxPayout.toFixed(2)} (${formatSignedUsd(maxNetPnl)}) at ${capPriceText}.`;

  const displayPayout = hovered ? hovered.payout : maxPayout;
  const displayPnl = hovered ? hovered.pnl : maxNetPnl;
  const readoutColorClass = hovered
    ? hovered.pnl >= 0
      ? "text-[#2EC26B]"
      : "text-[#E85D4A]"
    : "text-[#2EC26B]";

  const winGradId = `payoff-mini-win-${uid}`;
  const lossGradId = `payoff-mini-loss-${uid}`;

  return (
    <figure className="m-0 rounded-2xl bg-[#0d0f12] border border-[#1d2025] px-3.5 pt-2.5 pb-2 space-y-1.5">
      {/* Top Row: Clean Polymarket-style "To win" + big emerald readout (live-updates on hover) */}
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-xs font-semibold text-[#9aa2ad] tabular-nums">
          {hovered ? (
            <>
              {isZh ? "结算在 " : "At "}
              <strong className="font-semibold text-white">
                {formatStrikePrice(hovered.price, ticket.underlying)}
              </strong>
            </>
          ) : (
            <span>{isZh ? "最多赢" : "To win"}</span>
          )}
        </div>

        <div className="flex items-baseline gap-1.5 tabular-nums">
          <span
            className={`text-[22px] font-bold tracking-[-0.03em] leading-none ${readoutColorClass}`}
          >
            ${displayPayout.toFixed(2)}
          </span>
          <span
            className={`text-[11.5px] font-semibold opacity-85 ${readoutColorClass}`}
          >
            ({formatSignedUsd(displayPnl)})
          </span>
        </div>
      </div>

      {/* Compact Interactive Red/Green PnL Curve (touch-pan-y preserves vertical scroll on mobile) */}
      <svg
        role="img"
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        onPointerMove={updatePointer}
        onPointerDown={updatePointer}
        onPointerLeave={() => setHoverRatio(null)}
        onPointerCancel={() => setHoverRatio(null)}
        className="block h-[58px] w-full cursor-crosshair touch-pan-y select-none"
      >
        <title>{summaryCaption}</title>
        <defs>
          <linearGradient id={winGradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#2EC26B" stopOpacity="0.34" />
            <stop offset="100%" stopColor="#2EC26B" stopOpacity="0.02" />
          </linearGradient>
          <linearGradient id={lossGradId} x1="0" y1="1" x2="0" y2="0">
            <stop offset="0%" stopColor="#E85D4A" stopOpacity="0.28" />
            <stop offset="100%" stopColor="#E85D4A" stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {/* $0 Breakeven baseline */}
        <line
          x1={PAD_L}
          y1={yZero}
          x2={VIEW_W - PAD_R}
          y2={yZero}
          stroke="rgba(230,186,92,0.42)"
          strokeDasharray="3 3"
          strokeWidth={1}
        />

        {/* Loss & Profit fills */}
        <path d={lossArea} fill={`url(#${lossGradId})`} />
        <path d={winArea} fill={`url(#${winGradId})`} />

        {/* Split Loss (coral) & Profit (emerald) strokes */}
        <path
          d={lossLine}
          fill="none"
          stroke="#E85D4A"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d={winLine}
          fill="none"
          stroke="#2EC26B"
          strokeWidth={2.2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Key structural anchor points */}
        <circle cx={xStart} cy={yLoss} r={2.5} fill="#7e8690" />
        <circle cx={xBe} cy={yZero} r={3} fill="#E6BA5C" stroke="#000" strokeWidth={1} />
        <circle cx={xCap} cy={yWin} r={3} fill="#2EC26B" stroke="#000" strokeWidth={1} />

        {/* Live Spot marker */}
        <circle cx={xSpot} cy={ySpot} r={3.2} fill="#ffffff" stroke="#000" strokeWidth={1.2} />

        {/* Hover/scrub indicator */}
        {hovered && (
          <>
            <line
              x1={hovered.cx}
              y1={PAD_T - 2}
              x2={hovered.cx}
              y2={VIEW_H - PAD_B + 2}
              stroke="rgba(255,255,255,0.28)"
              strokeDasharray="2 2"
              strokeWidth={1}
            />
            <circle
              cx={hovered.cx}
              cy={hovered.cy}
              r={4}
              fill={hovered.pnl >= 0 ? "#2EC26B" : "#E85D4A"}
              stroke="#000"
              strokeWidth={1.5}
            />
          </>
        )}
      </svg>

      {/* Bottom 3-Point Axis Coordinates (always low price -> high price left to right) */}
      <div className="flex items-center justify-between gap-2 text-[10.5px] text-[#7e8690] tabular-nums">
        <span className="truncate">
          {isBull
            ? isZh
              ? "起赚 "
              : "Start "
            : isZh
              ? "拿满 "
              : "Full "}
          <strong className="font-semibold text-[#b8bec6]">
            {isBull ? startPriceText : capPriceText}
          </strong>
        </span>
        <span className="shrink-0 text-[#E6BA5C]">
          {isZh ? "回本 " : "BE "}
          <strong className="font-semibold">{bePriceText}</strong>
        </span>
        <span className="truncate text-right">
          {isBull
            ? isZh
              ? "拿满 "
              : "Full "
            : isZh
              ? "起赚 "
              : "Start "}
          <strong className="font-semibold text-[#b8bec6]">
            {isBull ? capPriceText : startPriceText}
          </strong>
        </span>
      </div>

      <figcaption className="payoff-visually-hidden">{summaryCaption}</figcaption>
    </figure>
  );
}

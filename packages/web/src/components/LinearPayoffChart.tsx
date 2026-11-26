import { useId, useMemo, useState, type JSX, type PointerEvent } from "react";
import {
  ASSET_SPECS,
  computeSpreadPayoffFraction,
  type Direction,
  type TicketSummary,
  type UnderlyingSymbol,
} from "@payoff/shared";
import { getCopy, type Locale } from "../lib/i18n";

export interface LinearPayoffChartProps {
  locale: Locale;
  underlying: UnderlyingSymbol;
  direction: Direction;
  spot: number;
  ticket: TicketSummary;
  gridStep?: number;
}

const VIEW_W = 640;
const VIEW_H = 236;
const PAD_L = 46;
const PAD_R = 22;
const PAD_T = 36;
const PAD_B = 34;
const PLOT_W = VIEW_W - PAD_L - PAD_R;
const PLOT_H = VIEW_H - PAD_T - PAD_B;

const PAY_TEAL = "#0e7c72";
const NEG_CRIMSON = "#b54134";
const WARN_AMBER = "#8a6410";
const INK = "#14202a";
const MUTED = "#667080";
const GRID_LINE = "#eef0f2";

type MilestoneKind = "start" | "spot" | "breakeven" | "multiple" | "cap";

interface MilestoneNode {
  id: string;
  kind: MilestoneKind;
  priority: number;
  label: string;
  price: number;
  payoutUsdt: number;
  multiplier: number;
  cx: number;
  cy: number;
  dotColor: string;
  pillText: string;
}

interface PlacedLabel {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  subtext: string;
  accent: string;
  isPrimary: boolean;
}

function formatPriceValue(price: number, underlying: UnderlyingSymbol): string {
  if (!Number.isFinite(price)) return "0";
  const isWhole = Math.abs(price - Math.round(price)) < 0.005;
  const maxFrac = underlying === "BTC" ? 0 : isWhole ? 0 : 2;
  const minFrac = underlying === "BTC" ? 0 : isWhole ? 0 : 2;
  return price.toLocaleString("en-US", {
    minimumFractionDigits: minFrac,
    maximumFractionDigits: maxFrac,
  });
}

function formatAxisPrice(price: number, underlying: UnderlyingSymbol): string {
  if (!Number.isFinite(price)) return "$0";
  return `$${formatPriceValue(price, underlying)}`;
}

function estimateSvgTextWidth(text: string, fontSize: number): number {
  let units = 0;
  for (const ch of text) {
    units += ch.charCodeAt(0) > 255 ? 1.05 : 0.62;
  }
  return units * fontSize;
}

function boxesOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
  padX = 8,
  padY = 5
): boolean {
  return !(
    a.x + a.w + padX <= b.x ||
    b.x + b.w + padX <= a.x ||
    a.y + a.h + padY <= b.y ||
    b.y + b.h + padY <= a.y
  );
}

export function LinearPayoffChart({
  locale,
  underlying,
  direction,
  spot,
  ticket,
  gridStep,
}: LinearPayoffChartProps): JSX.Element {
  const t = getCopy(locale);
  const uid = useId().replace(/:/g, "");
  const rangeKey = `${underlying}-${direction}-${ticket.lowerStrike}-${ticket.upperStrike}`;
  const [scrubState, setScrubState] = useState<{
    key: string;
    price: number;
  } | null>(null);
  const scrubPrice = scrubState?.key === rangeKey ? scrubState.price : null;

  const isBull = direction === "BULL";
  const accent = isBull ? PAY_TEAL : NEG_CRIMSON;
  const accentSoftBg = isBull
    ? "bg-[#e9f3f1] text-[#0e7c72]"
    : "bg-[#fbeeea] text-[#b54134]";

  const lower = ticket.lowerStrike;
  const upper = ticket.upperStrike;
  const width = Math.max(1e-6, upper - lower);
  const stake = Math.max(0.01, ticket.stakeUsdt);
  const maxPayout = Math.max(stake, ticket.maxPayoutUsdt);
  const maxMult = Math.max(1.01, ticket.maxMultiplier);

  const step =
    gridStep && gridStep > 0
      ? gridStep
      : ASSET_SPECS[underlying].defaultDailyStep;
  const deltaUsdPerStep = (step / width) * maxPayout;
  const deltaMultPerStep = deltaUsdPerStep / stake;

  const slopeText = isBull
    ? t.payoffSlopeCall(
        formatPriceValue(step, underlying),
        deltaUsdPerStep.toFixed(2),
        deltaMultPerStep.toFixed(2)
      )
    : t.payoffSlopePut(
        formatPriceValue(step, underlying),
        deltaUsdPerStep.toFixed(2),
        deltaMultPerStep.toFixed(2)
      );

  const xMin = lower - width * (isBull ? 0.18 : 0.28);
  const xMax = upper + width * (isBull ? 0.28 : 0.18);
  const xSpan = Math.max(1e-6, xMax - xMin);
  const yMax = Math.max(2.1, maxMult * 1.26);

  const xOf = (price: number) => PAD_L + ((price - xMin) / xSpan) * PLOT_W;
  const yOf = (mult: number) => PAD_T + PLOT_H - (mult / yMax) * PLOT_H;
  const priceOfX = (svgX: number) => {
    const ratio = Math.max(0, Math.min(1, (svgX - PAD_L) / PLOT_W));
    return xMin + ratio * xSpan;
  };

  const evalAtPrice = (price: number) => {
    const frac = computeSpreadPayoffFraction(isBull, lower, upper, price);
    const payoutUsdt = maxPayout * frac;
    const multiplier = stake > 0 ? payoutUsdt / stake : maxMult * frac;
    return { frac, payoutUsdt, multiplier };
  };

  const breakevenPrice = useMemo(() => {
    if (
      Number.isFinite(ticket.breakevenPrice) &&
      ticket.breakevenPrice >= lower &&
      ticket.breakevenPrice <= upper
    ) {
      return ticket.breakevenPrice;
    }
    const ratio = Math.min(1, stake / maxPayout);
    return isBull ? lower + width * ratio : upper - width * ratio;
  }, [ticket.breakevenPrice, lower, upper, stake, maxPayout, isBull, width]);

  const { milestones, placedLabels, pillMilestones } = useMemo(() => {
    const list: MilestoneNode[] = [];

    const startP = ticket.startPrice;
    list.push({
      id: "start",
      kind: "start",
      priority: 5,
      label: t.payoffMilestoneStart,
      price: startP,
      payoutUsdt: 0,
      multiplier: 0,
      cx: xOf(startP),
      cy: yOf(0),
      dotColor: MUTED,
      pillText: "0x",
    });

    if (Number.isFinite(spot) && spot >= xMin && spot <= xMax) {
      const spotEval = evalAtPrice(spot);
      list.push({
        id: "spot",
        kind: "spot",
        priority: 3,
        label: t.payoffMilestoneSpot,
        price: spot,
        payoutUsdt: spotEval.payoutUsdt,
        multiplier: spotEval.multiplier,
        cx: xOf(spot),
        cy: yOf(spotEval.multiplier),
        dotColor: INK,
        pillText: `${spotEval.multiplier.toFixed(2)}x`,
      });
    }

    list.push({
      id: "breakeven",
      kind: "breakeven",
      priority: 2,
      label: t.payoffMilestoneBreakeven,
      price: breakevenPrice,
      payoutUsdt: stake,
      multiplier: 1,
      cx: xOf(breakevenPrice),
      cy: yOf(1),
      dotColor: WARN_AMBER,
      pillText: "1x",
    });

    const maxWhole = Math.floor(maxMult - 0.14);
    const multValues: number[] = [];
    if (maxWhole >= 2) {
      if (maxWhole <= 5) {
        for (let m = 2; m <= maxWhole; m++) multValues.push(m);
      } else {
        const stride = Math.ceil((maxWhole - 1) / 3);
        for (let m = 2; m <= maxWhole; m += stride) multValues.push(m);
      }
    }

    for (const m of multValues) {
      const frac = Math.min(1, m / maxMult);
      const px = isBull ? lower + width * frac : upper - width * frac;
      list.push({
        id: `mult-${m}`,
        kind: "multiple",
        priority: 4,
        label: `${m}x`,
        price: px,
        payoutUsdt: stake * m,
        multiplier: m,
        cx: xOf(px),
        cy: yOf(m),
        dotColor: accent,
        pillText: `${m}x`,
      });
    }

    const capP = ticket.capPrice;
    list.push({
      id: "cap",
      kind: "cap",
      priority: 1,
      label: t.payoffMilestoneCap,
      price: capP,
      payoutUsdt: maxPayout,
      multiplier: maxMult,
      cx: xOf(capP),
      cy: yOf(maxMult),
      dotColor: accent,
      pillText: `${maxMult.toFixed(2)}x`,
    });

    const candidates = list
      .filter((m) => m.kind !== "start")
      .sort((a, b) => a.priority - b.priority);

    const placed: PlacedLabel[] = [];
    const labelH = 26;

    for (const node of candidates) {
      const primaryText =
        node.kind === "cap"
          ? `${node.label} ${node.multiplier.toFixed(2)}x`
          : node.label;
      const subtext = formatAxisPrice(node.price, underlying);
      const labelW = Math.max(
        58,
        Math.min(
          142,
          Math.ceil(
            Math.max(
              estimateSvgTextWidth(primaryText, 9.5),
              estimateSvgTextWidth(subtext, 9)
            ) + 16
          )
        )
      );

      const slots: Array<{ x: number; y: number }> = [
        { x: node.cx - labelW / 2, y: node.cy - labelH - 10 },
        {
          x: isBull ? node.cx - labelW - 6 : node.cx + 8,
          y: node.cy - labelH - 6,
        },
        {
          x: isBull ? node.cx + 8 : node.cx - labelW - 6,
          y: node.cy - labelH - 6,
        },
        { x: node.cx - labelW / 2, y: node.cy + 11 },
        {
          x: isBull ? node.cx + 8 : node.cx - labelW - 6,
          y: node.cy + 10,
        },
      ];

      let chosen: { x: number; y: number } | null = null;
      for (const slot of slots) {
        const clampedX = Math.max(
          PAD_L + 2,
          Math.min(VIEW_W - PAD_R - labelW - 2, slot.x)
        );
        const clampedY = Math.max(
          4,
          Math.min(PAD_T + PLOT_H - labelH - 2, slot.y)
        );
        const rect = { x: clampedX, y: clampedY, w: labelW, h: labelH };
        const hitsExisting = placed.some((p) => boxesOverlap(rect, p));
        if (!hitsExisting) {
          chosen = { x: clampedX, y: clampedY };
          break;
        }
      }

      if (chosen) {
        placed.push({
          id: node.id,
          x: chosen.x,
          y: chosen.y,
          w: labelW,
          h: labelH,
          text: primaryText,
          subtext,
          accent: node.dotColor,
          isPrimary: node.kind === "cap" || node.kind === "breakeven",
        });
      }
    }

    const pills = [...list].sort((a, b) => {
      if (a.multiplier !== b.multiplier) return a.multiplier - b.multiplier;
      return a.priority - b.priority;
    });

    return { milestones: list, placedLabels: placed, pillMilestones: pills };
  }, [
    ticket.startPrice,
    ticket.capPrice,
    spot,
    xMin,
    xMax,
    breakevenPrice,
    stake,
    maxMult,
    maxPayout,
    isBull,
    lower,
    upper,
    width,
    accent,
    underlying,
    t.payoffMilestoneStart,
    t.payoffMilestoneSpot,
    t.payoffMilestoneBreakeven,
    t.payoffMilestoneCap,
  ]);

  const xLeft = xOf(xMin);
  const xRight = xOf(xMax);
  const xStart = xOf(ticket.startPrice);
  const xBe = xOf(breakevenPrice);
  const xCap = xOf(ticket.capPrice);
  const y0 = yOf(0);
  const y1 = yOf(1);
  const yCap = yOf(maxMult);

  const profitAreaPath = isBull
    ? `M ${xBe} ${y1} L ${xCap} ${yCap} L ${xRight} ${yCap} L ${xRight} ${y1} Z`
    : `M ${xLeft} ${y1} L ${xLeft} ${yCap} L ${xCap} ${yCap} L ${xBe} ${y1} Z`;

  const bufferAreaPath = isBull
    ? `M ${xStart} ${y0} L ${xBe} ${y1} L ${xBe} ${y0} Z`
    : `M ${xBe} ${y0} L ${xBe} ${y1} L ${xStart} ${y0} Z`;

  const zeroTailPath = isBull
    ? `M ${xLeft} ${y0} L ${xStart} ${y0}`
    : `M ${xStart} ${y0} L ${xRight} ${y0}`;
  const bufferRampPath = `M ${xStart} ${y0} L ${xBe} ${y1}`;
  const profitRampPath = isBull
    ? `M ${xBe} ${y1} L ${xCap} ${yCap} L ${xRight} ${yCap}`
    : `M ${xLeft} ${yCap} L ${xCap} ${yCap} L ${xBe} ${y1}`;

  const yTicks = [
    { mult: 0, label: "0x", color: MUTED },
    { mult: 1, label: "1x", color: WARN_AMBER },
    ...(Math.abs(yOf(maxMult) - yOf(1)) >= 14
      ? [{ mult: maxMult, label: `${maxMult.toFixed(1)}x`, color: accent }]
      : []),
  ];

  const updateFromPointer = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const svgX = ((e.clientX - rect.left) / rect.width) * VIEW_W;
    const nextPrice = priceOfX(svgX);
    setScrubState({ key: rangeKey, price: nextPrice });
  };

  const activeScrub = useMemo(() => {
    if (scrubPrice === null) return null;
    const clamped = Math.max(xMin, Math.min(xMax, scrubPrice));
    const res = evalAtPrice(clamped);
    const cx = xOf(clamped);
    const cy = yOf(res.multiplier);
    const line1 = `${t.payoffHoverExpiryPrice}: ${formatAxisPrice(clamped, underlying)}`;
    const line2 = `${t.payoffHoverPayout}: $${res.payoutUsdt.toFixed(2)} (${res.multiplier.toFixed(2)}x)`;
    const boxW = Math.max(
      172,
      Math.min(
        260,
        Math.ceil(
          Math.max(
            estimateSvgTextWidth(line1, 10),
            estimateSvgTextWidth(line2, 10)
          ) + 24
        )
      )
    );
    const boxH = 42;
    const preferLeft = cx > VIEW_W - PAD_R - boxW - 14;
    const boxX = Math.max(
      PAD_L + 4,
      Math.min(
        VIEW_W - PAD_R - boxW - 4,
        preferLeft ? cx - boxW - 10 : cx + 10
      )
    );
    const boxY = Math.max(6, Math.min(PAD_T + PLOT_H - boxH - 6, cy - boxH / 2));
    return {
      price: clamped,
      payoutUsdt: res.payoutUsdt,
      multiplier: res.multiplier,
      cx,
      cy,
      boxX,
      boxY,
      boxW,
      boxH,
    };
  }, [
    scrubPrice,
    xMin,
    xMax,
    isBull,
    lower,
    upper,
    maxPayout,
    stake,
    maxMult,
    underlying,
    t.payoffHoverExpiryPrice,
    t.payoffHoverPayout,
  ]);

  const spotInRange = Number.isFinite(spot) && spot >= xMin && spot <= xMax;

  const accessibleSummary = `${t.payoffChartTitle}. ${slopeText}. ${t.payoffMilestoneStart}: ${formatAxisPrice(ticket.startPrice, underlying)} (0x). ${t.payoffMilestoneBreakeven}: ${formatAxisPrice(breakevenPrice, underlying)} (1x). ${t.payoffMilestoneCap}: ${formatAxisPrice(ticket.capPrice, underlying)} (${maxMult.toFixed(2)}x, $${maxPayout.toFixed(2)} USDT).`;

  const gradProfitId = `payoff-profit-${uid}`;
  const gradBufferId = `payoff-buffer-${uid}`;

  return (
    <figure className="rounded-xl border border-[#e2e5e8] bg-white p-4 space-y-3">
      {/* Header: Title + Plain-Language Slope Formula */}
      <figcaption className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-[#14202a]">
            {t.payoffChartTitle}
          </span>
          <span
            className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-semibold tabular-nums ${accentSoftBg}`}
          >
            {slopeText}
          </span>
        </div>

        {/* Zone Legend */}
        <div className="flex items-center gap-3 text-[11px] font-medium text-[#667080]">
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="inline-block h-2 w-2 rounded-xs"
              style={{
                backgroundColor: isBull
                  ? "rgba(14, 124, 114, 0.35)"
                  : "rgba(181, 65, 52, 0.32)",
                border: `1px solid ${accent}`,
              }}
            />
            {t.payoffZoneProfit}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="inline-block h-2 w-2 rounded-xs border border-[#c9b382] bg-[#f6efd9]"
            />
            {t.payoffZoneBuffer}
          </span>
        </div>
      </figcaption>

      {/* Responsive Pure SVG Linear Payoff Ladder */}
      <div className="relative w-full select-none">
        <svg
          role="img"
          aria-label={accessibleSummary}
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          className="block w-full h-auto touch-pan-y cursor-crosshair"
          onPointerMove={updateFromPointer}
          onPointerDown={updateFromPointer}
          onPointerLeave={() => setScrubState(null)}
          onPointerCancel={() => setScrubState(null)}
        >
          <title>{accessibleSummary}</title>
          <defs>
            <linearGradient id={gradProfitId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={accent} stopOpacity="0.22" />
              <stop offset="100%" stopColor={accent} stopOpacity="0.03" />
            </linearGradient>
            <linearGradient id={gradBufferId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#c9a552" stopOpacity="0.20" />
              <stop offset="100%" stopColor="#c9a552" stopOpacity="0.04" />
            </linearGradient>
          </defs>

          {/* Horizontal Gridlines & Y-Axis Labels */}
          {yTicks.map((tick) => {
            const ty = yOf(tick.mult);
            const isBe = tick.mult === 1;
            return (
              <g key={tick.label}>
                <line
                  x1={PAD_L}
                  y1={ty}
                  x2={VIEW_W - PAD_R}
                  y2={ty}
                  stroke={isBe ? WARN_AMBER : GRID_LINE}
                  strokeWidth={isBe ? 1.25 : 1}
                  strokeOpacity={isBe ? 0.65 : 1}
                  strokeDasharray={isBe ? "4 4" : undefined}
                />
                <text
                  x={PAD_L - 8}
                  y={ty + 3.5}
                  textAnchor="end"
                  fontSize={10}
                  fontWeight={isBe || tick.mult === maxMult ? 600 : 500}
                  fill={tick.color}
                  style={{ fontVariantNumeric: "tabular-nums" }}
                >
                  {tick.label}
                </text>
              </g>
            );
          })}

          {/* Shaded Profit (>1x) & Buffer (0~1x) Areas */}
          <path d={bufferAreaPath} fill={`url(#${gradBufferId})`} />
          <path d={profitAreaPath} fill={`url(#${gradProfitId})`} />

          {/* Vertical Subtle Guides for Start, Breakeven, Cap, and Spot */}
          <line
            x1={xStart}
            y1={y0}
            x2={xStart}
            y2={y0 + 6}
            stroke="#94a0ad"
            strokeWidth={1}
          />
          <line
            x1={xBe}
            y1={y1}
            x2={xBe}
            y2={y0}
            stroke={WARN_AMBER}
            strokeWidth={1}
            strokeOpacity={0.35}
            strokeDasharray="2 3"
          />
          <line
            x1={xCap}
            y1={yCap}
            x2={xCap}
            y2={y0}
            stroke={accent}
            strokeWidth={1}
            strokeOpacity={0.28}
            strokeDasharray="2 3"
          />
          {spotInRange && (
            <line
              x1={xOf(spot)}
              y1={PAD_T}
              x2={xOf(spot)}
              y2={y0}
              stroke={INK}
              strokeWidth={1}
              strokeOpacity={0.22}
              strokeDasharray="2 3"
            />
          )}

          {/* Payoff Curve Segments */}
          <path
            d={zeroTailPath}
            fill="none"
            stroke="#c8ccd1"
            strokeWidth={2}
            strokeLinecap="round"
          />
          <path
            d={bufferRampPath}
            fill="none"
            stroke={WARN_AMBER}
            strokeWidth={2.5}
            strokeLinecap="round"
          />
          <path
            d={profitRampPath}
            fill="none"
            stroke={accent}
            strokeWidth={2.75}
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          {/* Milestone Dots */}
          {milestones.map((m) => {
            if (m.kind === "start") {
              return (
                <circle
                  key={m.id}
                  cx={m.cx}
                  cy={m.cy}
                  r={3.5}
                  fill="#ffffff"
                  stroke={MUTED}
                  strokeWidth={2}
                />
              );
            }
            if (m.kind === "spot") {
              return (
                <g key={m.id}>
                  <circle
                    cx={m.cx}
                    cy={m.cy}
                    r={6.5}
                    fill={INK}
                    fillOpacity={0.12}
                  />
                  <circle
                    cx={m.cx}
                    cy={m.cy}
                    r={3.8}
                    fill="#ffffff"
                    stroke={INK}
                    strokeWidth={2.2}
                  />
                </g>
              );
            }
            const isCap = m.kind === "cap";
            return (
              <g key={m.id}>
                {isCap && (
                  <circle
                    cx={m.cx}
                    cy={m.cy}
                    r={7.5}
                    fill={accent}
                    fillOpacity={0.15}
                  />
                )}
                <circle
                  cx={m.cx}
                  cy={m.cy}
                  r={isCap ? 4.5 : 3.8}
                  fill={m.dotColor}
                  stroke="#ffffff"
                  strokeWidth={1.8}
                />
              </g>
            );
          })}

          {/* Non-overlapping Milestone Callouts */}
          <g opacity={activeScrub ? 0.35 : 1}>
            {placedLabels.map((lbl) => (
              <g key={lbl.id}>
                <rect
                  x={lbl.x}
                  y={lbl.y}
                  width={lbl.w}
                  height={lbl.h}
                  rx={6}
                  fill="#ffffff"
                  fillOpacity={0.94}
                  stroke={lbl.isPrimary ? lbl.accent : "#e2e5e8"}
                  strokeOpacity={lbl.isPrimary ? 0.45 : 1}
                  strokeWidth={1}
                />
                <text
                  x={lbl.x + lbl.w / 2}
                  y={lbl.y + 11}
                  textAnchor="middle"
                  fontSize={9.5}
                  fontWeight={700}
                  fill={lbl.accent}
                  style={{ fontVariantNumeric: "tabular-nums" }}
                >
                  {lbl.text}
                </text>
                <text
                  x={lbl.x + lbl.w / 2}
                  y={lbl.y + 21.5}
                  textAnchor="middle"
                  fontSize={9}
                  fontWeight={500}
                  fill={MUTED}
                  style={{ fontVariantNumeric: "tabular-nums" }}
                >
                  {lbl.subtext}
                </text>
              </g>
            ))}
          </g>

          {/* X-Axis Key Price Ticks */}
          {(() => {
            const startTickLabel = `${t.payoffMilestoneStart} ${formatAxisPrice(ticket.startPrice, underlying)}`;
            const capTickLabel = `${t.payoffMilestoneCap} ${formatAxisPrice(ticket.capPrice, underlying)}`;
            const startHalf = estimateSvgTextWidth(startTickLabel, 10) / 2;
            const capHalf = estimateSvgTextWidth(capTickLabel, 10) / 2;
            const startLabelX = Math.max(
              PAD_L + startHalf,
              Math.min(VIEW_W - PAD_R - startHalf, xStart)
            );
            const capLabelX = Math.max(
              PAD_L + capHalf,
              Math.min(VIEW_W - PAD_R - capHalf, xCap)
            );
            const showCapAxisLabel =
              Math.abs(capLabelX - startLabelX) > startHalf + capHalf + 12;
            return (
              <g>
                <text
                  x={startLabelX}
                  y={VIEW_H - 12}
                  textAnchor="middle"
                  fontSize={10}
                  fontWeight={600}
                  fill={MUTED}
                  style={{ fontVariantNumeric: "tabular-nums" }}
                >
                  {startTickLabel}
                </text>
                {showCapAxisLabel && (
                  <text
                    x={capLabelX}
                    y={VIEW_H - 12}
                    textAnchor="middle"
                    fontSize={10}
                    fontWeight={600}
                    fill={accent}
                    style={{ fontVariantNumeric: "tabular-nums" }}
                  >
                    {capTickLabel}
                  </text>
                )}
              </g>
            );
          })()}

          {/* Scrub Crosshair & Expiry Payout Readout */}
          {activeScrub && (
            <g pointerEvents="none">
              <line
                x1={activeScrub.cx}
                y1={PAD_T - 4}
                x2={activeScrub.cx}
                y2={y0}
                stroke={INK}
                strokeWidth={1}
                strokeDasharray="3 3"
                strokeOpacity={0.55}
              />
              <circle
                cx={activeScrub.cx}
                cy={activeScrub.cy}
                r={5.5}
                fill={
                  activeScrub.multiplier >= 1
                    ? accent
                    : activeScrub.multiplier > 0
                      ? WARN_AMBER
                      : MUTED
                }
                stroke="#ffffff"
                strokeWidth={2}
              />
              <rect
                x={activeScrub.boxX}
                y={activeScrub.boxY}
                width={activeScrub.boxW}
                height={activeScrub.boxH}
                rx={8}
                fill={INK}
                fillOpacity={0.95}
              />
              <text
                x={activeScrub.boxX + 10}
                y={activeScrub.boxY + 16}
                fontSize={10}
                fontWeight={500}
                fill="#c8ccd1"
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {t.payoffHoverExpiryPrice}:{" "}
                <tspan fill="#ffffff" fontWeight={700}>
                  {formatAxisPrice(activeScrub.price, underlying)}
                </tspan>
              </text>
              <text
                x={activeScrub.boxX + 10}
                y={activeScrub.boxY + 32}
                fontSize={10}
                fontWeight={500}
                fill="#c8ccd1"
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {t.payoffHoverPayout}:{" "}
                <tspan
                  fill={
                    activeScrub.multiplier >= 1
                      ? isBull
                        ? "#5eead4"
                        : "#fca5a5"
                      : "#fde68a"
                  }
                  fontWeight={700}
                >
                  ${activeScrub.payoutUsdt.toFixed(2)} (
                  {activeScrub.multiplier.toFixed(2)}x)
                </tspan>
              </text>
            </g>
          )}
        </svg>
      </div>

      {/* Compact Milestone Pill Strip */}
      <ul
        role="list"
        className="flex flex-wrap items-center gap-1.5 border-t border-[#eef0f2] pt-2.5"
      >
        {pillMilestones.map((m) => {
          const isSelected =
            scrubPrice !== null && Math.abs(scrubPrice - m.price) < width * 0.01;
          return (
            <li key={m.id}>
              <button
                type="button"
                aria-pressed={isSelected}
                onClick={() =>
                  setScrubState((prev) =>
                    prev?.key === rangeKey &&
                    Math.abs(prev.price - m.price) < width * 0.01
                      ? null
                      : { key: rangeKey, price: m.price }
                  )
                }
                className={`inline-flex min-h-7 items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] tabular-nums transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#14202a] ${
                  isSelected
                    ? "border-[#14202a] bg-[#14202a] text-white"
                    : m.kind === "cap"
                      ? isBull
                        ? "border-[#0e7c72]/25 bg-[#e9f3f1] text-[#0e7c72] hover:border-[#0e7c72]/50"
                        : "border-[#b54134]/25 bg-[#fbeeea] text-[#b54134] hover:border-[#b54134]/50"
                      : m.kind === "breakeven"
                        ? "border-[#8a6410]/25 bg-[#fbf3dd] text-[#8a6410] hover:border-[#8a6410]/50"
                        : "border-[#e2e5e8] bg-[#f7f8f9] text-[#3a4552] hover:border-[#c8ccd1]"
                }`}
              >
                <span
                  aria-hidden="true"
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{
                    backgroundColor: isSelected ? "#ffffff" : m.dotColor,
                  }}
                />
                <span className="font-semibold">{m.label}</span>
                <span className={isSelected ? "text-[#e2e5e8]" : "text-[#667080]"}>
                  {formatAxisPrice(m.price, underlying)}
                </span>
                {m.kind !== "multiple" && m.kind !== "breakeven" && (
                  <span
                    className={`font-semibold ${
                      isSelected ? "text-white" : "text-[#14202a]"
                    }`}
                  >
                    {m.pillText}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </figure>
  );
}

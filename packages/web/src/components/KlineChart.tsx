import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { X } from "lucide-react";
import {
  computeSpreadPayoffFraction,
  type CandlePoint,
  type PositionView,
  type TicketSummary,
  type UnderlyingSymbol,
} from "@payoff/shared";
import { formatStrikePrice } from "../lib/format";
import { getCopy, type Locale } from "../lib/i18n";

export interface KlineChartProps {
  locale: Locale;
  candles: CandlePoint[];
  ticket?: TicketSummary;
  liveSpot?: number;
  expiry?: number;
  expiryLabel?: string;
  nowSec?: number;
  windowLabel?: string;
  positions?: PositionView[];
  selectedPositionId?: string | null;
  onSelectPosition?: (positionId: string | null) => void;
  inTwapWindow?: boolean;
  twapAvgPrice?: number | null;
  scrubPrice?: number | null;
  onScrubPriceChange?: (price: number | null) => void;
  height?: number;
}

const UP_GREEN = "#2EC26B";
const DOWN_CORAL = "#E85D4A";
const GOLD = "#E6BA5C";
const MID_TEXT = "#B8BEC6";
const SUB_TEXT = "#7E8690";

interface YDomain {
  min: number;
  max: number;
}

interface EditorialBlock {
  id: "cap" | "be" | "start";
  targetY: number;
  halfH: number;
  line1: string;
  line2?: string;
  color: string;
  bold: boolean;
  fontSize: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function formatHoverTime(unixSec: number, locale: Locale): string {
  if (!Number.isFinite(unixSec) || unixSec <= 0) return "";
  try {
    return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(unixSec * 1000));
  } catch {
    return "";
  }
}

/**
 * Resolves vertical collisions among top-to-bottom sorted editorial labels
 * so Cap, Breakeven, and Start NEVER overlap or clip outside [minY, maxY].
 */
function layoutEditorialLabels(
  blocks: EditorialBlock[],
  minY: number,
  maxY: number
): Array<EditorialBlock & { y: number }> {
  if (blocks.length === 0) return [];
  const gap = 4;
  const sorted = [...blocks]
    .sort((a, b) => a.targetY - b.targetY)
    .map((b) => ({
      ...b,
      y: clamp(b.targetY, minY + b.halfH, maxY - b.halfH),
    }));

  // Forward pass: push downward if overlapping previous block
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    const minAllowed = prev.y + prev.halfH + gap + cur.halfH;
    if (cur.y < minAllowed) {
      cur.y = minAllowed;
    }
  }

  // Clamp bottom and backward pass: pull upward cleanly if pushed past bottom
  const last = sorted[sorted.length - 1];
  if (last.y > maxY - last.halfH) {
    last.y = maxY - last.halfH;
    for (let i = sorted.length - 2; i >= 0; i--) {
      const next = sorted[i + 1];
      const cur = sorted[i];
      const maxAllowed = next.y - next.halfH - gap - cur.halfH;
      if (cur.y > maxAllowed) {
        cur.y = maxAllowed;
      }
    }
  }

  // Final soft clamp to top
  if (sorted[0].y < minY + sorted[0].halfH) {
    sorted[0].y = minY + sorted[0].halfH;
  }

  return sorted;
}

export function KlineChart({
  locale,
  candles,
  ticket,
  liveSpot,
  expiryLabel,
  windowLabel,
  positions,
  selectedPositionId = null,
  onSelectPosition,
  inTwapWindow = false,
  twapAvgPrice = null,
  scrubPrice: controlledScrubPrice,
  onScrubPriceChange,
  height = 236,
}: KlineChartProps) {
  const t = getCopy(locale);
  const uid = useId().replace(/:/g, "");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState<number>(390);

  const [internalScrubPrice, setInternalScrubPrice] = useState<number | null>(
    null
  );
  const [isDraggingScrub, setIsDraggingScrub] = useState(false);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const isControlledScrub = controlledScrubPrice !== undefined;
  const activeScrubPrice = isControlledScrub
    ? controlledScrubPrice
    : internalScrubPrice;

  const setScrubPrice = useCallback(
    (next: number | null) => {
      if (!isControlledScrub) {
        setInternalScrubPrice(next);
      }
      onScrubPriceChange?.(next);
    },
    [isControlledScrub, onScrubPriceChange]
  );

  // Measure container width 1:1 CSS pixels
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const nextW = Math.round(el.clientWidth);
      if (nextW > 80) setWidth(nextW);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const activePositions = useMemo(
    () =>
      (positions ?? []).filter(
        (p) => p.status === "ACTIVE" && p.remainingBalanceUsdt > 0
      ),
    [positions]
  );

  const selectedPosition = useMemo(
    () =>
      selectedPositionId
        ? activePositions.find(
            (p) =>
              p.tokenId === selectedPositionId ||
              p.seriesId === selectedPositionId
          ) ?? null
        : null,
    [activePositions, selectedPositionId]
  );

  const activeDirection =
    selectedPosition?.direction ?? ticket?.direction ?? "BULL";
  const isBull = activeDirection === "BULL";
  const lineColor = inTwapWindow ? GOLD : isBull ? UP_GREEN : DOWN_CORAL;
  const underlying: UnderlyingSymbol | undefined =
    selectedPosition?.underlying ?? ticket?.underlying;

  // Build normalized price points anchored to liveSpot at the right end of past zone
  const seriesPoints = useMemo(() => {
    if (candles.length === 0) {
      if (liveSpot && Number.isFinite(liveSpot) && liveSpot > 0) {
        const now = Math.floor(Date.now() / 1000);
        return [
          { time: now - 3600, price: liveSpot },
          { time: now, price: liveSpot },
        ];
      }
      return [];
    }
    const pts = candles.map((c, idx) => ({
      time: c.time,
      price:
        idx === candles.length - 1 &&
        liveSpot &&
        Number.isFinite(liveSpot) &&
        liveSpot > 0
          ? liveSpot
          : c.close,
    }));
    if (pts.length === 1) {
      return [
        { time: pts[0].time - 900, price: pts[0].price },
        pts[0],
      ];
    }
    return pts;
  }, [candles, liveSpot]);

  // Compute target Y domain spanning candles, liveSpot, ticket strikes, positions, and TWAP
  const targetDomain = useMemo<YDomain>(() => {
    const vals: number[] = [];
    let candleMin = Infinity;
    let candleMax = -Infinity;

    for (const pt of seriesPoints) {
      if (Number.isFinite(pt.price) && pt.price > 0) {
        vals.push(pt.price);
        if (pt.price < candleMin) candleMin = pt.price;
        if (pt.price > candleMax) candleMax = pt.price;
      }
    }
    if (liveSpot && Number.isFinite(liveSpot) && liveSpot > 0) {
      vals.push(liveSpot);
    }
    if (ticket) {
      if (Number.isFinite(ticket.lowerStrike)) vals.push(ticket.lowerStrike);
      if (Number.isFinite(ticket.upperStrike)) vals.push(ticket.upperStrike);
      if (Number.isFinite(ticket.breakevenPrice)) {
        vals.push(ticket.breakevenPrice);
      }
    }
    for (const p of activePositions) {
      if (Number.isFinite(p.lowerStrike)) vals.push(p.lowerStrike);
      if (Number.isFinite(p.upperStrike)) vals.push(p.upperStrike);
    }
    if (
      inTwapWindow &&
      twapAvgPrice &&
      Number.isFinite(twapAvgPrice) &&
      twapAvgPrice > 0
    ) {
      vals.push(twapAvgPrice);
    }

    if (vals.length === 0) {
      return { min: 0, max: 100 };
    }

    let rawMin = Math.min(...vals);
    let rawMax = Math.max(...vals);
    let span = rawMax - rawMin;

    const mid = (rawMin + rawMax) / 2 || 1;
    if (span < mid * 0.002) {
      const half = Math.max(0.5, mid * 0.006);
      rawMin = mid - half;
      rawMax = mid + half;
      span = rawMax - rawMin;
    }

    // Keep breathing room (~14%), tightening slightly to 10% if a wide strike tier dominates
    // so historical price movement stays clearly legible while every strike remains in-viewport.
    const candleSpan =
      Number.isFinite(candleMin) && Number.isFinite(candleMax)
        ? candleMax - candleMin
        : span;
    const padRatio = candleSpan > 0 && candleSpan / span < 0.16 ? 0.1 : 0.14;
    const pad = span * padRatio;

    return {
      min: Math.max(0, rawMin - pad),
      max: rawMax + pad,
    };
  }, [seriesPoints, liveSpot, ticket, activePositions, inTwapWindow, twapAvgPrice]);

  // Smooth rAF interpolation (~180ms cubic ease-out) of [yMin, yMax] on tier/direction/expiry changes
  const [domain, setDomain] = useState<YDomain>(targetDomain);
  const domainRef = useRef<YDomain>(targetDomain);
  const hasInitDomainRef = useRef(false);

  useEffect(() => {
    const prefersReduced =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    if (!hasInitDomainRef.current || prefersReduced) {
      hasInitDomainRef.current = true;
      domainRef.current = targetDomain;
      setDomain(targetDomain);
      return;
    }

    const from = domainRef.current;
    const to = targetDomain;
    if (
      Math.abs(from.min - to.min) < 1e-6 &&
      Math.abs(from.max - to.max) < 1e-6
    ) {
      return;
    }

    // Snap instantly if switching between totally different asset scales (e.g. BTC -> ETH -> NVDA)
    const fromMid = (from.min + from.max) / 2 || 1;
    const toMid = (to.min + to.max) / 2 || 1;
    if (Math.abs(toMid - fromMid) / Math.max(fromMid, toMid) > 0.35) {
      domainRef.current = to;
      setDomain(to);
      return;
    }

    let rafId = 0;
    const durationMs = 180;
    const startTs = performance.now();

    const tick = (now: number) => {
      const rawT = Math.min(1, (now - startTs) / durationMs);
      const eased = 1 - Math.pow(1 - rawT, 3);
      const next: YDomain = {
        min: from.min + (to.min - from.min) * eased,
        max: from.max + (to.max - from.max) * eased,
      };
      domainRef.current = next;
      setDomain(next);
      if (rawT < 1) {
        rafId = requestAnimationFrame(tick);
      }
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [targetDomain]);

  // Spatial Split Geometry (exact 1:1 CSS pixels matching v7-S-final.png)
  const isNarrow = width < 440;
  const visibleBars = activePositions.slice(0, 5);
  const hasBars = visibleBars.length > 0;
  const canScrub = Boolean(ticket || activePositions.length > 0);
  const barsBlockW = hasBars ? visibleBars.length * 7 + 10 : 0;

  // Compact label text when position bars share a narrow mobile screen
  const compactLabels = isNarrow && hasBars;
  const labelColW = isNarrow
    ? compactLabels
      ? Math.max(70, Math.round(width * 0.19))
      : Math.max(96, Math.round(width * 0.26))
    : Math.min(138, Math.max(112, Math.round(width * 0.18)));

  const expiryX = Math.round(
    clamp(
      width - labelColW - (hasBars ? barsBlockW + (canScrub ? 6 : 0) : 0),
      width * 0.64,
      width - 72
    )
  );
  const nowX = Math.round(
    clamp(
      width * (isNarrow ? 0.535 : 0.6),
      80,
      expiryX - (isNarrow ? 54 : 76)
    )
  );
  const futureW = Math.max(24, expiryX - nowX);

  const barStartX = expiryX + (canScrub ? 14 : 8);
  const labelX = hasBars
    ? barStartX + visibleBars.length * 7 + 6
    : expiryX + 10;

  const padTop = 22;
  const padBottom = 18;
  const plotH = Math.max(40, height - padTop - padBottom);
  const domainSpan = Math.max(1e-6, domain.max - domain.min);

  const yOf = useCallback(
    (price: number): number => {
      const ratio = (domain.max - price) / domainSpan;
      return padTop + clamp(ratio, -0.05, 1.05) * plotH;
    },
    [domain.max, domainSpan, plotH]
  );

  const priceOfY = useCallback(
    (y: number): number => {
      const ratio = clamp((y - padTop) / plotH, 0, 1);
      return domain.max - ratio * domainSpan;
    },
    [domain.max, domainSpan, plotH]
  );

  // Build smooth SVG polyline & area paths for Left Past Zone [0 .. nowX]
  const { linePath, areaPath, lastPt, refPriceY, plottedPoints } = useMemo(() => {
    if (seriesPoints.length === 0) {
      return {
        linePath: "",
        areaPath: "",
        lastPt: null as { x: number; y: number; price: number } | null,
        refPriceY: null as number | null,
        plottedPoints: [] as Array<{
          x: number;
          y: number;
          time: number;
          price: number;
        }>,
      };
    }

    const n = seriesPoints.length;
    const pts = seriesPoints.map((pt, i) => ({
      x: n > 1 ? (i / (n - 1)) * nowX : nowX,
      y: yOf(pt.price),
      time: pt.time,
      price: pt.price,
    }));

    const d = pts
      .map(
        (p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`
      )
      .join(" ");
    const last = pts[pts.length - 1];
    const bottomY = (height - padBottom).toFixed(1);
    const area = `${d} L${last.x.toFixed(1)},${bottomY} L0,${bottomY} Z`;
    const refY = yOf(pts[0].price);

    return {
      linePath: d,
      areaPath: area,
      lastPt: last,
      refPriceY: refY,
      plottedPoints: pts,
    };
  }, [seriesPoints, nowX, yOf, height]);

  // Historical buy-point markers inside the left past window
  const entryMarkers = useMemo(() => {
    if (plottedPoints.length < 2 || activePositions.length === 0) return [];
    const firstTime = plottedPoints[0].time;
    const lastTime = plottedPoints[plottedPoints.length - 1].time;
    if (lastTime <= firstTime) return [];

    const out: Array<{
      id: string;
      x: number;
      y: number;
      color: string;
      label: string;
      selected: boolean;
    }> = [];

    for (const p of activePositions) {
      const createdSec =
        p.createdAt > 1e12 ? Math.floor(p.createdAt / 1000) : p.createdAt;
      if (createdSec < firstTime || createdSec > lastTime + 900) continue;

      let best = plottedPoints[0];
      let bestDist = Math.abs(plottedPoints[0].time - createdSec);
      for (let i = 1; i < plottedPoints.length; i++) {
        const dist = Math.abs(plottedPoints[i].time - createdSec);
        if (dist < bestDist) {
          bestDist = dist;
          best = plottedPoints[i];
        }
      }

      const posId = p.tokenId || p.seriesId;
      out.push({
        id: posId,
        x: best.x,
        y: best.y,
        color: p.direction === "BEAR" ? DOWN_CORAL : UP_GREEN,
        label: locale === "zh" ? "买入" : "Buy",
        selected: Boolean(
          selectedPositionId &&
            (p.tokenId === selectedPositionId ||
              p.seriesId === selectedPositionId)
        ),
      });
    }
    return out;
  }, [plottedPoints, activePositions, selectedPositionId, locale]);

  // Active payoff zone geometry (uses selectedPosition if inspecting one, else active ticket)
  const activeZone = useMemo(() => {
    const src = selectedPosition
      ? {
          direction: selectedPosition.direction,
          underlying: selectedPosition.underlying,
          lowerStrike: selectedPosition.lowerStrike,
          upperStrike: selectedPosition.upperStrike,
          startPrice: selectedPosition.startPrice,
          capPrice: selectedPosition.capPrice,
          breakevenPrice: selectedPosition.breakevenPrice,
          maxPayoutUsdt: selectedPosition.remainingBalanceUsdt,
        }
      : ticket
        ? {
            direction: ticket.direction,
            underlying: ticket.underlying,
            lowerStrike: ticket.lowerStrike,
            upperStrike: ticket.upperStrike,
            startPrice: ticket.startPrice,
            capPrice: ticket.fullPayoutPrice,
            breakevenPrice: ticket.breakevenPrice,
            maxPayoutUsdt: ticket.maxPayoutUsdt,
          }
        : null;

    if (!src || src.upperStrike <= src.lowerStrike) return null;

    const bull = src.direction === "BULL";
    const col = bull ? UP_GREEN : DOWN_CORAL;
    const yHigh = yOf(src.upperStrike);
    const yLow = yOf(src.lowerStrike);
    const yCap = yOf(src.capPrice);
    const yBe = yOf(src.breakevenPrice);
    const yStart = yOf(src.startPrice);
    const capArrow = bull ? "≥" : "≤";

    const capLine1 =
      locale === "zh"
        ? `赢 $${src.maxPayoutUsdt.toFixed(2)}`
        : `Win $${src.maxPayoutUsdt.toFixed(2)}`;
    const capLine2 = `${capArrow} ${formatStrikePrice(src.capPrice, src.underlying)}`;
    const beText = compactLabels
      ? locale === "zh"
        ? "回本"
        : "BE"
      : t.mathBreakevenShort(
          formatStrikePrice(src.breakevenPrice, src.underlying)
        );
    const startText = compactLabels
      ? "$0"
      : `$0 · ${formatStrikePrice(src.startPrice, src.underlying)}`;

    const blocks: EditorialBlock[] = [
      {
        id: "cap",
        targetY: yCap,
        halfH: 13,
        line1: capLine1,
        line2: capLine2,
        color: col,
        bold: true,
        fontSize: compactLabels ? 10 : 11,
      },
      {
        id: "be",
        targetY: yBe,
        halfH: 7.5,
        line1: beText,
        color: MID_TEXT,
        bold: false,
        fontSize: compactLabels ? 9.5 : 10.5,
      },
      {
        id: "start",
        targetY: yStart,
        halfH: 7.5,
        line1: startText,
        color: SUB_TEXT,
        bold: false,
        fontSize: compactLabels ? 9.5 : 10,
      },
    ];

    const placedLabels = layoutEditorialLabels(
      blocks,
      padTop,
      height - padBottom
    );

    return {
      bull,
      col,
      yHigh,
      yLow,
      washTop: Math.min(yHigh, yLow),
      washHeight: Math.max(1, Math.abs(yLow - yHigh)),
      yCap,
      yBe,
      yStart,
      placedLabels,
    };
  }, [selectedPosition, ticket, yOf, locale, compactLabels, t, height]);

  // Warm-gold 30m TWAP observation window geometry
  const twapGeom = useMemo(() => {
    if (!inTwapWindow) return null;
    const bandW = Math.min(expiryX - 24, Math.max(58, futureW * 0.85 + 24));
    const x0 = Math.max(16, expiryX - bandW);
    const avgY =
      twapAvgPrice && Number.isFinite(twapAvgPrice) && twapAvgPrice > 0
        ? yOf(twapAvgPrice)
        : null;
    const avgLabel =
      twapAvgPrice && Number.isFinite(twapAvgPrice) && twapAvgPrice > 0
        ? locale === "zh"
          ? `均价 ${formatStrikePrice(twapAvgPrice, underlying)}`
          : `Avg ${formatStrikePrice(twapAvgPrice, underlying)}`
        : null;
    return {
      x0,
      bandW: expiryX - x0,
      avgY,
      avgLabel,
      windowTag: locale === "zh" ? "30m 均价窗" : "30m TWAP",
    };
  }, [inTwapWindow, expiryX, futureW, twapAvgPrice, yOf, locale, underlying]);

  // Scrub readout evaluation (multi-position combined total when holding, or single draft ticket)
  const scrubSummary = useMemo(() => {
    if (activeScrubPrice === null || !Number.isFinite(activeScrubPrice)) {
      return null;
    }
    if (activePositions.length > 0) {
      let totalPayout = 0;
      let totalStake = 0;
      for (const p of activePositions) {
        const frac = computeSpreadPayoffFraction(
          p.isUp,
          p.lowerStrike,
          p.upperStrike,
          activeScrubPrice
        );
        totalPayout += p.remainingBalanceUsdt * frac;
        totalStake += p.totalStakeUsdt;
      }
      return {
        isCombined: true,
        count: activePositions.length,
        price: activeScrubPrice,
        payoutUsdt: totalPayout,
        stakeUsdt: totalStake,
      };
    }
    if (ticket) {
      const frac = computeSpreadPayoffFraction(
        ticket.direction === "BULL",
        ticket.lowerStrike,
        ticket.upperStrike,
        activeScrubPrice
      );
      return {
        isCombined: false,
        count: 1,
        price: activeScrubPrice,
        payoutUsdt: ticket.maxPayoutUsdt * frac,
        stakeUsdt: ticket.stakeUsdt,
      };
    }
    return null;
  }, [activeScrubPrice, activePositions, ticket]);

  // Scrubber knob resting / active Y coordinate
  const knobY = useMemo(() => {
    const targetP =
      activeScrubPrice ??
      (selectedPosition
        ? selectedPosition.breakevenPrice
        : ticket
          ? ticket.breakevenPrice
          : liveSpot ?? null);
    if (targetP === null || !Number.isFinite(targetP)) {
      return padTop + plotH / 2;
    }
    return clamp(yOf(targetP), padTop + 8, height - padBottom - 8);
  }, [activeScrubPrice, selectedPosition, ticket, liveSpot, yOf, plotH, height]);

  const updateScrubFromClientY = useCallback(
    (clientY: number) => {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const localY = clamp(clientY - rect.top, padTop, height - padBottom);
      const nextPrice = priceOfY(localY);
      if (!Number.isFinite(nextPrice) || nextPrice <= 0) return;
      const decimals = underlying === "BTC" && nextPrice >= 1000 ? 0 : 2;
      setScrubPrice(Number(nextPrice.toFixed(decimals)));
    },
    [height, priceOfY, setScrubPrice, underlying]
  );

  // Dedicated touch-friendly pointer handlers on the expiry scrubber strip
  const handleScrubPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setHoverIndex(null);
    setIsDraggingScrub(true);
    updateScrubFromClientY(e.clientY);
  };

  const handleScrubPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    if (!isDraggingScrub && e.buttons === 0) return;
    e.stopPropagation();
    updateScrubFromClientY(e.clientY);
  };

  const handleScrubPointerUp = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    setIsDraggingScrub(false);
  };

  // SVG-level desktop mouse interactions:
  // - Hover left past zone [0, nowX] -> crosshair + timestamp/price readout
  // - Drag right future zone [nowX, width] on mouse -> smooth settlement price scrub
  const handleSvgPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.pointerType !== "mouse" || !canScrub) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const localX = e.clientX - rect.left;
    if (localX >= nowX) {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      setHoverIndex(null);
      setIsDraggingScrub(true);
      updateScrubFromClientY(e.clientY);
    }
  };

  const handleSvgPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (isDraggingScrub) {
      updateScrubFromClientY(e.clientY);
      return;
    }
    if (e.pointerType !== "mouse" || plottedPoints.length === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const localX = e.clientX - rect.left;
    if (localX >= 0 && localX <= nowX + 4) {
      const ratio = clamp(localX / Math.max(1, nowX), 0, 1);
      const idx = Math.round(ratio * (plottedPoints.length - 1));
      setHoverIndex(idx);
    } else {
      setHoverIndex(null);
    }
  };

  const handleSvgPointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (isDraggingScrub) {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      setIsDraggingScrub(false);
    }
  };

  const handleScrubKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      setScrubPrice(null);
      return;
    }
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const basePrice =
      activeScrubPrice ??
      ticket?.breakevenPrice ??
      liveSpot ??
      (seriesPoints.length > 0
        ? seriesPoints[seriesPoints.length - 1].price
        : null);
    if (!basePrice) return;
    const span =
      ticket && ticket.upperStrike > ticket.lowerStrike
        ? ticket.upperStrike - ticket.lowerStrike
        : basePrice * 0.02;
    const step = Math.max(0.01, span * 0.05);
    const next =
      e.key === "ArrowUp" ? basePrice + step : Math.max(0.01, basePrice - step);
    const decimals = underlying === "BTC" && next >= 1000 ? 0 : 2;
    setScrubPrice(Number(next.toFixed(decimals)));
  };

  const hoveredPoint =
    hoverIndex !== null && !isDraggingScrub && activeScrubPrice === null
      ? plottedPoints[hoverIndex] ?? null
      : null;

  const payoutColor =
    scrubSummary && scrubSummary.payoutUsdt >= scrubSummary.stakeUsdt
      ? UP_GREEN
      : scrubSummary && scrubSummary.payoutUsdt > 0
        ? GOLD
        : SUB_TEXT;

  const areaGradId = `payoff-area-${uid}`;
  const bullWashId = `payoff-bull-wash-${uid}`;
  const bearWashId = `payoff-bear-wash-${uid}`;

  const scrubPillText =
    activeScrubPrice !== null
      ? locale === "zh"
        ? `结算在 ${formatStrikePrice(activeScrubPrice, underlying)}`
        : `Settle ${formatStrikePrice(activeScrubPrice, underlying)}`
      : "";
  const scrubPillW = Math.max(
    84,
    scrubPillText.length * (locale === "zh" ? 8.5 : 6.8) + 18
  );
  const scrubPillX = clamp(
    nowX - scrubPillW - 10,
    8,
    Math.max(8, expiryX - scrubPillW - 16)
  );
  const scrubPillY = clamp(knobY - 25, 4, height - padBottom - 22);

  return (
    <div className="relative w-full bg-black">
      {/* Full-Bleed Pure OLED Black SVG Forecast Canvas */}
      <div
        ref={containerRef}
        className="relative w-full overflow-hidden bg-black select-none"
        style={{ height: `${height}px` }}
      >
        {/* Floating dark #121417 scrub readout pill (zero layout shift during drag) */}
        {scrubSummary && (
          <div
            role="status"
            aria-live="polite"
            className="absolute top-1.5 left-2 z-20 flex max-w-[calc(100%-16px)] items-center gap-2 rounded-full border border-[#24282f] bg-[#121417]/95 px-3 py-1.5 text-[11.5px] tabular-nums shadow-[0_6px_20px_rgba(0,0,0,0.75)] backdrop-blur-xs"
          >
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[#b8bec6]">
              <span>
                {locale === "zh" ? "结算在" : "Settles"}{" "}
                <strong className="font-bold text-white">
                  {formatStrikePrice(scrubSummary.price, underlying)}
                </strong>
              </span>
              <span className="text-[#7e8690]" aria-hidden="true">
                →
              </span>
              <span>
                {scrubSummary.isCombined
                  ? locale === "zh"
                    ? "合计拿回"
                    : "Total"
                  : locale === "zh"
                    ? "拿回"
                    : "Payout"}{" "}
                <strong
                  className="text-xs font-bold"
                  style={{ color: payoutColor }}
                >
                  ${scrubSummary.payoutUsdt.toFixed(2)}
                </strong>
              </span>
              {scrubSummary.payoutUsdt > 0 &&
                scrubSummary.payoutUsdt < scrubSummary.stakeUsdt && (
                  <span className="rounded-full bg-[#E6BA5C]/15 px-1.5 py-0.5 text-[9.5px] font-semibold text-[#E6BA5C]">
                    {t.outcomePartialBadge}
                  </span>
                )}
            </div>
            <button
              type="button"
              onClick={() => setScrubPrice(null)}
              aria-label={locale === "zh" ? "清除试算" : "Clear simulation"}
              className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#24282f] text-[#b8bec6] hover:text-white cursor-pointer"
            >
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          </div>
        )}
        <svg
          role="img"
          aria-label={
            locale === "zh"
              ? "价格走势与到期赔付预测图"
              : "Price trend and expiry payoff forecast chart"
          }
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          className="block h-full w-full"
          style={{
            cursor: isDraggingScrub ? "ns-resize" : undefined,
          }}
          onPointerDown={handleSvgPointerDown}
          onPointerMove={handleSvgPointerMove}
          onPointerUp={handleSvgPointerUp}
          onPointerLeave={() => {
            if (!isDraggingScrub) setHoverIndex(null);
          }}
          onPointerCancel={handleSvgPointerUp}
        >
          <defs>
            <linearGradient id={areaGradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={lineColor} stopOpacity="0.14" />
              <stop offset="100%" stopColor={lineColor} stopOpacity="0" />
            </linearGradient>
            <linearGradient id={bullWashId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={UP_GREEN} stopOpacity="0.20" />
              <stop offset="100%" stopColor={UP_GREEN} stopOpacity="0" />
            </linearGradient>
            <linearGradient id={bearWashId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={DOWN_CORAL} stopOpacity="0" />
              <stop offset="100%" stopColor={DOWN_CORAL} stopOpacity="0.20" />
            </linearGradient>
          </defs>

          {/* Subtle period-open reference baseline */}
          {refPriceY !== null && (
            <line
              x1={0}
              y1={refPriceY}
              x2={expiryX}
              y2={refPriceY}
              stroke="#1d2025"
              strokeWidth={1}
              strokeDasharray="2 5"
            />
          )}

          {/* Warm-gold 30m TWAP Lock Window Band */}
          {twapGeom && (
            <g>
              <rect
                x={twapGeom.x0}
                y={padTop}
                width={twapGeom.bandW}
                height={plotH}
                fill={GOLD}
                fillOpacity={0.09}
              />
              <line
                x1={twapGeom.x0}
                y1={padTop}
                x2={twapGeom.x0}
                y2={height - padBottom}
                stroke={GOLD}
                strokeOpacity={0.35}
                strokeWidth={1}
                strokeDasharray="2 4"
              />
              <text
                x={twapGeom.x0 + twapGeom.bandW / 2}
                y={height - 4}
                textAnchor="middle"
                fontSize={9.5}
                fontWeight={700}
                fill={GOLD}
              >
                {twapGeom.windowTag}
              </text>
            </g>
          )}

          {/* RIGHT FUTURE PAYOFF ZONE [nowX -> expiryX] */}
          {activeZone && (
            <g>
              <rect
                x={nowX}
                y={activeZone.washTop}
                width={futureW}
                height={activeZone.washHeight}
                fill={`url(#${activeZone.bull ? bullWashId : bearWashId})`}
              />
              {/* Solid semantic Cap line */}
              <line
                x1={nowX}
                y1={activeZone.yCap}
                x2={expiryX}
                y2={activeZone.yCap}
                stroke={activeZone.col}
                strokeWidth={1.5}
              />
              {/* Dashed Breakeven line */}
              <line
                x1={nowX}
                y1={activeZone.yBe}
                x2={expiryX}
                y2={activeZone.yBe}
                stroke={SUB_TEXT}
                strokeOpacity={0.55}
                strokeWidth={1}
                strokeDasharray="2 4"
              />
              {/* Dashed Start / Floor line */}
              <line
                x1={nowX}
                y1={activeZone.yStart}
                x2={expiryX}
                y2={activeZone.yStart}
                stroke={SUB_TEXT}
                strokeOpacity={0.35}
                strokeWidth={1}
                strokeDasharray="2 4"
              />
            </g>
          )}

          {/* LEFT PAST ZONE [0 -> nowX]: Area Fade + Smooth Price Line */}
          {areaPath && <path d={areaPath} fill={`url(#${areaGradId})`} />}
          {linePath && (
            <path
              d={linePath}
              fill="none"
              stroke={lineColor}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          )}

          {/* Warm-gold TWAP running average line & pill */}
          {twapGeom && twapGeom.avgY !== null && (
            <g>
              <line
                x1={twapGeom.x0}
                y1={twapGeom.avgY}
                x2={expiryX}
                y2={twapGeom.avgY}
                stroke={GOLD}
                strokeWidth={2}
              />
              {twapGeom.avgLabel &&
                (() => {
                  const pw = Math.max(76, twapGeom.avgLabel.length * 7.2 + 16);
                  const px = clamp(twapGeom.x0 - pw - 8, 8, Math.max(8, nowX - pw));
                  const py = clamp(twapGeom.avgY - 10, padTop, height - padBottom - 20);
                  return (
                    <g>
                      <rect
                        x={px}
                        y={py}
                        width={pw}
                        height={20}
                        rx={10}
                        fill="#1e190e"
                        stroke={GOLD}
                        strokeOpacity={0.3}
                        strokeWidth={1}
                      />
                      <text
                        x={px + pw / 2}
                        y={py + 13.5}
                        textAnchor="middle"
                        fontSize={10}
                        fontWeight={700}
                        fill={GOLD}
                        style={{ fontVariantNumeric: "tabular-nums" }}
                      >
                        {twapGeom.avgLabel}
                      </text>
                    </g>
                  );
                })()}
            </g>
          )}

          {/* Historical Buy-Point Markers inside Left Past Zone */}
          {entryMarkers.map((m) => {
            const pillW = locale === "zh" ? 34 : 32;
            const pillX = clamp(m.x - pillW / 2, 6, Math.max(6, nowX - pillW - 6));
            const pillY = clamp(m.y - 25, padTop, height - padBottom - 18);
            return (
              <g key={m.id}>
                {m.selected && (
                  <circle
                    cx={m.x}
                    cy={m.y}
                    r={7.5}
                    fill={m.color}
                    fillOpacity={0.22}
                  />
                )}
                <circle
                  cx={m.x}
                  cy={m.y}
                  r={3.8}
                  fill="#000000"
                  stroke={m.color}
                  strokeWidth={2}
                />
                {entryMarkers.length <= 2 && (
                  <g>
                    <rect
                      x={pillX}
                      y={pillY}
                      width={pillW}
                      height={16}
                      rx={8}
                      fill="#181c20"
                    />
                    <text
                      x={pillX + pillW / 2}
                      y={pillY + 11}
                      textAnchor="middle"
                      fontSize={9}
                      fontWeight={700}
                      fill={m.color}
                    >
                      {m.label}
                    </text>
                  </g>
                )}
              </g>
            );
          })}

          {/* Ambient Pulsing Live Spot Dot at (nowX, spotY) */}
          {lastPt && (
            <g>
              <circle
                cx={lastPt.x}
                cy={lastPt.y}
                r={8.5}
                fill={lineColor}
                fillOpacity={0.18}
                className="animate-pulse motion-reduce:animate-none"
              />
              <circle cx={lastPt.x} cy={lastPt.y} r={3.6} fill={lineColor} />
            </g>
          )}

          {/* Desktop Hover Hairline + Dot on Left Past Zone */}
          {hoveredPoint && (
            <g pointerEvents="none">
              <line
                x1={hoveredPoint.x}
                y1={padTop}
                x2={hoveredPoint.x}
                y2={height - padBottom}
                stroke="rgba(255,255,255,0.18)"
                strokeWidth={1}
              />
              <circle
                cx={hoveredPoint.x}
                cy={hoveredPoint.y}
                r={4.2}
                fill="#000000"
                stroke="#FFFFFF"
                strokeWidth={2}
              />
              <text
                x={8}
                y={13}
                fontSize={10.5}
                fontWeight={600}
                fill={MID_TEXT}
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {formatHoverTime(hoveredPoint.time, locale)}
                {" · "}
                <tspan fill="#FFFFFF" fontWeight={700}>
                  {formatStrikePrice(hoveredPoint.price, underlying)}
                </tspan>
              </text>
            </g>
          )}

          {/* Subtle Dashed Vertical Expiry Settlement Line & Top Expiry Label */}
          <line
            x1={expiryX}
            y1={padTop}
            x2={expiryX}
            y2={height - padBottom}
            stroke="rgba(255,255,255,0.16)"
            strokeWidth={1}
            strokeDasharray="3 4"
          />
          {expiryLabel && (
            <text
              x={clamp(expiryX, 44, width - 48)}
              y={12}
              textAnchor="middle"
              fontSize={10}
              fontWeight={600}
              fill="#68707a"
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {expiryLabel}
            </text>
          )}

          {/* Multi-Position Vertical Profit-Zone Bars beside expiryX */}
          {visibleBars.map((p, idx) => {
            const posId = p.tokenId || p.seriesId;
            const yHi = yOf(p.upperStrike);
            const yLo = yOf(p.lowerStrike);
            const top = Math.min(yHi, yLo);
            const barH = Math.max(8, Math.abs(yLo - yHi));
            const bx = barStartX + idx * 7;
            const col = p.direction === "BEAR" ? DOWN_CORAL : UP_GREEN;
            const isSel = Boolean(
              selectedPositionId &&
                (p.tokenId === selectedPositionId ||
                  p.seriesId === selectedPositionId)
            );
            const hasSel = Boolean(selectedPositionId);
            const opacity = isSel ? 1 : hasSel ? 0.34 : 0.82;

            return (
              <g
                key={posId}
                role={onSelectPosition ? "button" : undefined}
                tabIndex={onSelectPosition ? 0 : undefined}
                aria-label={`${p.direction === "BULL" ? t.bull : t.bear} ${formatStrikePrice(p.capPrice, p.underlying)}`}
                onClick={(ev) => {
                  if (!onSelectPosition) return;
                  ev.stopPropagation();
                  onSelectPosition(isSel ? null : posId);
                }}
                onKeyDown={(ev) => {
                  if (!onSelectPosition) return;
                  if (ev.key === "Enter" || ev.key === " ") {
                    ev.preventDefault();
                    onSelectPosition(isSel ? null : posId);
                  }
                }}
                className={onSelectPosition ? "cursor-pointer" : undefined}
              >
                {/* Invisible wider click target */}
                <rect
                  x={bx - 3}
                  y={top - 4}
                  width={10}
                  height={barH + 8}
                  fill="transparent"
                />
                <rect
                  x={bx}
                  y={top}
                  width={4}
                  height={barH}
                  rx={2}
                  fill={col}
                  fillOpacity={opacity}
                  stroke={isSel ? "rgba(255,255,255,0.55)" : "none"}
                  strokeWidth={isSel ? 0.8 : 0}
                />
              </g>
            );
          })}

          {/* RIGHT EDITORIAL LABEL COLUMN (No right axis ticks, anti-collision placed) */}
          {activeZone &&
            activeZone.placedLabels.map((lbl) => (
              <g key={lbl.id} pointerEvents="none">
                {lbl.line2 ? (
                  <>
                    <text
                      x={labelX}
                      y={lbl.y - 2}
                      fontSize={lbl.fontSize}
                      fontWeight={lbl.bold ? 700 : 600}
                      fill={lbl.color}
                      style={{ fontVariantNumeric: "tabular-nums" }}
                    >
                      {lbl.line1}
                    </text>
                    <text
                      x={labelX}
                      y={lbl.y + 10}
                      fontSize={9.5}
                      fontWeight={500}
                      fill={SUB_TEXT}
                      style={{ fontVariantNumeric: "tabular-nums" }}
                    >
                      {lbl.line2}
                    </text>
                  </>
                ) : (
                  <text
                    x={labelX}
                    y={lbl.y + 3.5}
                    fontSize={lbl.fontSize}
                    fontWeight={lbl.bold ? 700 : 600}
                    fill={lbl.color}
                    style={{ fontVariantNumeric: "tabular-nums" }}
                  >
                    {lbl.line1}
                  </text>
                )}
              </g>
            ))}

          {/* Active Scrub Horizontal Line + White Price Pill */}
          {activeScrubPrice !== null && (
            <g pointerEvents="none">
              <line
                x1={0}
                y1={knobY}
                x2={nowX}
                y2={knobY}
                stroke="rgba(255,255,255,0.16)"
                strokeWidth={1}
                strokeDasharray="2 4"
              />
              <line
                x1={nowX}
                y1={knobY}
                x2={expiryX}
                y2={knobY}
                stroke="rgba(255,255,255,0.52)"
                strokeWidth={1.2}
                strokeDasharray="2 3"
              />
              <rect
                x={scrubPillX}
                y={scrubPillY}
                width={scrubPillW}
                height={20}
                rx={10}
                fill="#FFFFFF"
              />
              <text
                x={scrubPillX + scrubPillW / 2}
                y={scrubPillY + 13.5}
                textAnchor="middle"
                fontSize={10.5}
                fontWeight={700}
                fill="#000000"
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {scrubPillText}
              </text>
            </g>
          )}

          {/* Subtle Bottom-Left History Window Tag (e.g. 24H / 7D) */}
          {windowLabel && (
            <text
              x={8}
              y={height - 4}
              fontSize={10}
              fontWeight={500}
              fill="#525862"
              pointerEvents="none"
            >
              {windowLabel}
            </text>
          )}
        </svg>

        {/* Interactive Expiry-Line Scrubber Rail & White Circular ↕ Knob */}
        {canScrub && (
          <div
            role="slider"
            tabIndex={0}
            aria-label={t.chartScrubHint}
            aria-orientation="vertical"
            aria-valuetext={
              activeScrubPrice !== null
                ? formatStrikePrice(activeScrubPrice, underlying)
                : t.chartScrubHint
            }
            onPointerDown={handleScrubPointerDown}
            onPointerMove={handleScrubPointerMove}
            onPointerUp={handleScrubPointerUp}
            onPointerCancel={handleScrubPointerUp}
            onKeyDown={handleScrubKeyDown}
            style={{
              left: `${expiryX - 22}px`,
              top: `${padTop - 4}px`,
              height: `${plotH + 8}px`,
            }}
            className="absolute z-10 w-11 touch-none cursor-ns-resize focus-visible:outline-2 focus-visible:outline-white/70 focus-visible:rounded-full"
          >
            <div
              aria-hidden="true"
              style={{ top: `${knobY - (padTop - 4)}px` }}
              className="pointer-events-none absolute left-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center justify-center"
            >
              <span
                className={`flex h-6 w-6 items-center justify-center rounded-full transition-transform ${
                  activeScrubPrice !== null || isDraggingScrub
                    ? "scale-110 bg-white/18"
                    : "bg-white/10"
                }`}
              >
                <span className="flex h-[15px] w-[15px] items-center justify-center rounded-full bg-white shadow-[0_2px_8px_rgba(0,0,0,0.75)]">
                  <svg
                    width="7"
                    height="9"
                    viewBox="0 0 8 10"
                    fill="none"
                    className="block"
                  >
                    <path
                      d="M1.5 3.6L4 1.2L6.5 3.6M1.5 6.4L4 8.8L6.5 6.4"
                      stroke="#000000"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

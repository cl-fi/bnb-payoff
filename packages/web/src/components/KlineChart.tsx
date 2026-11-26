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

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function formatSignedUsd(v: number): string {
  const abs = Math.abs(v).toFixed(2);
  if (v > 0.004) return `+$${abs}`;
  if (v < -0.004) return `-$${abs}`;
  return "$0.00";
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

export function KlineChart({
  locale,
  candles,
  ticket,
  liveSpot,
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
    if (selectedPosition) {
      if (Number.isFinite(selectedPosition.lowerStrike)) {
        vals.push(selectedPosition.lowerStrike);
      }
      if (Number.isFinite(selectedPosition.upperStrike)) {
        vals.push(selectedPosition.upperStrike);
      }
      if (Number.isFinite(selectedPosition.breakevenPrice)) {
        vals.push(selectedPosition.breakevenPrice);
      }
    } else {
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

    const candleSpan =
      Number.isFinite(candleMin) && Number.isFinite(candleMax)
        ? candleMax - candleMin
        : span;
    const padRatio = candleSpan > 0 && candleSpan / span < 0.16 ? 0.11 : 0.15;
    const pad = span * padRatio;

    return {
      min: Math.max(0, rawMin - pad),
      max: rawMax + pad,
    };
  }, [
    seriesPoints,
    liveSpot,
    selectedPosition,
    ticket,
    activePositions,
    inTwapWindow,
    twapAvgPrice,
  ]);

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

  // Scheme A1 Full-Bleed Spatial Split Geometry (single clean right-edge ramp bar, zero multi-position bar clutter)
  const isNarrow = width < 440;
  const canScrub = Boolean(ticket || activePositions.length > 0);

  const rightEdgeMargin = isNarrow ? 14 : 18;
  const expiryX = Math.round(
    clamp(width - rightEdgeMargin, width * 0.78, width - 12)
  );
  const nowX = Math.round(
    clamp(
      width * (isNarrow ? 0.62 : 0.68),
      84,
      expiryX - (isNarrow ? 64 : 92)
    )
  );
  const futureW = Math.max(32, expiryX - nowX);

  const padTop = 24;
  const padBottom = 22;
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

  // Active payoff zone geometry (Scheme A1: borderless editorial cap label + subtle inner guides + edge ramp bar)
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

    const capPrimary =
      locale === "zh"
        ? `赢 $${src.maxPayoutUsdt.toFixed(2)}`
        : `Win $${src.maxPayoutUsdt.toFixed(2)}`;
    const capPriceStr = `${capArrow} ${formatStrikePrice(src.capPrice, src.underlying)}`;

    // Position Cap editorial typography cleanly above cap (Bull) or below cap (Bear) without clipping
    const capTextY = bull
      ? Math.max(13, yCap - 7)
      : yCap + 14 <= height - 6
        ? yCap + 14
        : Math.max(13, yCap - 7);

    // Subtle inner micro-captions (only shown when vertical spacing & future width prevent overlap)
    const showBeLabel =
      futureW >= 78 &&
      Math.abs(yBe - yCap) >= 15 &&
      Math.abs(yStart - yBe) >= 13;
    const beLabelText =
      futureW >= 106
        ? locale === "zh"
          ? `回本 ${formatStrikePrice(src.breakevenPrice, src.underlying)}`
          : `BE ${formatStrikePrice(src.breakevenPrice, src.underlying)}`
        : locale === "zh"
          ? "回本"
          : "BE";
    const beLabelY = bull ? yBe - 4 : yBe + 11;

    const isCustomDraft = !selectedPosition && ticket?.tierKind === "CUSTOM";
    const showStartLabel =
      futureW >= 78 && Math.abs(yStart - yCap) >= (isCustomDraft ? 14 : 24);
    const startLabelText =
      futureW >= 106
        ? `$0 · ${formatStrikePrice(src.startPrice, src.underlying)}`
        : "$0";
    const startLabelY = bull
      ? Math.min(height - 6, yStart + 11)
      : Math.max(13, yStart - 5);

    return {
      bull,
      col,
      isCustomDraft,
      yHigh,
      yLow,
      washTop: Math.min(yHigh, yLow),
      washHeight: Math.max(2, Math.abs(yLow - yHigh)),
      yCap,
      yBe,
      yStart,
      capPrimary,
      capPriceStr,
      capTextY,
      showBeLabel,
      beLabelText,
      beLabelY,
      showStartLabel,
      startLabelText,
      startLabelY,
    };
  }, [selectedPosition, ticket, yOf, locale, height, futureW]);

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
        pnlUsdt: totalPayout - totalStake,
      };
    }
    if (ticket) {
      const frac = computeSpreadPayoffFraction(
        ticket.direction === "BULL",
        ticket.lowerStrike,
        ticket.upperStrike,
        activeScrubPrice
      );
      const payoutUsdt = ticket.maxPayoutUsdt * frac;
      return {
        isCombined: false,
        count: 1,
        price: activeScrubPrice,
        payoutUsdt,
        stakeUsdt: ticket.stakeUsdt,
        pnlUsdt: payoutUsdt - ticket.stakeUsdt,
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

  const pnlColor =
    scrubSummary && scrubSummary.pnlUsdt > 0.004
      ? UP_GREEN
      : scrubSummary && scrubSummary.pnlUsdt < -0.004
        ? DOWN_CORAL
        : SUB_TEXT;

  const selectedPosMult =
    selectedPosition && selectedPosition.totalStakeUsdt > 0
      ? selectedPosition.initialMaxPayoutUsdt / selectedPosition.totalStakeUsdt
      : 0;

  const scrubTagY = clamp(knobY, 18, height - padBottom - 16);
  const scrubTagRight = Math.max(16, width - expiryX + 14);

  const areaGradId = `payoff-area-${uid}`;
  const bullWashId = `payoff-bull-wash-${uid}`;
  const bearWashId = `payoff-bear-wash-${uid}`;
  const bullBarGradId = `payoff-bull-bar-${uid}`;
  const bearBarGradId = `payoff-bear-bar-${uid}`;

  return (
    <div className="relative w-full bg-black">
      {/* Full-Bleed Pure OLED Black SVG Forecast Canvas */}
      <div
        ref={containerRef}
        className="relative w-full overflow-hidden bg-black select-none"
        style={{ height: `${height}px` }}
      >
        {/* Minimal Focused-Position Indicator Chip (only rendered when inspecting a clicked position row) */}
        {selectedPosition && (
          <div className="absolute left-2 top-1.5 z-20 flex max-w-[calc(100%-36px)] items-center gap-1.5 rounded-full border border-white/10 bg-[#121417]/92 pl-2.5 pr-1 py-0.5 text-[11px] leading-none text-[#d6dce4] tabular-nums shadow-[0_4px_16px_rgba(0,0,0,0.75)] backdrop-blur-sm">
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{
                backgroundColor:
                  selectedPosition.direction === "BULL" ? UP_GREEN : DOWN_CORAL,
              }}
            />
            <span
              className="font-bold whitespace-nowrap"
              style={{
                color:
                  selectedPosition.direction === "BULL" ? UP_GREEN : DOWN_CORAL,
              }}
            >
              {selectedPosition.direction === "BULL" ? t.bull : t.bear}
            </span>
            {selectedPosMult > 0 && (
              <span className="font-semibold text-white whitespace-nowrap">
                {selectedPosMult.toFixed(2)}x
              </span>
            )}
            <span className="truncate text-[#9aa2ad]">
              {formatStrikePrice(selectedPosition.startPrice, underlying)} →{" "}
              {formatStrikePrice(selectedPosition.capPrice, underlying)}
            </span>
            {onSelectPosition && (
              <button
                type="button"
                onClick={() => onSelectPosition(null)}
                aria-label={
                  locale === "zh" ? "返回下单预览" : "Return to order preview"
                }
                className="inline-flex min-h-6 min-w-6 shrink-0 items-center justify-center rounded-full text-[#7e8690] hover:bg-white/10 hover:text-white active:bg-white/15 transition cursor-pointer focus-visible:outline-2 focus-visible:outline-white/70"
              >
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            )}
          </div>
        )}

        {/* Scheme A1 Track-Side Floating Scrub Readout (tracks handle smoothly, shows payout + net PnL) */}
        {scrubSummary && (
          <div
            role="status"
            aria-live="polite"
            style={{
              right: `${scrubTagRight}px`,
              top: `${scrubTagY}px`,
            }}
            className="absolute z-20 flex max-w-[calc(100%-36px)] -translate-y-1/2 items-center gap-1.5 rounded-lg border border-white/12 bg-[#121417]/95 pl-2.5 pr-1 py-0.5 text-[11px] leading-none tabular-nums shadow-[0_6px_24px_rgba(0,0,0,0.85)] backdrop-blur-sm"
          >
            <strong className="font-semibold text-white whitespace-nowrap">
              {formatStrikePrice(scrubSummary.price, underlying)}
            </strong>
            <span className="text-[#525862]" aria-hidden="true">
              →
            </span>
            {scrubSummary.isCombined && (
              <span className="text-[#8d96a0] whitespace-nowrap">
                {locale === "zh" ? "合计" : "Total"}
              </span>
            )}
            <strong
              className="font-bold whitespace-nowrap"
              style={{ color: payoutColor }}
            >
              ${scrubSummary.payoutUsdt.toFixed(2)}
            </strong>
            <span
              className="font-semibold whitespace-nowrap"
              style={{ color: pnlColor }}
            >
              ({formatSignedUsd(scrubSummary.pnlUsdt)})
            </span>
            <button
              type="button"
              onClick={() => setScrubPrice(null)}
              aria-label={locale === "zh" ? "清除试算" : "Clear simulation"}
              className="inline-flex min-h-6 min-w-6 shrink-0 items-center justify-center rounded-md text-[#7e8690] hover:bg-white/10 hover:text-white active:bg-white/15 transition cursor-pointer focus-visible:outline-2 focus-visible:outline-white/70"
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
              <stop offset="0%" stopColor={lineColor} stopOpacity="0.16" />
              <stop offset="100%" stopColor={lineColor} stopOpacity="0" />
            </linearGradient>
            <linearGradient id={bullWashId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={UP_GREEN} stopOpacity="0.21" />
              <stop offset="65%" stopColor={UP_GREEN} stopOpacity="0.05" />
              <stop offset="100%" stopColor={UP_GREEN} stopOpacity="0" />
            </linearGradient>
            <linearGradient id={bearWashId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={DOWN_CORAL} stopOpacity="0" />
              <stop offset="35%" stopColor={DOWN_CORAL} stopOpacity="0.05" />
              <stop offset="100%" stopColor={DOWN_CORAL} stopOpacity="0.21" />
            </linearGradient>
            <linearGradient id={bullBarGradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={UP_GREEN} stopOpacity="1" />
              <stop offset="55%" stopColor={GOLD} stopOpacity="0.7" />
              <stop offset="100%" stopColor="#474e57" stopOpacity="0.38" />
            </linearGradient>
            <linearGradient id={bearBarGradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#474e57" stopOpacity="0.38" />
              <stop offset="45%" stopColor={GOLD} stopOpacity="0.7" />
              <stop offset="100%" stopColor={DOWN_CORAL} stopOpacity="1" />
            </linearGradient>
          </defs>

          {/* Subtle period-open reference baseline */}
          {refPriceY !== null && (
            <line
              x1={0}
              y1={refPriceY}
              x2={expiryX}
              y2={refPriceY}
              stroke="#1a1d22"
              strokeWidth={1}
              strokeDasharray="2 5"
            />
          )}

          {/* Subtle Dashed Vertical Expiry Settlement Line */}
          <line
            x1={expiryX}
            y1={padTop - 4}
            x2={expiryX}
            y2={height - padBottom}
            stroke="rgba(255,255,255,0.12)"
            strokeWidth={1}
            strokeDasharray="3 4"
          />

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
                y={height - 5}
                textAnchor="middle"
                fontSize={9.5}
                fontWeight={700}
                fill={GOLD}
              >
                {twapGeom.windowTag}
              </text>
            </g>
          )}

          {/* RIGHT FUTURE PAYOFF ZONE [nowX -> expiryX] (Scheme A1: full-bleed + borderless editorial label + luminous ramp bar) */}
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
                strokeOpacity={0.9}
                strokeWidth={1.5}
              />
              {/* Subtle Breakeven guide */}
              <line
                x1={nowX}
                y1={activeZone.yBe}
                x2={expiryX}
                y2={activeZone.yBe}
                stroke="rgba(255,255,255,0.20)"
                strokeWidth={1}
                strokeDasharray="2 4"
              />
              {/* Start / Floor guide (emphasized when adjusting Start in Custom mode) */}
              <line
                x1={nowX}
                y1={activeZone.yStart}
                x2={expiryX}
                y2={activeZone.yStart}
                stroke={
                  activeZone.isCustomDraft
                    ? "rgba(255,255,255,0.34)"
                    : "rgba(255,255,255,0.11)"
                }
                strokeWidth={activeZone.isCustomDraft ? 1.25 : 1}
                strokeDasharray="2 4"
              />

              {/* Quiet micro inner labels (never clip, auto-hide when tight or overlapped by scrub readout) */}
              {activeZone.showBeLabel && (
                <text
                  x={nowX + 8}
                  y={activeZone.beLabelY}
                  fontSize={9.5}
                  fontWeight={500}
                  fill="#6f7782"
                  opacity={
                    scrubSummary && Math.abs(scrubTagY - activeZone.beLabelY) < 20
                      ? 0
                      : 1
                  }
                  pointerEvents="none"
                  className="transition-opacity duration-150 motion-reduce:transition-none"
                  style={{ fontVariantNumeric: "tabular-nums" }}
                >
                  {activeZone.beLabelText}
                </text>
              )}
              {activeZone.showStartLabel && (
                <text
                  x={nowX + 8}
                  y={activeZone.startLabelY}
                  fontSize={9.5}
                  fontWeight={activeZone.isCustomDraft ? 600 : 500}
                  fill={activeZone.isCustomDraft ? "#9aa2ad" : "#525963"}
                  opacity={
                    scrubSummary &&
                    Math.abs(scrubTagY - activeZone.startLabelY) < 20
                      ? 0
                      : 1
                  }
                  pointerEvents="none"
                  className="transition-opacity duration-150 motion-reduce:transition-none"
                  style={{ fontVariantNumeric: "tabular-nums" }}
                >
                  {activeZone.startLabelText}
                </text>
              )}

              {/* Borderless Editorial Cap Typography (right-aligned inside canvas, auto-fades if overlapped by scrub pill) */}
              <text
                x={expiryX - 8}
                y={activeZone.capTextY}
                textAnchor="end"
                fontSize={isNarrow ? 10.5 : 11}
                opacity={
                  scrubSummary && Math.abs(scrubTagY - activeZone.capTextY) < 24
                    ? 0
                    : 1
                }
                pointerEvents="none"
                className="transition-opacity duration-150 motion-reduce:transition-none"
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                <tspan fontWeight={700} fill={activeZone.col}>
                  {activeZone.capPrimary}
                </tspan>
                <tspan fill="#525862"> · </tspan>
                <tspan fontWeight={500} fill="#8d96a0">
                  {activeZone.capPriceStr}
                </tspan>
              </text>

              {/* Right-Edge Luminous Payoff Ramp Bar (visualizes smooth linear payout gradient at expiry) */}
              <rect
                x={expiryX - 2}
                y={activeZone.washTop}
                width={4}
                height={activeZone.washHeight}
                rx={2}
                fill={`url(#${activeZone.bull ? bullBarGradId : bearBarGradId})`}
              />
              <circle cx={expiryX} cy={activeZone.yCap} r={2.8} fill={activeZone.col} />
              <circle cx={expiryX} cy={activeZone.yStart} r={2} fill="#474e57" />
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

          {/* Warm-gold TWAP running average line & tag */}
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
                        rx={8}
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
                      rx={6}
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
                y={selectedPosition ? 38 : 13}
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

          {/* Active Scrub Horizontal Guide Line (readout floats cleanly beside handle) */}
          {activeScrubPrice !== null && (
            <line
              x1={0}
              y1={knobY}
              x2={expiryX}
              y2={knobY}
              stroke="rgba(255,255,255,0.34)"
              strokeWidth={1}
              strokeDasharray="2 3"
              pointerEvents="none"
            />
          )}

          {/* Subtle Bottom-Left History Window Tag (e.g. 24H / 7D) */}
          {windowLabel && (
            <text
              x={8}
              y={height - 5}
              fontSize={10}
              fontWeight={500}
              fill="#525862"
              pointerEvents="none"
            >
              {windowLabel}
            </text>
          )}
        </svg>

        {/* Interactive Expiry-Line Scrubber Rail & Sleek Vertical Pill Handle */}
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
            className="absolute z-10 w-11 touch-pan-x cursor-ns-resize focus-visible:outline-2 focus-visible:outline-white/70 focus-visible:rounded-full"
          >
            <div
              aria-hidden="true"
              style={{ top: `${knobY - (padTop - 4)}px` }}
              className="pointer-events-none absolute left-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center justify-center"
            >
              <span
                className={`flex h-6 w-3.5 items-center justify-center rounded-full bg-white shadow-[0_2px_10px_rgba(0,0,0,0.85)] transition-transform ${
                  activeScrubPrice !== null || isDraggingScrub
                    ? "scale-105 ring-4 ring-white/25"
                    : "ring-4 ring-white/14"
                }`}
              >
                <span className="flex flex-col gap-[2px]">
                  <span className="block h-[1.2px] w-1.5 rounded-full bg-black/70" />
                  <span className="block h-[1.2px] w-1.5 rounded-full bg-black/70" />
                </span>
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

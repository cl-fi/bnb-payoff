import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  AreaSeries,
  CandlestickSeries,
  ColorType,
  createChart,
  LineStyle,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type Time,
} from "lightweight-charts";
import { X } from "lucide-react";
import {
  computeSpreadPayoffFraction,
  type CandleBar,
  type CandlePoint,
  type PositionView,
  type TicketSummary,
  type UnderlyingSymbol,
} from "@payoff/shared";
import { formatStrikePrice } from "../lib/format";
import { getCopy, type Locale } from "../lib/i18n";
import {
  SpreadRangePrimitive,
  type EntryMarkerSpec,
  type PositionBarSpec,
  type PriceLineLabelSpec,
} from "./SpreadRangePrimitive";

export interface KlineChartProps {
  locale: Locale;
  candles: CandlePoint[];
  bar: CandleBar;
  onChangeBar: (bar: CandleBar) => void;
  ticket?: TicketSummary;
  liveSpot?: number;
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
const SUB_TEXT = "#7E8690";

function findClosestCandle(
  candles: CandlePoint[],
  targetSec: number
): CandlePoint | null {
  if (candles.length === 0) return null;
  if (targetSec < candles[0].time || targetSec > candles[candles.length - 1].time + 3600) {
    return null;
  }
  let best = candles[0];
  let bestDist = Math.abs(candles[0].time - targetSec);
  for (let i = 1; i < candles.length; i++) {
    const d = Math.abs(candles[i].time - targetSec);
    if (d < bestDist) {
      bestDist = d;
      best = candles[i];
    }
  }
  return best;
}

export function KlineChart({
  locale,
  candles,
  bar,
  onChangeBar,
  ticket,
  liveSpot,
  positions,
  selectedPositionId = null,
  inTwapWindow = false,
  twapAvgPrice = null,
  scrubPrice: controlledScrubPrice,
  onScrubPriceChange,
  height = 264,
}: KlineChartProps) {
  const t = getCopy(locale);
  const [mode, setMode] = useState<"LINE" | "CANDLE">("LINE");
  const [internalScrubPrice, setInternalScrubPrice] = useState<number | null>(
    null
  );
  const [scrubY, setScrubY] = useState<number | null>(null);
  const [rightScaleWidth, setRightScaleWidth] = useState<number>(66);
  const [isDraggingScrub, setIsDraggingScrub] = useState(false);

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

  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | ISeriesApi<"Area"> | null>(
    null
  );
  const rangePrimitiveRef = useRef<SpreadRangePrimitive | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);

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
  const lineTopRgba = inTwapWindow
    ? "rgba(230, 186, 92, 0.11)"
    : isBull
      ? "rgba(46, 194, 107, 0.11)"
      : "rgba(232, 93, 74, 0.11)";

  const underlying: UnderlyingSymbol | undefined =
    selectedPosition?.underlying ?? ticket?.underlying;

  // Keep refs for autoscaleInfoProvider
  const scaleTargetsRef = useRef<{
    ticket?: TicketSummary;
    positions: PositionView[];
    twapAvgPrice?: number | null;
  }>({ ticket, positions: activePositions, twapAvgPrice });
  scaleTargetsRef.current = { ticket, positions: activePositions, twapAvgPrice };

  const bars: { id: CandleBar; label: string }[] = [
    { id: "5m", label: t.bar5m },
    { id: "15m", label: t.bar15m },
    { id: "1H", label: t.bar1H },
    { id: "4H", label: t.bar4H },
    { id: "1D", label: t.bar1D },
  ];

  // Recompute pixel Y for scrubber handle whenever price or scale updates
  const syncScrubCoordinate = useCallback(() => {
    const series = seriesRef.current;
    const chart = chartRef.current;
    if (chart) {
      const w = chart.priceScale("right").width();
      if (w > 24 && w < 140) setRightScaleWidth(w);
    }
    if (!series) {
      setScrubY(null);
      return;
    }
    const targetPrice =
      activeScrubPrice ??
      (selectedPosition
        ? (selectedPosition.lowerStrike + selectedPosition.upperStrike) / 2
        : ticket
          ? ticket.breakevenPrice
          : liveSpot ?? null);

    if (targetPrice === null || !Number.isFinite(targetPrice)) {
      setScrubY(null);
      return;
    }
    const coord = series.priceToCoordinate(targetPrice);
    if (coord === null || !Number.isFinite(coord)) {
      setScrubY(null);
      return;
    }
    setScrubY(Math.max(16, Math.min(height - 34, coord)));
  }, [activeScrubPrice, selectedPosition, ticket, liveSpot, height]);

  // Initialize Lightweight Charts instance
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      width: el.clientWidth,
      height,
      layout: {
        background: { type: ColorType.Solid, color: "#000000" },
        textColor: SUB_TEXT,
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "SF Pro Display", "IBM Plex Sans", "PingFang SC", sans-serif',
        fontSize: 11,
        attributionLogo: false,
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { visible: false },
      },
      rightPriceScale: {
        borderVisible: false,
        scaleMargins: { top: 0.14, bottom: 0.16 },
      },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 4,
      },
      crosshair: {
        vertLine: {
          color: "#2b3038",
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: "#15171b",
        },
        horzLine: {
          color: "#2b3038",
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: "#15171b",
        },
      },
    });

    const autoscaleInfoProvider = (original: () => any) => {
      const res = original();
      if (!res?.priceRange) return res;
      let minValue = res.priceRange.minValue;
      let maxValue = res.priceRange.maxValue;
      const { ticket: cur, positions: posList, twapAvgPrice: avg } =
        scaleTargetsRef.current;
      if (cur) {
        minValue = Math.min(minValue, cur.lowerStrike);
        maxValue = Math.max(maxValue, cur.upperStrike);
      }
      for (const p of posList) {
        minValue = Math.min(minValue, p.lowerStrike);
        maxValue = Math.max(maxValue, p.upperStrike);
      }
      if (avg && Number.isFinite(avg)) {
        minValue = Math.min(minValue, avg);
        maxValue = Math.max(maxValue, avg);
      }
      return {
        ...res,
        priceRange: { minValue, maxValue },
      };
    };

    const series =
      mode === "CANDLE"
        ? chart.addSeries(CandlestickSeries, {
            upColor: UP_GREEN,
            downColor: DOWN_CORAL,
            borderUpColor: UP_GREEN,
            borderDownColor: DOWN_CORAL,
            wickUpColor: UP_GREEN,
            wickDownColor: DOWN_CORAL,
            priceFormat: { type: "price", precision: 2, minMove: 0.01 },
            autoscaleInfoProvider,
          })
        : chart.addSeries(AreaSeries, {
            lineColor: lineColor,
            topColor: lineTopRgba,
            bottomColor: "rgba(0, 0, 0, 0)",
            lineWidth: 2,
            priceLineVisible: false,
            lastValueVisible: true,
            priceFormat: { type: "price", precision: 2, minMove: 0.01 },
            autoscaleInfoProvider,
          });

    const primitive = new SpreadRangePrimitive({
      lowerPrice: scaleTargetsRef.current.ticket?.lowerStrike ?? 0,
      upperPrice: scaleTargetsRef.current.ticket?.upperStrike ?? 0,
      direction: scaleTargetsRef.current.ticket?.direction ?? "BULL",
      hasScrubber: true,
    });
    series.attachPrimitive(primitive);

    chartRef.current = chart;
    seriesRef.current = series;
    rangePrimitiveRef.current = primitive;
    priceLinesRef.current = [];

    const handleVisibleRange = () => {
      syncScrubCoordinate();
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(handleVisibleRange);

    const ro = new ResizeObserver(() => {
      if (containerRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth });
        const w = chart.priceScale("right").width();
        if (w > 24 && w < 140) setRightScaleWidth(w);
        syncScrubCoordinate();
      }
    });
    ro.observe(el);

    return () => {
      chart
        .timeScale()
        .unsubscribeVisibleLogicalRangeChange(handleVisibleRange);
      ro.disconnect();
      priceLinesRef.current = [];
      rangePrimitiveRef.current = null;
      seriesRef.current = null;
      chartRef.current = null;
      chart.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, height]);

  // Update candle / line series data
  useEffect(() => {
    const series = seriesRef.current;
    if (!series || candles.length === 0) return;

    const merged = candles.map((c, idx) => {
      if (idx === candles.length - 1 && liveSpot && liveSpot > 0) {
        return {
          ...c,
          close: liveSpot,
          high: Math.max(c.high, liveSpot),
          low: Math.min(c.low, liveSpot),
        };
      }
      return c;
    });

    if (mode === "CANDLE") {
      (series as ISeriesApi<"Candlestick">).setData(
        merged.map((c) => ({
          time: c.time as Time,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
        }))
      );
    } else {
      (series as ISeriesApi<"Area">).setData(
        merged.map((c) => ({
          time: c.time as Time,
          value: c.close,
        }))
      );
    }
    chartRef.current?.timeScale().fitContent();
    requestAnimationFrame(syncScrubCoordinate);
  }, [candles, mode, liveSpot, syncScrubCoordinate]);

  // Update series color, payoff wash, positions, TWAP overlay, and price lines
  useEffect(() => {
    const series = seriesRef.current;
    const primitive = rangePrimitiveRef.current;
    if (!series || !primitive) return;

    if (mode === "LINE") {
      (series as ISeriesApi<"Area">).applyOptions({
        lineColor,
        topColor: lineTopRgba,
        bottomColor: "rgba(0, 0, 0, 0)",
      });
    }

    const washLower =
      selectedPosition?.lowerStrike ?? ticket?.lowerStrike ?? 0;
    const washUpper =
      selectedPosition?.upperStrike ?? ticket?.upperStrike ?? 0;
    const washDir =
      selectedPosition?.direction ?? ticket?.direction ?? "BULL";

    const positionBars: PositionBarSpec[] = activePositions.map((p) => ({
      id: p.tokenId || p.seriesId,
      lowerPrice: p.lowerStrike,
      upperPrice: p.upperStrike,
      direction: p.direction,
      selected: Boolean(
        selectedPositionId &&
          (p.tokenId === selectedPositionId ||
            p.seriesId === selectedPositionId)
      ),
    }));

    const entryMarkers: EntryMarkerSpec[] = [];
    for (const p of activePositions) {
      const createdSec =
        p.createdAt > 1e12 ? Math.floor(p.createdAt / 1000) : p.createdAt;
      const snapped = findClosestCandle(candles, createdSec);
      if (snapped) {
        const isSel = Boolean(
          selectedPositionId &&
            (p.tokenId === selectedPositionId ||
              p.seriesId === selectedPositionId)
        );
        entryMarkers.push({
          id: p.tokenId || p.seriesId,
          time: snapped.time,
          price: snapped.close,
          direction: p.direction,
          label: `$${Math.round(p.totalStakeUsdt)}`,
          selected: isSel,
        });
      }
    }

    const lastCandleTime =
      candles.length > 0 ? candles[candles.length - 1].time : null;
    const twapStartTime =
      inTwapWindow && lastCandleTime ? lastCandleTime - 30 * 60 : null;

    for (const pl of priceLinesRef.current) {
      series.removePriceLine(pl);
    }

    const nextLines: IPriceLine[] = [];
    const priceLineLabels: PriceLineLabelSpec[] = [];
    const targetForLines = selectedPosition
      ? {
          direction: selectedPosition.direction,
          underlying: selectedPosition.underlying,
          capPrice: selectedPosition.capPrice,
          breakevenPrice: selectedPosition.breakevenPrice,
          startPrice: selectedPosition.startPrice,
          maxPayoutUsdt: selectedPosition.remainingBalanceUsdt,
        }
      : ticket
        ? {
            direction: ticket.direction,
            underlying: ticket.underlying,
            capPrice: ticket.fullPayoutPrice,
            breakevenPrice: ticket.breakevenPrice,
            startPrice: ticket.startPrice,
            maxPayoutUsdt: ticket.maxPayoutUsdt,
          }
        : null;

    if (targetForLines) {
      const bull = targetForLines.direction === "BULL";
      const col = bull ? UP_GREEN : DOWN_CORAL;
      const capArrow = bull ? "≥" : "≤";
      const capPriceStr = formatStrikePrice(
        targetForLines.capPrice,
        targetForLines.underlying
      );
      const capTitle = t.chartCapPill(
        targetForLines.maxPayoutUsdt.toFixed(2),
        capArrow,
        capPriceStr
      );
      const beTitle = t.mathBreakevenShort(
        formatStrikePrice(
          targetForLines.breakevenPrice,
          targetForLines.underlying
        )
      );
      const startTitle = t.mathStartShort(
        formatStrikePrice(targetForLines.startPrice, targetForLines.underlying)
      );

      // Render crisp horizontal lines + right price-axis badges with empty right-edge title
      // so Lightweight Charts titles NEVER collide with the right-edge scrubber knob.
      // Labels are drawn cleanly on the left edge via SpreadRangePrimitive with anti-overlap.
      nextLines.push(
        series.createPriceLine({
          price: targetForLines.capPrice,
          color: col,
          lineWidth: 2,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: true,
          title: "",
        }),
        series.createPriceLine({
          price: targetForLines.breakevenPrice,
          color: "#6b737d",
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: true,
          title: "",
        }),
        series.createPriceLine({
          price: targetForLines.startPrice,
          color: "#2b3038",
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: false,
          title: "",
        })
      );

      priceLineLabels.push(
        {
          price: targetForLines.capPrice,
          text: capTitle,
          color: col,
          borderColor: bull
            ? "rgba(46, 194, 107, 0.35)"
            : "rgba(232, 93, 74, 0.35)",
          priority: 1,
        },
        {
          price: targetForLines.breakevenPrice,
          text: beTitle,
          color: "#b8bec6",
          borderColor: "rgba(255, 255, 255, 0.14)",
          priority: 2,
        },
        {
          price: targetForLines.startPrice,
          text: startTitle,
          color: "#7e8690",
          borderColor: "rgba(255, 255, 255, 0.08)",
          priority: 3,
        }
      );
    }

    primitive.applyOptions({
      lowerPrice: washLower,
      upperPrice: washUpper,
      direction: washDir,
      showPayoffWash: washUpper > washLower,
      positions: positionBars,
      selectedPositionId,
      entryMarkers,
      priceLineLabels,
      inTwapWindow,
      twapStartTime,
      twapAvgPrice,
      twapLabel: locale === "zh" ? "30m 均价窗" : "30m TWAP",
      twapAvgLabel:
        twapAvgPrice && Number.isFinite(twapAvgPrice)
          ? locale === "zh"
            ? `均价 ${formatStrikePrice(twapAvgPrice, underlying)}`
            : `Avg ${formatStrikePrice(twapAvgPrice, underlying)}`
          : undefined,
      scrubPrice: activeScrubPrice,
      hasScrubber: Boolean(ticket || activePositions.length > 0),
    });

    priceLinesRef.current = nextLines;
    chartRef.current?.priceScale("right").applyOptions({ autoScale: true });
    requestAnimationFrame(syncScrubCoordinate);
  }, [
    ticket,
    selectedPosition,
    activePositions,
    selectedPositionId,
    candles,
    inTwapWindow,
    twapAvgPrice,
    activeScrubPrice,
    mode,
    locale,
    lineColor,
    lineTopRgba,
    underlying,
    syncScrubCoordinate,
  ]);

  // Scrub evaluation readout (multi-position combined total when holding, or single draft ticket)
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

  const updateScrubFromClientY = useCallback(
    (clientY: number) => {
      const container = containerRef.current;
      const series = seriesRef.current;
      if (!container || !series) return;
      const rect = container.getBoundingClientRect();
      const localY = Math.max(12, Math.min(height - 30, clientY - rect.top));
      const price = series.coordinateToPrice(localY);
      if (price === null || !Number.isFinite(price) || price <= 0) return;
      setScrubY(localY);
      setScrubPrice(Number(price.toFixed(2)));
    },
    [height, setScrubPrice]
  );

  const handleScrubPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setIsDraggingScrub(true);
    updateScrubFromClientY(e.clientY);
  };

  const handleScrubPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!isDraggingScrub && e.buttons === 0) return;
    updateScrubFromClientY(e.clientY);
  };

  const handleScrubPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    setIsDraggingScrub(false);
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
      (candles.length > 0 ? candles[candles.length - 1].close : null);
    if (!basePrice) return;
    const span =
      ticket && ticket.upperStrike > ticket.lowerStrike
        ? ticket.upperStrike - ticket.lowerStrike
        : basePrice * 0.02;
    const step = Math.max(0.01, span * 0.05);
    const next = e.key === "ArrowUp" ? basePrice + step : Math.max(0.01, basePrice - step);
    setScrubPrice(Number(next.toFixed(2)));
  };

  const canScrub = Boolean(ticket || activePositions.length > 0);
  const payoutColor =
    scrubSummary && scrubSummary.payoutUsdt >= scrubSummary.stakeUsdt
      ? UP_GREEN
      : scrubSummary && scrubSummary.payoutUsdt > 0
        ? GOLD
        : SUB_TEXT;

  return (
    <div className="bg-black">
      {/* Inline Settlement-Price Scrubber Readout (appears while scrubbing) */}
      {scrubSummary && (
        <div
          role="status"
          aria-live="polite"
          className="mb-2 flex items-center justify-between gap-2 rounded-2xl bg-[#15171b] px-3.5 py-2 text-xs tabular-nums"
        >
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[#b8bec6]">
            <span>
              {locale === "zh" ? "结算在" : "If settles at"}{" "}
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
                  ? `合计拿回`
                  : `Total payout`
                : locale === "zh"
                  ? `拿回`
                  : `Payout`}{" "}
              <strong
                className="text-sm font-bold"
                style={{ color: payoutColor }}
              >
                ${scrubSummary.payoutUsdt.toFixed(2)}
              </strong>
            </span>
            {scrubSummary.payoutUsdt > 0 &&
              scrubSummary.payoutUsdt < scrubSummary.stakeUsdt && (
                <span className="rounded-full bg-[#E6BA5C]/15 px-1.5 py-0.5 text-[10px] font-semibold text-[#E6BA5C]">
                  {t.outcomePartialBadge}
                </span>
              )}
          </div>
          <button
            type="button"
            onClick={() => setScrubPrice(null)}
            aria-label={locale === "zh" ? "清除试算" : "Clear simulation"}
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#24282f] text-[#b8bec6] hover:text-white cursor-pointer"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      )}

      {/* Full-Bleed Borderless Pure-Black Chart Canvas */}
      <div className="relative w-full overflow-hidden bg-black">
        <div
          ref={containerRef}
          className="w-full"
          style={{ height: `${height}px` }}
        />

        {/* Touch & Pointer Friendly Right-Edge Settlement Price Scrubber */}
        {canScrub && scrubY !== null && (
          <div
            role="slider"
            tabIndex={0}
            aria-label={
              locale === "zh"
                ? "拖动模拟到期结算价"
                : "Drag to simulate settlement price"
            }
            aria-orientation="vertical"
            aria-valuetext={
              activeScrubPrice !== null
                ? `${formatStrikePrice(activeScrubPrice, underlying)}`
                : locale === "zh"
                  ? "上下拖动试算到期收益"
                  : "Drag up or down to simulate payout"
            }
            onPointerDown={handleScrubPointerDown}
            onPointerMove={handleScrubPointerMove}
            onPointerUp={handleScrubPointerUp}
            onPointerCancel={handleScrubPointerUp}
            onKeyDown={handleScrubKeyDown}
            style={{
              right: `${Math.max(48, rightScaleWidth + 2)}px`,
              height: `${height - 28}px`,
            }}
            className="absolute top-0 z-10 flex w-7 touch-none select-none items-center justify-center cursor-ns-resize focus-visible:outline-2 focus-visible:outline-white/70 focus-visible:rounded-full"
          >
            {/* Subtle vertical expiry guide line */}
            <div
              aria-hidden="true"
              className="pointer-events-none h-full w-px border-l border-dashed border-[#2b2f36]"
            />

            {/* Floating White Scrubber Thumb */}
            <div
              aria-hidden="true"
              style={{ top: `${scrubY}px` }}
              className="pointer-events-none absolute left-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center justify-center"
            >
              <span
                className={`flex h-6 w-6 items-center justify-center rounded-full transition-transform ${
                  activeScrubPrice !== null || isDraggingScrub
                    ? "scale-105 bg-white/15"
                    : "bg-white/10"
                }`}
              >
                <span className="flex h-4 w-4 items-center justify-center rounded-full bg-white shadow-[0_2px_8px_rgba(0,0,0,0.7)]">
                  <svg
                    width="8"
                    height="10"
                    viewBox="0 0 8 10"
                    fill="none"
                    className="block"
                  >
                    <path
                      d="M1.5 3.6L4 1.2L6.5 3.6M1.5 6.4L4 8.8L6.5 6.4"
                      stroke="#000000"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
              </span>
            </div>

            {/* Compact floating pill next to thumb while actively scrubbing */}
            {activeScrubPrice !== null && (
              <div
                aria-hidden="true"
                style={{ top: `${Math.max(18, scrubY - 22)}px` }}
                className="pointer-events-none absolute right-8 whitespace-nowrap rounded-full bg-white px-2.5 py-0.5 text-[10.5px] font-bold text-black tabular-nums shadow-lg"
              >
                {formatStrikePrice(activeScrubPrice, underlying)}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Minimal Dark Timeframe & Line/Candle Toggle Bar */}
      <div className="mt-2 flex items-center justify-between gap-2">
        <div
          className="flex items-center gap-1"
          role="group"
          aria-label={locale === "zh" ? "图表周期" : "Chart timeframe"}
        >
          {bars.map((b) => {
            const active = bar === b.id;
            return (
              <button
                key={b.id}
                type="button"
                aria-pressed={active}
                onClick={() => onChangeBar(b.id)}
                className={`min-h-[28px] rounded-full px-2.5 py-1 text-[11.5px] font-semibold transition cursor-pointer focus-visible:outline-2 focus-visible:outline-white/70 ${
                  active
                    ? "bg-[#24282f] text-white"
                    : "text-[#7e8690] hover:text-[#b8bec6]"
                }`}
              >
                {b.label}
              </button>
            );
          })}
        </div>

        <div
          className="inline-flex items-center rounded-full bg-[#131519] p-0.5 text-[11px] font-semibold"
          role="group"
          aria-label={locale === "zh" ? "图表样式" : "Chart style"}
        >
          <button
            type="button"
            aria-pressed={mode === "LINE"}
            onClick={() => setMode("LINE")}
            className={`min-h-[26px] rounded-full px-2.5 py-0.5 transition cursor-pointer ${
              mode === "LINE"
                ? "bg-[#24282f] text-white"
                : "text-[#7e8690] hover:text-[#b8bec6]"
            }`}
          >
            {t.chartLine}
          </button>
          <button
            type="button"
            aria-pressed={mode === "CANDLE"}
            onClick={() => setMode("CANDLE")}
            className={`min-h-[26px] rounded-full px-2.5 py-0.5 transition cursor-pointer ${
              mode === "CANDLE"
                ? "bg-[#24282f] text-white"
                : "text-[#7e8690] hover:text-[#b8bec6]"
            }`}
          >
            {t.chartCandle}
          </button>
        </div>
      </div>
    </div>
  );
}

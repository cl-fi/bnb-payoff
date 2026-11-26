import { useEffect, useRef, useState } from "react";
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
import type { CandleBar, CandlePoint, TicketSummary } from "@payoff/shared";
import { formatStrikeNumber, formatStrikePrice } from "../lib/format";
import { getCopy, type Locale } from "../lib/i18n";
import { SpreadRangePrimitive } from "./SpreadRangePrimitive";

interface Props {
  locale: Locale;
  candles: CandlePoint[];
  bar: CandleBar;
  onChangeBar: (bar: CandleBar) => void;
  ticket?: TicketSummary;
  liveSpot?: number;
}

const PAY_TEAL = "#0e7c72";
const NEG_CRIMSON = "#b54134";
const WARN_AMBER = "#8a6410";
const INK = "#14202a";

export function KlineChart({
  locale,
  candles,
  bar,
  onChangeBar,
  ticket,
  liveSpot,
}: Props) {
  const t = getCopy(locale);
  const [mode, setMode] = useState<"CANDLE" | "LINE">("CANDLE");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | ISeriesApi<"Area"> | null>(
    null
  );
  const rangePrimitiveRef = useRef<SpreadRangePrimitive | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const ticketRef = useRef<TicketSummary | undefined>(ticket);
  ticketRef.current = ticket;

  const isBull = (ticket?.direction ?? "BULL") === "BULL";
  const accentColor = isBull ? PAY_TEAL : NEG_CRIMSON;

  const bars: { id: CandleBar; label: string }[] = [
    { id: "5m", label: t.bar5m },
    { id: "15m", label: t.bar15m },
    { id: "1H", label: t.bar1H },
    { id: "4H", label: t.bar4H },
    { id: "1D", label: t.bar1D },
  ];

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      width: el.clientWidth,
      height: 280,
      layout: {
        background: { type: ColorType.Solid, color: "#ffffff" },
        textColor: "#667080",
        fontFamily:
          '"IBM Plex Sans", -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif',
        fontSize: 11,
        attributionLogo: false,
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: "#eef0f2" },
      },
      rightPriceScale: {
        borderVisible: false,
        scaleMargins: { top: 0.14, bottom: 0.14 },
      },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false,
      },
      crosshair: {
        vertLine: {
          color: "#c8ccd1",
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: INK,
        },
        horzLine: {
          color: "#c8ccd1",
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: INK,
        },
      },
    });

    const autoscaleInfoProvider = (original: () => any) => {
      const res = original();
      const cur = ticketRef.current;
      if (!res?.priceRange || !cur) return res;
      return {
        ...res,
        priceRange: {
          minValue: Math.min(res.priceRange.minValue, cur.lowerStrike),
          maxValue: Math.max(res.priceRange.maxValue, cur.upperStrike),
        },
      };
    };

    const series =
      mode === "CANDLE"
        ? chart.addSeries(CandlestickSeries, {
            upColor: PAY_TEAL,
            downColor: NEG_CRIMSON,
            borderUpColor: PAY_TEAL,
            borderDownColor: NEG_CRIMSON,
            wickUpColor: PAY_TEAL,
            wickDownColor: NEG_CRIMSON,
            priceFormat: { type: "price", precision: 2, minMove: 0.01 },
            autoscaleInfoProvider,
          })
        : chart.addSeries(AreaSeries, {
            lineColor: accentColor,
            topColor: isBull
              ? "rgba(14, 124, 114, 0.14)"
              : "rgba(181, 65, 52, 0.14)",
            bottomColor: "rgba(255, 255, 255, 0)",
            lineWidth: 2,
            priceFormat: { type: "price", precision: 2, minMove: 0.01 },
            autoscaleInfoProvider,
          });

    const primitive = new SpreadRangePrimitive({
      lowerPrice: ticketRef.current?.lowerStrike ?? 0,
      upperPrice: ticketRef.current?.upperStrike ?? 0,
      fillColor: isBull
        ? "rgba(14, 124, 114, 0.10)"
        : "rgba(181, 65, 52, 0.10)",
      borderColor: accentColor,
    });
    series.attachPrimitive(primitive);

    chartRef.current = chart;
    seriesRef.current = series;
    rangePrimitiveRef.current = primitive;
    priceLinesRef.current = [];

    const ro = new ResizeObserver(() => {
      if (containerRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth });
      }
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      priceLinesRef.current = [];
      rangePrimitiveRef.current = null;
      seriesRef.current = null;
      chartRef.current = null;
      chart.remove();
    };
  }, [mode]);

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
  }, [candles, mode, liveSpot]);

  useEffect(() => {
    const series = seriesRef.current;
    const primitive = rangePrimitiveRef.current;
    if (!series || !primitive || !ticket) return;

    const bull = ticket.direction === "BULL";
    const mainColor = bull ? PAY_TEAL : NEG_CRIMSON;

    if (mode === "LINE") {
      (series as ISeriesApi<"Area">).applyOptions({
        lineColor: mainColor,
        topColor: bull
          ? "rgba(14, 124, 114, 0.14)"
          : "rgba(181, 65, 52, 0.14)",
      });
    }

    primitive.applyOptions({
      lowerPrice: ticket.lowerStrike,
      upperPrice: ticket.upperStrike,
      fillColor: bull ? "rgba(14, 124, 114, 0.10)" : "rgba(181, 65, 52, 0.10)",
      borderColor: mainColor,
    });

    for (const pl of priceLinesRef.current) {
      series.removePriceLine(pl);
    }
    priceLinesRef.current = [
      series.createPriceLine({
        price: ticket.fullPayoutPrice,
        color: mainColor,
        lineWidth: 2,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: t.chartCapLabel(ticket.maxMultiplier.toFixed(2)),
      }),
      series.createPriceLine({
        price: ticket.breakevenPrice,
        color: WARN_AMBER,
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: true,
        title: t.chartBreakevenLabel,
      }),
      series.createPriceLine({
        price: ticket.startPrice,
        color: "#667080",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: t.chartStartLabel,
      }),
    ];

    chartRef.current?.priceScale("right").applyOptions({ autoScale: true });
  }, [
    ticket?.lowerStrike,
    ticket?.upperStrike,
    ticket?.breakevenPrice,
    ticket?.direction,
    ticket?.maxMultiplier,
    mode,
    locale,
  ]);

  return (
    <div className="space-y-3">
      <div className="relative w-full overflow-hidden rounded-xl border border-[#e2e5e8] bg-white p-1">
        <div ref={containerRef} className="w-full h-[280px]" />
      </div>

      {/* Monochrome Timeframe & Chart Mode Bar */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          {bars.map((b) => {
            const active = bar === b.id;
            return (
              <button
                key={b.id}
                type="button"
                onClick={() => onChangeBar(b.id)}
                className={`rounded-md px-2.5 py-1 text-xs font-semibold transition cursor-pointer ${
                  active
                    ? "bg-[#14202a] text-white"
                    : "text-[#667080] hover:bg-[#eef0f2] hover:text-[#14202a]"
                }`}
              >
                {b.label}
              </button>
            );
          })}
        </div>

        <div className="flex items-center rounded-lg bg-[#eef0f2] p-0.5 text-[11px] font-semibold">
          <button
            type="button"
            onClick={() => setMode("CANDLE")}
            className={`rounded-md px-2.5 py-1 transition cursor-pointer ${
              mode === "CANDLE"
                ? "bg-white text-[#14202a] shadow-xs"
                : "text-[#667080]"
            }`}
          >
            {t.chartCandle}
          </button>
          <button
            type="button"
            onClick={() => setMode("LINE")}
            className={`rounded-md px-2.5 py-1 transition cursor-pointer ${
              mode === "LINE"
                ? "bg-white text-[#14202a] shadow-xs"
                : "text-[#667080]"
            }`}
          >
            {t.chartLine}
          </button>
        </div>
      </div>

      {ticket && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#e2e5e8] bg-white px-3.5 py-2.5 text-xs">
          <div className="flex items-center gap-2 text-[#3a4552]">
            <span
              className="h-2 w-2 rounded-full shrink-0"
              style={{ backgroundColor: accentColor }}
            />
            <span>
              {t.profitZone}{" "}
              <strong className="text-[#14202a] tabular-nums">
                {formatStrikePrice(ticket.startPrice, ticket.underlying)} →{" "}
                {formatStrikePrice(ticket.capPrice, ticket.underlying)}
              </strong>
            </span>
          </div>
          <span className="text-[11px] text-[#667080] tabular-nums">
            {t.perpCompare(
              formatStrikeNumber(ticket.perp50xLiqPrice, ticket.underlying)
            )}
          </span>
        </div>
      )}
    </div>
  );
}

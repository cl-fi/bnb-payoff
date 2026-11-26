import type {
  IChartApiBase,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  PrimitivePaneViewZOrder,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from "lightweight-charts";

export interface PositionBarSpec {
  id: string;
  lowerPrice: number;
  upperPrice: number;
  direction: "BULL" | "BEAR";
  selected?: boolean;
}

export interface EntryMarkerSpec {
  id: string;
  time: number; // unix seconds
  price: number;
  direction: "BULL" | "BEAR";
  label?: string;
  selected?: boolean;
}

export interface PriceLineLabelSpec {
  price: number;
  text: string;
  color: string;
  borderColor?: string;
  priority: number;
}

export interface SpreadRangeOptions {
  lowerPrice: number;
  upperPrice: number;
  direction?: "BULL" | "BEAR";
  fillColor?: string;
  borderColor?: string;
  showPayoffWash?: boolean;
  positions?: PositionBarSpec[];
  selectedPositionId?: string | null;
  entryMarkers?: EntryMarkerSpec[];
  priceLineLabels?: PriceLineLabelSpec[];
  inTwapWindow?: boolean;
  twapStartTime?: number | null;
  twapAvgPrice?: number | null;
  twapLabel?: string;
  twapAvgLabel?: string;
  scrubPrice?: number | null;
  hasScrubber?: boolean;
}

const UP_GREEN = "#2EC26B";
const DOWN_CORAL = "#E85D4A";
const GOLD = "#E6BA5C";

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

class SpreadRangeBackgroundRenderer implements IPrimitivePaneRenderer {
  constructor(
    private chart: IChartApiBase<Time>,
    private series: ISeriesApi<SeriesType>,
    private options: SpreadRangeOptions
  ) {}

  draw(): void {
    // Drawn in background layer so price line/candles stay crisp on top
  }

  drawBackground(target: Parameters<IPrimitivePaneRenderer["draw"]>[0]): void {
    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const hpr = scope.horizontalPixelRatio;
      const vpr = scope.verticalPixelRatio;
      const bitmapW = scope.bitmapSize.width;
      const bitmapH = scope.bitmapSize.height;
      const cssW = bitmapW / hpr;

      // 1. Warm-gold 30m TWAP observation window tint
      if (this.options.inTwapWindow) {
        let x0Css: number | null = null;
        if (this.options.twapStartTime) {
          const coord = this.chart
            .timeScale()
            .timeToCoordinate(this.options.twapStartTime as Time);
          if (coord !== null && Number.isFinite(coord)) {
            x0Css = Math.max(24, Math.min(cssW - 56, coord));
          }
        }
        if (x0Css === null) {
          x0Css = Math.max(0, cssW * 0.74);
        }
        const x0 = Math.round(x0Css * hpr);
        const twapW = Math.max(1, bitmapW - x0);

        ctx.save();
        ctx.fillStyle = "rgba(230, 186, 92, 0.09)";
        ctx.fillRect(x0, 0, twapW, bitmapH);

        ctx.strokeStyle = "rgba(230, 186, 92, 0.35)";
        ctx.lineWidth = Math.max(1, Math.round(1 * hpr));
        ctx.setLineDash([3 * vpr, 4 * vpr]);
        ctx.beginPath();
        ctx.moveTo(x0 + 0.5, 0);
        ctx.lineTo(x0 + 0.5, bitmapH);
        ctx.stroke();

        const label = this.options.twapLabel ?? "30m TWAP";
        ctx.setLineDash([]);
        ctx.fillStyle = GOLD;
        ctx.font = `700 ${Math.round(9.5 * vpr)}px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        ctx.fillText(label, x0 + twapW / 2, bitmapH - 6 * vpr);
        ctx.restore();
      }

      // 2. Soft vertical gradient payoff wash (0.19 -> 0)
      const showWash = this.options.showPayoffWash !== false;
      if (
        showWash &&
        Number.isFinite(this.options.upperPrice) &&
        Number.isFinite(this.options.lowerPrice) &&
        this.options.upperPrice > this.options.lowerPrice
      ) {
        const yUpper = this.series.priceToCoordinate(this.options.upperPrice);
        const yLower = this.series.priceToCoordinate(this.options.lowerPrice);
        if (yUpper !== null && yLower !== null) {
          const top = Math.min(yUpper, yLower) * vpr;
          const bottom = Math.max(yUpper, yLower) * vpr;
          const height = Math.max(1, bottom - top);
          const isBear = this.options.direction === "BEAR";

          ctx.save();
          const grad = ctx.createLinearGradient(0, top, 0, bottom);
          if (isBear) {
            grad.addColorStop(0, "rgba(232, 93, 74, 0)");
            grad.addColorStop(1, "rgba(232, 93, 74, 0.19)");
          } else {
            grad.addColorStop(0, "rgba(46, 194, 107, 0.19)");
            grad.addColorStop(1, "rgba(46, 194, 107, 0)");
          }
          ctx.fillStyle = grad;
          ctx.fillRect(0, top, bitmapW, height);
          ctx.restore();
        }
      }
    });
  }
}

class SpreadRangeForegroundRenderer implements IPrimitivePaneRenderer {
  constructor(
    private chart: IChartApiBase<Time>,
    private series: ISeriesApi<SeriesType>,
    private options: SpreadRangeOptions
  ) {}

  draw(target: Parameters<IPrimitivePaneRenderer["draw"]>[0]): void {
    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const hpr = scope.horizontalPixelRatio;
      const vpr = scope.verticalPixelRatio;
      const bitmapW = scope.bitmapSize.width;
      const bitmapH = scope.bitmapSize.height;
      const cssW = bitmapW / hpr;

      // 1. Warm-gold TWAP running average line & pill
      if (
        this.options.inTwapWindow &&
        this.options.twapAvgPrice &&
        Number.isFinite(this.options.twapAvgPrice)
      ) {
        const yAvgCss = this.series.priceToCoordinate(
          this.options.twapAvgPrice
        );
        if (yAvgCss !== null) {
          let x0Css: number | null = null;
          if (this.options.twapStartTime) {
            const coord = this.chart
              .timeScale()
              .timeToCoordinate(this.options.twapStartTime as Time);
            if (coord !== null && Number.isFinite(coord)) {
              x0Css = Math.max(24, Math.min(cssW - 56, coord));
            }
          }
          if (x0Css === null) {
            x0Css = Math.max(0, cssW * 0.74);
          }

          const x0 = Math.round(x0Css * hpr);
          const yAvg = Math.round(yAvgCss * vpr);

          ctx.save();
          ctx.strokeStyle = GOLD;
          ctx.lineWidth = Math.max(2, Math.round(2 * vpr));
          ctx.beginPath();
          ctx.moveTo(x0, yAvg);
          ctx.lineTo(bitmapW, yAvg);
          ctx.stroke();

          if (this.options.twapAvgLabel) {
            const fontSize = Math.round(10 * vpr);
            ctx.font = `700 ${fontSize}px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`;
            const textW = ctx.measureText(this.options.twapAvgLabel).width;
            const padX = 8 * hpr;
            const pillW = textW + padX * 2;
            const pillH = 20 * vpr;
            const pillX = Math.max(
              8 * hpr,
              Math.min(x0 - pillW - 8 * hpr, bitmapW - pillW - 8 * hpr)
            );
            const pillY = Math.max(
              4 * vpr,
              Math.min(bitmapH - pillH - 4 * vpr, yAvg - pillH / 2)
            );

            drawRoundedRect(ctx, pillX, pillY, pillW, pillH, pillH / 2);
            ctx.fillStyle = "#1e190e";
            ctx.fill();
            ctx.strokeStyle = "rgba(230, 186, 92, 0.35)";
            ctx.lineWidth = Math.max(1, hpr);
            ctx.stroke();

            ctx.fillStyle = GOLD;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(
              this.options.twapAvgLabel,
              pillX + pillW / 2,
              pillY + pillH / 2 + 0.5 * vpr
            );
          }
          ctx.restore();
        }
      }

      // 2. Multi-position vertical profit-zone bars on the right side (offset left of scrubber)
      const positions = this.options.positions ?? [];
      if (positions.length > 0) {
        const barW = 4;
        const barGap = 3;
        const blockW = positions.length * (barW + barGap) - barGap;
        const rightReserve = this.options.hasScrubber ? 36 : 10;
        const startXCss = Math.max(8, cssW - rightReserve - blockW);

        ctx.save();
        for (let i = 0; i < positions.length; i++) {
          const p = positions[i];
          const yUpper = this.series.priceToCoordinate(p.upperPrice);
          const yLower = this.series.priceToCoordinate(p.lowerPrice);
          if (yUpper === null || yLower === null) continue;

          const top = Math.min(yUpper, yLower) * vpr;
          const bottom = Math.max(yUpper, yLower) * vpr;
          const barH = Math.max(8 * vpr, bottom - top);
          const x = (startXCss + i * (barW + barGap)) * hpr;
          const w = barW * hpr;

          const isSelected = Boolean(
            p.selected ||
              (this.options.selectedPositionId &&
                p.id === this.options.selectedPositionId)
          );
          const hasSelection = Boolean(
            this.options.selectedPositionId ||
              positions.some((item) => item.selected)
          );
          const col = p.direction === "BEAR" ? DOWN_CORAL : UP_GREEN;

          ctx.globalAlpha = isSelected ? 1 : hasSelection ? 0.34 : 0.72;
          ctx.fillStyle = col;
          drawRoundedRect(ctx, x, top, w, barH, 2 * hpr);
          ctx.fill();

          if (isSelected) {
            ctx.globalAlpha = 0.9;
            ctx.strokeStyle = "rgba(255, 255, 255, 0.55)";
            ctx.lineWidth = Math.max(1, 0.8 * hpr);
            ctx.stroke();
          }
        }
        ctx.restore();
      }

      // 2b. Left-aligned price-line pills (cap / breakeven / start) with vertical anti-overlap
      //     Kept on the left edge so they NEVER collide with the right-edge scrubber handle or price axis.
      const lineLabels = this.options.priceLineLabels ?? [];
      if (lineLabels.length > 0) {
        const cssH = bitmapH / vpr;
        const sorted = [...lineLabels].sort((a, b) => a.priority - b.priority);
        const placedYs: number[] = [];
        const pillHCss = 18;
        const maxPillWCss = Math.max(80, cssW - (this.options.hasScrubber ? 64 : 24));

        ctx.save();
        const fontSize = Math.round(10 * vpr);
        ctx.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, "SF Pro Display", "PingFang SC", sans-serif`;

        for (const lbl of sorted) {
          if (!Number.isFinite(lbl.price)) continue;
          const yCss = this.series.priceToCoordinate(lbl.price);
          if (yCss === null || yCss < 4 || yCss > cssH - 4) continue;

          const baseY = Math.max(4, Math.min(cssH - pillHCss - 4, yCss - pillHCss / 2));
          const candidates = [baseY, baseY + pillHCss + 2, baseY - pillHCss - 2];
          let chosenY: number | null = null;
          for (const cy of candidates) {
            if (cy < 4 || cy > cssH - pillHCss - 4) continue;
            if (!placedYs.some((py) => Math.abs(py - cy) < pillHCss + 2)) {
              chosenY = cy;
              break;
            }
          }
          if (chosenY === null) continue;
          placedYs.push(chosenY);

          const textW = ctx.measureText(lbl.text).width;
          const padX = 7 * hpr;
          const pillW = Math.min(maxPillWCss * hpr, textW + padX * 2);
          const pillH = pillHCss * vpr;
          const pillX = 8 * hpr;
          const pillY = chosenY * vpr;

          drawRoundedRect(ctx, pillX, pillY, pillW, pillH, pillH / 2);
          ctx.fillStyle = "rgba(8, 10, 12, 0.86)";
          ctx.fill();
          ctx.strokeStyle = lbl.borderColor ?? "rgba(255, 255, 255, 0.12)";
          ctx.lineWidth = Math.max(1, 0.8 * hpr);
          ctx.stroke();

          ctx.fillStyle = lbl.color;
          ctx.textAlign = "left";
          ctx.textBaseline = "middle";
          ctx.fillText(
            lbl.text,
            pillX + padX,
            pillY + pillH / 2 + 0.5 * vpr,
            pillW - padX * 2
          );
        }
        ctx.restore();
      }

      // 3. Buy-point entry markers
      const markers = this.options.entryMarkers ?? [];
      if (markers.length > 0) {
        ctx.save();
        for (const m of markers) {
          const xCss = this.chart
            .timeScale()
            .timeToCoordinate(m.time as Time);
          const yCss = this.series.priceToCoordinate(m.price);
          if (xCss === null || yCss === null) continue;
          if (xCss < 4 || xCss > cssW - 4) continue;

          const cx = xCss * hpr;
          const cy = yCss * vpr;
          const col = m.direction === "BEAR" ? DOWN_CORAL : UP_GREEN;
          const isSelected = Boolean(
            m.selected ||
              (this.options.selectedPositionId &&
                m.id === this.options.selectedPositionId)
          );

          if (isSelected) {
            ctx.beginPath();
            ctx.arc(cx, cy, 8 * hpr, 0, Math.PI * 2);
            ctx.fillStyle =
              m.direction === "BEAR"
                ? "rgba(232, 93, 74, 0.22)"
                : "rgba(46, 194, 107, 0.22)";
            ctx.fill();
          }

          ctx.beginPath();
          ctx.arc(cx, cy, 4 * hpr, 0, Math.PI * 2);
          ctx.fillStyle = "#000000";
          ctx.fill();
          ctx.lineWidth = 2 * hpr;
          ctx.strokeStyle = col;
          ctx.stroke();

          if (m.label) {
            const fontSize = Math.round(9.5 * vpr);
            ctx.font = `700 ${fontSize}px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`;
            const tw = ctx.measureText(m.label).width;
            const pw = tw + 12 * hpr;
            const ph = 17 * vpr;
            const px = Math.max(
              6 * hpr,
              Math.min(bitmapW - pw - 6 * hpr, cx - pw / 2)
            );
            const py = Math.max(4 * vpr, cy - ph - 8 * vpr);

            drawRoundedRect(ctx, px, py, pw, ph, ph / 2);
            ctx.fillStyle = "#181c20";
            ctx.fill();
            ctx.strokeStyle = "rgba(255, 255, 255, 0.10)";
            ctx.lineWidth = Math.max(1, 0.8 * hpr);
            ctx.stroke();

            ctx.fillStyle = col;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(m.label, px + pw / 2, py + ph / 2 + 0.5 * vpr);
          }
        }
        ctx.restore();
      }

      // 4. Interactive scrub horizontal dashed white line
      if (
        this.options.scrubPrice !== null &&
        this.options.scrubPrice !== undefined &&
        Number.isFinite(this.options.scrubPrice)
      ) {
        const yScrubCss = this.series.priceToCoordinate(
          this.options.scrubPrice
        );
        if (yScrubCss !== null) {
          const y = Math.round(yScrubCss * vpr) + 0.5;
          ctx.save();
          ctx.strokeStyle = "rgba(255, 255, 255, 0.45)";
          ctx.lineWidth = Math.max(1, Math.round(1 * vpr));
          ctx.setLineDash([3 * hpr, 3 * hpr]);
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(bitmapW, y);
          ctx.stroke();
          ctx.restore();
        }
      }
    });
  }
}

class SpreadRangeBackgroundView implements IPrimitivePaneView {
  constructor(
    private chart: IChartApiBase<Time>,
    private series: ISeriesApi<SeriesType>,
    private options: SpreadRangeOptions
  ) {}

  zOrder(): PrimitivePaneViewZOrder {
    return "bottom";
  }

  renderer(): IPrimitivePaneRenderer {
    return new SpreadRangeBackgroundRenderer(
      this.chart,
      this.series,
      this.options
    );
  }
}

class SpreadRangeForegroundView implements IPrimitivePaneView {
  constructor(
    private chart: IChartApiBase<Time>,
    private series: ISeriesApi<SeriesType>,
    private options: SpreadRangeOptions
  ) {}

  zOrder(): PrimitivePaneViewZOrder {
    return "top";
  }

  renderer(): IPrimitivePaneRenderer {
    return new SpreadRangeForegroundRenderer(
      this.chart,
      this.series,
      this.options
    );
  }
}

export class SpreadRangePrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApiBase<Time> | null = null;
  private series: ISeriesApi<SeriesType> | null = null;
  private requestUpdate?: () => void;
  private options: SpreadRangeOptions;
  private views: IPrimitivePaneView[] = [];

  constructor(options: SpreadRangeOptions) {
    this.options = options;
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this.chart = param.chart;
    this.series = param.series;
    this.requestUpdate = param.requestUpdate;
    this.rebuildViews();
  }

  detached(): void {
    this.chart = null;
    this.series = null;
    this.requestUpdate = undefined;
    this.views = [];
  }

  updateAllViews(): void {
    this.rebuildViews();
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }

  applyOptions(next: Partial<SpreadRangeOptions>): void {
    this.options = { ...this.options, ...next };
    this.rebuildViews();
    this.requestUpdate?.();
  }

  private rebuildViews(): void {
    if (!this.chart || !this.series) {
      this.views = [];
      return;
    }
    this.views = [
      new SpreadRangeBackgroundView(this.chart, this.series, this.options),
      new SpreadRangeForegroundView(this.chart, this.series, this.options),
    ];
  }
}

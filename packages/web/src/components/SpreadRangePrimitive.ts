import type {
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from "lightweight-charts";

export interface SpreadRangeOptions {
  lowerPrice: number;
  upperPrice: number;
  fillColor: string;
  borderColor: string;
}

class SpreadRangeRenderer implements IPrimitivePaneRenderer {
  constructor(
    private series: ISeriesApi<SeriesType>,
    private options: SpreadRangeOptions
  ) {}

  draw(): void {
    // Drawn in background layer so candles stay crisp on top
  }

  drawBackground(target: Parameters<IPrimitivePaneRenderer["draw"]>[0]): void {
    target.useBitmapCoordinateSpace((scope) => {
      const yUpper = this.series.priceToCoordinate(this.options.upperPrice);
      const yLower = this.series.priceToCoordinate(this.options.lowerPrice);
      if (yUpper === null || yLower === null) return;

      const top = Math.min(yUpper, yLower) * scope.verticalPixelRatio;
      const bottom = Math.max(yUpper, yLower) * scope.verticalPixelRatio;
      const height = Math.max(1, bottom - top);

      const ctx = scope.context;
      ctx.save();
      ctx.fillStyle = this.options.fillColor;
      ctx.fillRect(0, top, scope.bitmapSize.width, height);
      ctx.restore();
    });
  }
}

class SpreadRangePaneView implements IPrimitivePaneView {
  constructor(
    private series: ISeriesApi<SeriesType>,
    private options: SpreadRangeOptions
  ) {}

  zOrder(): "bottom" {
    return "bottom";
  }

  renderer(): IPrimitivePaneRenderer {
    return new SpreadRangeRenderer(this.series, this.options);
  }
}

export class SpreadRangePrimitive implements ISeriesPrimitive<Time> {
  private series: ISeriesApi<SeriesType> | null = null;
  private requestUpdate?: () => void;
  private options: SpreadRangeOptions;
  private views: SpreadRangePaneView[] = [];

  constructor(options: SpreadRangeOptions) {
    this.options = options;
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this.series = param.series;
    this.requestUpdate = param.requestUpdate;
    this.views = [new SpreadRangePaneView(this.series, this.options)];
  }

  detached(): void {
    this.series = null;
    this.requestUpdate = undefined;
    this.views = [];
  }

  updateAllViews(): void {
    if (this.series) {
      this.views = [new SpreadRangePaneView(this.series, this.options)];
    }
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }

  applyOptions(next: Partial<SpreadRangeOptions>): void {
    this.options = { ...this.options, ...next };
    this.updateAllViews();
    this.requestUpdate?.();
  }
}

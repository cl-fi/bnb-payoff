import {
  ASSET_SPECS,
  SUPPORTED_UNDERLYINGS,
  bsOptionPrice,
  generateOccEquityStrikes,
  getAssetSettlementUtcHour,
  getNextUsEquityOptionExpiry,
  type AtlasFeedTelemetry,
  type CandleBar,
  type CandlePoint,
  type DataSourceStatus,
  type ExpiryBook,
  type ExpiryTenor,
  type MarketSnapshot,
  type OptionStrikeQuote,
  type UnderlyingSymbol,
} from "@payoff/shared";
import type { AtlasOracleService } from "./atlasOracle.js";
import type { RwaRiskService } from "./rwaRiskService.js";

const BINANCE_INTERVAL_MAP: Record<CandleBar, string> = {
  "5m": "5m",
  "15m": "15m",
  "1H": "1h",
  "4H": "4h",
  "1D": "1d",
};

const BAR_SECONDS: Record<CandleBar, number> = {
  "5m": 300,
  "15m": 900,
  "1H": 3600,
  "4H": 14400,
  "1D": 86400,
};

export type BinanceKlinesFetcher = (
  symbol: string,
  interval: string,
  limit: number
) => Promise<unknown[][]>;

function nextUtcHourTimestamp(
  fromSec: number,
  settlementUtcHour: number,
  daysAhead: number
): number {
  const daySec = 86400;
  const offset = settlementUtcHour * 3600;
  const currentDayIndex = Math.floor((fromSec - offset) / daySec);
  return (currentDayIndex + daysAhead) * daySec + offset;
}

function nextWeeklyFridayUtcHour(
  fromSec: number,
  settlementUtcHour: number
): number {
  for (let d = 3; d <= 9; d++) {
    const candidate = nextUtcHourTimestamp(fromSec, settlementUtcHour, d);
    if (new Date(candidate * 1000).getUTCDay() === 5) {
      return candidate;
    }
  }
  return nextUtcHourTimestamp(fromSec, settlementUtcHour, 5);
}

function formatInstDate(expirySec: number): string {
  const d = new Date(expirySec * 1000);
  const yy = String(d.getUTCFullYear()).slice(-2);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

export function buildSyntheticStrikeQuote(params: {
  underlying: UnderlyingSymbol;
  expirySec: number;
  strike: number;
  spot: number;
  iv: number;
  hoursToExpiry: number;
}): OptionStrikeQuote {
  const { underlying, expirySec, strike, spot, iv, hoursToExpiry } = params;
  const T = Math.max(hoursToExpiry, 1) / (365 * 24);
  const cFair = bsOptionPrice(true, spot, strike, T, iv);
  const pFair = bsOptionPrice(false, spot, strike, T, iv);

  // Realistic reference spread: ITM legs have wider spreads than OTM legs,
  // naturally showcasing Put-Call Parity hedge route selection.
  const callIsItm = spot > strike;
  const putIsItm = spot < strike;

  const isEquity = ASSET_SPECS[underlying].assetClass === "RWA_EQUITY";
  const minBid = isEquity ? 0.01 : 0.5;
  const minAsk = isEquity ? 0.02 : 1.0;

  const baseSpread =
    underlying === "BTC"
      ? spot * 0.00028
      : isEquity
        ? Math.max(0.01, spot * 0.0004)
        : spot * 0.00035;
  const callHalfSpread = callIsItm ? baseSpread * 2.4 : baseSpread * 0.65;
  const putHalfSpread = putIsItm ? baseSpread * 2.4 : baseSpread * 0.65;

  const callBid = Math.max(minBid, cFair - callHalfSpread);
  const callAsk = Math.max(minAsk, callBid + minBid, cFair + callHalfSpread);
  const putBid = Math.max(minBid, pFair - putHalfSpread);
  const putAsk = Math.max(minAsk, putBid + minBid, pFair + putHalfSpread);

  const instIdPrefix = `${underlying}-USD-${formatInstDate(expirySec)}-${strike}`;

  return {
    strike,
    call: {
      strike,
      instId: `${instIdPrefix}-C`,
      bidUsd: callBid,
      askUsd: callAsk,
      markUsd: cFair,
      iv,
      bidSize: 40,
      askSize: 40,
    },
    put: {
      strike,
      instId: `${instIdPrefix}-P`,
      bidUsd: putBid,
      askUsd: putAsk,
      markUsd: pFair,
      iv,
      bidSize: 40,
      askSize: 40,
    },
  };
}

function generateGridStrikes(
  underlying: UnderlyingSymbol,
  spot: number
): number[] {
  if (ASSET_SPECS[underlying].assetClass === "RWA_EQUITY") {
    return generateOccEquityStrikes(spot, 0.3);
  }
  const step = ASSET_SPECS[underlying].defaultDailyStep;
  const center = Math.round(spot / step) * step;
  const halfSteps = Math.min(
    60,
    Math.max(16, Math.ceil((spot * 0.3) / step))
  );
  const strikes: number[] = [];
  for (let i = -halfSteps; i <= halfSteps; i++) {
    const k = center + i * step;
    if (k > 0) strikes.push(k);
  }
  return strikes;
}

async function fetchJson<T>(url: string, timeoutMs = 6500): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "PayoffProtocol/1.0" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Anchors the latest candlestick's `close` (and extends `high`/`low`) to live Atlas spot
 * so chart display and cryptographic settlement price remain 100% unified.
 */
export function anchorCandlesToSpot(
  candles: CandlePoint[],
  spot: number
): CandlePoint[] {
  if (candles.length === 0 || !Number.isFinite(spot) || spot <= 0) {
    return candles;
  }
  const cloned = candles.map((c) => ({ ...c }));
  const last = cloned[cloned.length - 1]!;
  const roundedSpot = Number(spot.toFixed(2));
  last.close = roundedSpot;
  if (roundedSpot > last.high) last.high = roundedSpot;
  if (roundedSpot < last.low) last.low = roundedSpot;
  return cloned;
}

export class MarketDataService {
  private snapshots = new Map<UnderlyingSymbol, MarketSnapshot>();
  private candleCache = new Map<
    string,
    { fetchedAt: number; candles: CandlePoint[]; source: "BINANCE_KLINES" | "SYNTHETIC" }
  >();
  private timer?: NodeJS.Timeout;
  private effectiveNowFn: () => number;
  private enableLiveAtlas: boolean;
  private enableBinanceKlines: boolean;
  private pollIntervalMs: number;
  private nvdabSettlementUtcHour: number;
  private binanceKlinesFetcher?: BinanceKlinesFetcher;
  private rwaRisk?: RwaRiskService;

  constructor(
    private atlasOracle: AtlasOracleService,
    opts: {
      enableLiveAtlas: boolean;
      enableBinanceKlines: boolean;
      pollIntervalMs: number;
      nvdabSettlementUtcHour?: number;
      effectiveNowFn?: () => number;
      binanceKlinesFetcher?: BinanceKlinesFetcher;
      rwaRisk?: RwaRiskService;
    }
  ) {
    this.enableLiveAtlas = opts.enableLiveAtlas;
    this.enableBinanceKlines = opts.enableBinanceKlines;
    this.pollIntervalMs = opts.pollIntervalMs;
    this.nvdabSettlementUtcHour =
      opts.nvdabSettlementUtcHour ?? ASSET_SPECS.NVDAB.settlementUtcHour;
    this.effectiveNowFn =
      opts.effectiveNowFn ?? (() => Math.floor(Date.now() / 1000));
    this.binanceKlinesFetcher = opts.binanceKlinesFetcher;
    this.rwaRisk = opts.rwaRisk;

    for (const u of SUPPORTED_UNDERLYINGS) {
      this.snapshots.set(u, this.buildSyntheticSnapshot(u));
    }
  }

  setRwaRisk(rwaRisk?: RwaRiskService) {
    this.rwaRisk = rwaRisk;
  }

  setBinanceKlinesFetcher(fetcher?: BinanceKlinesFetcher) {
    this.binanceKlinesFetcher = fetcher;
    this.candleCache.clear();
  }

  /** Called when Atlas WebSocket or HTTP updates telemetry for an asset. */
  handleAtlasTelemetryUpdate(telemetry: AtlasFeedTelemetry) {
    const sym = telemetry.underlying;
    const isLive = this.atlasOracle.isLiveDataAvailable(sym);
    const dataSource: DataSourceStatus = isLive
      ? "LIVE_ATLAS"
      : "SYNTHETIC_FALLBACK";
    const change24hPct = this.atlasOracle.get24hChangePct(sym);
    const iv = this.deriveEffectiveIv(sym, telemetry);
    const snap = this.buildSyntheticSnapshot(
      sym,
      telemetry.price,
      change24hPct,
      iv,
      dataSource,
      telemetry
    );
    this.snapshots.set(sym, snap);
  }

  private deriveEffectiveIv(
    underlying: UnderlyingSymbol,
    _telemetry?: AtlasFeedTelemetry,
    tenor: ExpiryTenor = "DAILY"
  ): number {
    // Keep baseline IV clean here; Atlas `priceVolatility` & `ConsensusScore` / RWA session
    // IV floor boosts are applied solely inside `@payoff/mock-maker` (`ShelfEngine`) to avoid double-counting.
    if (underlying === "NVDAB" && this.rwaRisk) {
      return this.rwaRisk.getEffectiveAtmIv(tenor);
    }
    return ASSET_SPECS[underlying].defaultIv;
  }

  start() {
    void this.refreshAll();
    this.timer = setInterval(() => {
      void this.refreshAll();
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  getSnapshot(underlying: UnderlyingSymbol): MarketSnapshot {
    const current = this.snapshots.get(underlying);
    const effNow = this.effectiveNowFn();
    const latestTelemetry = this.atlasOracle.getTelemetry(underlying);
    const live = this.atlasOracle.isLiveDataAvailable(underlying);

    if (!current || !current.daily || current.daily.expiry <= effNow + 3600) {
      const spot = live
        ? latestTelemetry.price
        : current?.spot ?? ASSET_SPECS[underlying].defaultSpot;
      const dataSource: DataSourceStatus = live
        ? "LIVE_ATLAS"
        : current?.dataSource ?? "SYNTHETIC_FALLBACK";
      const rebuilt = this.buildSyntheticSnapshot(
        underlying,
        spot,
        live
          ? this.atlasOracle.get24hChangePct(underlying)
          : current?.change24hPct ?? 0,
        this.deriveEffectiveIv(underlying, latestTelemetry),
        dataSource,
        latestTelemetry
      );
      this.snapshots.set(underlying, rebuilt);
      return rebuilt;
    }

    if (underlying === "NVDAB" && this.rwaRisk) {
      const dailyRwa = current.daily
        ? this.rwaRisk.getTelemetry("NVDAB", {
            expiry: current.daily.expiry,
            nowSec: effNow,
          })
        : undefined;
      const weeklyRwa = current.weekly
        ? this.rwaRisk.getTelemetry("NVDAB", {
            expiry: current.weekly.expiry,
            nowSec: effNow,
          })
        : undefined;
      return {
        ...current,
        atlasTelemetry: latestTelemetry,
        rwaTelemetry: dailyRwa,
        daily: current.daily
          ? { ...current.daily, rwaTelemetry: dailyRwa }
          : undefined,
        weekly: current.weekly
          ? { ...current.weekly, rwaTelemetry: weeklyRwa }
          : undefined,
      };
    }

    return {
      ...current,
      atlasTelemetry: latestTelemetry,
    };
  }

  getExpiryBook(underlying: UnderlyingSymbol, tenor: ExpiryTenor): ExpiryBook {
    const snap = this.getSnapshot(underlying);
    const book = tenor === "DAILY" ? snap.daily : snap.weekly;
    if (book) return book;
    return snap.daily!;
  }

  async getCandles(
    underlying: UnderlyingSymbol,
    bar: CandleBar = "15m",
    limit = 120
  ): Promise<CandlePoint[]> {
    const res = await this.getCandlesWithSource(underlying, bar, limit);
    return res.candles;
  }

  async getCandlesWithSource(
    underlying: UnderlyingSymbol,
    bar: CandleBar = "15m",
    limit = 120
  ): Promise<{ candles: CandlePoint[]; source: "BINANCE_KLINES" | "SYNTHETIC" }> {
    const snap = this.getSnapshot(underlying);
    const isRwaEquity = ASSET_SPECS[underlying].assetClass === "RWA_EQUITY";
    const shareMultiplier = isRwaEquity
      ? this.rwaRisk?.getShareMultiplier() ?? 1.0
      : 1.0;
    const key = `${underlying}-${bar}-${limit}-${shareMultiplier.toFixed(6)}`;
    const cached = this.candleCache.get(key);
    if (cached && Date.now() - cached.fetchedAt < 10_000) {
      return {
        candles: anchorCandlesToSpot(cached.candles, snap.spot),
        source: cached.source,
      };
    }

    if (this.enableBinanceKlines || this.binanceKlinesFetcher) {
      try {
        const interval = BINANCE_INTERVAL_MAP[bar] || "15m";
        const symbol = ASSET_SPECS[underlying].binanceSpotSymbol;
        const rawRows = this.binanceKlinesFetcher
          ? await this.binanceKlinesFetcher(symbol, interval, limit)
          : await fetchJson<unknown[][]>(
              `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
            );

        // For RWA bStocks (e.g. NVDABUSDT), Binance spot bars are 1-share prices;
        // scale OHLC by live Atlas shareMultiplier BEFORE anchoring to Atlas #1005 1-token spot.
        const scalePrice = (raw: unknown): number => {
          const v = Number(raw);
          if (!Number.isFinite(v)) return v;
          return isRwaEquity
            ? Number((v * shareMultiplier).toFixed(4))
            : v;
        };

        const rows: CandlePoint[] = (rawRows || [])
          .map((row) => ({
            time: Math.floor(Number(row[0]) / 1000),
            open: scalePrice(row[1]),
            high: scalePrice(row[2]),
            low: scalePrice(row[3]),
            close: scalePrice(row[4]),
          }))
          .filter(
            (c) =>
              Number.isFinite(c.time) &&
              Number.isFinite(c.open) &&
              Number.isFinite(c.high) &&
              Number.isFinite(c.low) &&
              Number.isFinite(c.close) &&
              c.close > 0
          )
          .sort((a, b) => a.time - b.time);

        if (rows.length > 0) {
          const anchored = anchorCandlesToSpot(rows, snap.spot);
          this.candleCache.set(key, {
            fetchedAt: Date.now(),
            candles: anchored,
            source: "BINANCE_KLINES",
          });
          return { candles: anchored, source: "BINANCE_KLINES" };
        }
      } catch {
        // fall through to smooth synthetic fallback candles anchored to Atlas spot
      }
    }

    const step = BAR_SECONDS[bar] || 900;
    const nowBucket = Math.floor(Date.now() / 1000 / step) * step;
    const candles: CandlePoint[] = [];
    let price = snap.spot * 0.985;
    for (let i = limit - 1; i >= 0; i--) {
      const t = nowBucket - i * step;
      const drift = (snap.spot - price) / Math.max(1, i + 1);
      const wave = Math.sin(i * 0.45) * snap.spot * 0.0025;
      const open = price;
      const close = i === 0 ? snap.spot : Math.max(1, open + drift + wave);
      const high = Math.max(open, close) * (1 + 0.0018);
      const low = Math.min(open, close) * (1 - 0.0018);
      candles.push({
        time: t,
        open: Number(open.toFixed(2)),
        high: Number(high.toFixed(2)),
        low: Number(low.toFixed(2)),
        close: Number(close.toFixed(2)),
      });
      price = close;
    }
    const anchored = anchorCandlesToSpot(candles, snap.spot);
    this.candleCache.set(key, {
      fetchedAt: Date.now(),
      candles: anchored,
      source: "SYNTHETIC",
    });
    return { candles: anchored, source: "SYNTHETIC" };
  }

  async refreshAll(): Promise<void> {
    if (this.enableLiveAtlas && !this.atlasOracle.isWsConnected()) {
      await this.atlasOracle.refreshLatest();
    }
    await Promise.all(SUPPORTED_UNDERLYINGS.map((u) => this.refreshOne(u)));
  }

  async refreshOne(underlying: UnderlyingSymbol): Promise<MarketSnapshot> {
    const telemetry = this.atlasOracle.getTelemetry(underlying);
    const live = this.atlasOracle.isLiveDataAvailable(underlying);

    const prev = this.snapshots.get(underlying);
    const spot = live
      ? telemetry.price
      : prev?.spot ?? ASSET_SPECS[underlying].defaultSpot;
    const change24hPct = live
      ? this.atlasOracle.get24hChangePct(underlying)
      : prev?.change24hPct ?? 0;
    const dataSource: DataSourceStatus = live
      ? "LIVE_ATLAS"
      : "SYNTHETIC_FALLBACK";
    const iv = this.deriveEffectiveIv(underlying, telemetry);

    const snap = this.buildSyntheticSnapshot(
      underlying,
      spot,
      change24hPct,
      iv,
      dataSource,
      telemetry
    );
    this.snapshots.set(underlying, snap);
    return snap;
  }

  private resolveStrikesForTenor(
    underlying: UnderlyingSymbol,
    spot: number,
    tenor: ExpiryTenor
  ): number[] {
    if (underlying === "NVDAB" && this.rwaRisk) {
      const thetaStrikes = this.rwaRisk.getThetaStrikes(tenor);
      if (thetaStrikes && thetaStrikes.length >= 8) {
        const sorted = [...new Set(thetaStrikes)]
          .filter((k) => Number.isFinite(k) && k > 0)
          .sort((a, b) => a - b);
        const minK = sorted[0]!;
        const maxK = sorted[sorted.length - 1]!;
        // Use live ThetaData strikes when they span around live Atlas spot
        if (minK <= spot * 0.92 && maxK >= spot * 1.08) {
          return sorted;
        }
      }
    }
    return generateGridStrikes(underlying, spot);
  }

  buildSyntheticSnapshot(
    underlying: UnderlyingSymbol,
    spot = ASSET_SPECS[underlying].defaultSpot,
    change24hPct = 1.4,
    iv = ASSET_SPECS[underlying].defaultIv,
    dataSource: DataSourceStatus = "SYNTHETIC_FALLBACK",
    atlasTelemetry?: AtlasFeedTelemetry
  ): MarketSnapshot {
    const effNow = this.effectiveNowFn();
    const spec = ASSET_SPECS[underlying];
    let dailyExpiry: number;
    let weeklyExpiry: number;

    if (spec.expiryCadence === "US_EQUITY_MWF") {
      const settlementHour =
        this.rwaRisk?.getSettlementUtcHour() ?? this.nvdabSettlementUtcHour;
      const listedDates = this.rwaRisk?.getThetaListedExpirations();
      dailyExpiry = getNextUsEquityOptionExpiry(
        effNow,
        "DAILY",
        settlementHour,
        listedDates
      );
      weeklyExpiry = getNextUsEquityOptionExpiry(
        effNow,
        "WEEKLY",
        settlementHour,
        listedDates
      );
      void this.rwaRisk?.observeExpiry(dailyExpiry);
      void this.rwaRisk?.observeExpiry(weeklyExpiry);
    } else {
      const settlementHour = getAssetSettlementUtcHour(underlying);
      const dailyExp = nextUtcHourTimestamp(effNow, settlementHour, 1);
      dailyExpiry =
        dailyExp - effNow >= 8 * 3600
          ? dailyExp
          : nextUtcHourTimestamp(effNow, settlementHour, 2);
      weeklyExpiry = nextWeeklyFridayUtcHour(effNow, settlementHour);
    }

    const makeBook = (tenor: ExpiryTenor, expirySec: number): ExpiryBook => {
      const hoursToExpiry = Math.max(4, (expirySec - effNow) / 3600);
      const strikes = this.resolveStrikesForTenor(underlying, spot, tenor);
      const bookAtmIv =
        underlying === "NVDAB" && this.rwaRisk
          ? this.rwaRisk.getEffectiveAtmIv(tenor)
          : iv;
      const syntheticStrikes: Record<number, OptionStrikeQuote> = {};
      for (const k of strikes) {
        const strikeIv =
          underlying === "NVDAB" && this.rwaRisk
            ? this.rwaRisk.resolveStrikeIv(k, spot, tenor)
            : bookAtmIv;
        syntheticStrikes[k] = buildSyntheticStrikeQuote({
          underlying,
          expirySec,
          strike: k,
          spot,
          iv: strikeIv,
          hoursToExpiry,
        });
      }
      const rwaTelemetry =
        underlying === "NVDAB"
          ? this.rwaRisk?.getTelemetry("NVDAB", {
              expiry: expirySec,
              nowSec: effNow,
            })
          : undefined;
      return {
        underlying,
        tenor,
        expiry: expirySec,
        expiryIso: new Date(expirySec * 1000).toISOString(),
        hoursToExpiry: Number(hoursToExpiry.toFixed(1)),
        spot,
        atmIv: Number(bookAtmIv.toFixed(4)),
        availableStrikes: strikes,
        syntheticStrikes,
        ...(rwaTelemetry ? { rwaTelemetry } : {}),
      };
    };

    const daily = makeBook("DAILY", dailyExpiry);
    const weekly = makeBook("WEEKLY", weeklyExpiry);

    return {
      underlying,
      spot: Number(spot.toFixed(2)),
      change24hPct: Number(change24hPct.toFixed(2)),
      dataSource,
      updatedAt: Math.floor(Date.now() / 1000),
      atlasTelemetry: atlasTelemetry ?? this.atlasOracle.getTelemetry(underlying),
      ...(daily.rwaTelemetry ? { rwaTelemetry: daily.rwaTelemetry } : {}),
      daily,
      weekly,
    };
  }
}

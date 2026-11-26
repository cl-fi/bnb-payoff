import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { promisify } from "util";
import {
  ASSET_SPECS,
  getNextUsEquityOptionExpiry,
  isUsEquityMarketHoliday,
  type ExpiryTenor,
  type RwaAssetTelemetry,
  type RwaIvSource,
  type RwaMarketSession,
  type UnderlyingSymbol,
} from "@payoff/shared";
import type { ServerConfig } from "../config.js";
import type { PayoffDatabase } from "../db/database.js";
import type { AtlasOracleService } from "./atlasOracle.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ATLAS_FEED_DETAIL_URL =
  "https://api.atlasoracle.io/oracle/user/v1/oracle-feed/feed-detail";
export const BINANCE_FAPI_TICKER_PRICE_URL =
  "https://fapi.binance.com/fapi/v1/ticker/price";
export const THETADATA_SYNC_STATE_KEY = "thetadata_nvda_chain_snapshot";
export const MULTIPLIER_SYNC_STATE_PREFIX = "nvdab_open_multiplier:";
export const SPLIT_PAUSED_SYNC_STATE_PREFIX = "nvdab_split_paused:";

const SPLIT_GUARD_DRIFT_THRESHOLD = 0.01; // > 1.0% shareMultiplier drift

export interface AtlasFeedDetailSourceMarket {
  exchangeName?: string;
  dataSourceName?: string;
  selected?: number | boolean;
  exclude?: number | boolean;
  status?: number;
  volumeUsd?: number | string;
  quote?: number | string;
  shareMultiplier?: number | string | null;
}

export interface AtlasFeedDetailResponse {
  data?: {
    id?: number | string;
    symbol?: string;
    price?: number | string;
    sourceMarkets?: AtlasFeedDetailSourceMarket[];
  };
  sourceMarkets?: AtlasFeedDetailSourceMarket[];
}

export interface BinancePerpPriceResponse {
  symbol?: string;
  price: string | number;
  time?: number;
}

export interface ThetaDataChainSnapshot {
  symbol?: string;
  expirations: string[];
  nearestExp: string | null;
  weeklyExp: string | null;
  strikes: number[];
  atmIv: number | null;
  strikeIvs: Record<string, number>;
  weeklyStrikes?: number[];
  weeklyAtmIv?: number | null;
  weeklyStrikeIvs?: Record<string, number>;
  syntheticForward?: number | null;
  weeklySyntheticForward?: number | null;
  fetchedAtMs: number;
}

export type AtlasFeedDetailFetcher = (
  feedId: number
) => Promise<AtlasFeedDetailResponse>;

export type BinancePerpFetcher = (
  symbol: string
) => Promise<BinancePerpPriceResponse>;

export type ThetaDataFetcher = () => Promise<ThetaDataChainSnapshot | null>;

export interface RwaRiskServiceOptions {
  effectiveNowFn?: () => number;
  atlasFeedDetailFetcher?: AtlasFeedDetailFetcher;
  binancePerpFetcher?: BinancePerpFetcher;
  thetaDataFetcher?: ThetaDataFetcher;
  thetaScriptPath?: string;
  onStateChange?: () => void;
}

/**
 * DST-aware US equity market session classifier using America/New_York timezone:
 * - `RTH`: Mon–Fri 09:30–16:00 ET (excluding full-day NYSE/NASDAQ holidays)
 * - `WEEKEND`: Fri 20:00 ET – Sun 18:00 ET
 * - `EXTENDED`: Pre-market / after-hours weekdays, Sun >= 18:00 ET, and US weekday holidays
 */
export function classifyUsEquitySession(
  nowDate: Date = new Date()
): RwaMarketSession {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(nowDate);

  const getPart = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? "";

  const weekday = getPart("weekday");
  const year = Number(getPart("year"));
  const month = Number(getPart("month"));
  const day = Number(getPart("day"));
  const hour = Number(getPart("hour")) % 24;
  const minute = Number(getPart("minute"));
  const mins = hour * 60 + minute;

  if (weekday === "Sat") return "WEEKEND";
  if (weekday === "Sun") {
    return mins < 18 * 60 ? "WEEKEND" : "EXTENDED";
  }
  if (weekday === "Fri" && mins >= 20 * 60) {
    return "WEEKEND";
  }

  const etCalendarUtc = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
  if (isUsEquityMarketHoliday(etCalendarUtc)) {
    return "EXTENDED";
  }

  if (mins >= 9 * 60 + 30 && mins < 16 * 60) {
    return "RTH";
  }
  return "EXTENDED";
}

function formatUtcYmdFromSec(sec: number): string {
  const d = new Date(sec * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function toPositiveFinite(val: unknown): number | null {
  if (val === null || val === undefined || val === "") return null;
  const n = Number(val);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function resolveDefaultThetaScriptPath(): string {
  const candidates = [
    path.resolve(__dirname, "../../../../scripts/fetch-thetadata-iv.py"),
    path.resolve(process.cwd(), "scripts/fetch-thetadata-iv.py"),
    path.resolve(process.cwd(), "../../scripts/fetch-thetadata-iv.py"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[0]!;
}

async function fetchJsonWithTimeout<T>(
  url: string,
  init: RequestInit,
  timeoutMs = 7000
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export class RwaRiskService {
  private readonly feedIdNum: number;
  private readonly perpSymbol: string;
  private readonly settlementUtcHour: number;
  private readonly effectiveNowFn: () => number;
  private readonly thetaScriptPath: string;
  private readonly onStateChange?: () => void;

  private atlasFeedDetailFetcher?: AtlasFeedDetailFetcher;
  private binancePerpFetcher?: BinancePerpFetcher;
  private thetaDataFetcher?: ThetaDataFetcher;

  private blackoutDates: string[];

  private shareMultiplier = 1.0;
  private hasLiveMultiplier = false;
  private defaultBaselineShareMultiplier = 1.0;
  private crossVenueMultiplierGapPct = 0;
  private multiplierUpdatedAtMs = 0;
  private expiryBaselines = new Map<number, number>();
  private observedExpiries = new Set<number>();

  private perpPriceUsd: number | null = null;
  private perpUpdatedAtMs = 0;

  private thetaSnapshot: ThetaDataChainSnapshot | null = null;
  private ivSource: RwaIvSource = "SYNTHETIC_BASELINE";
  private lastThetaLiveFetchMs = 0;
  private thetaFetchInFlight = false;

  private multiplierTimer?: NodeJS.Timeout;
  private perpTimer?: NodeJS.Timeout;
  private thetaTimer?: NodeJS.Timeout;
  private stopped = true;

  constructor(
    private config: ServerConfig,
    private db: PayoffDatabase,
    private atlasOracle: AtlasOracleService,
    opts: RwaRiskServiceOptions = {}
  ) {
    const parsedFeedId = Number(config.atlasNvdabFeedId || "1005");
    this.feedIdNum =
      Number.isInteger(parsedFeedId) && parsedFeedId > 0 ? parsedFeedId : 1005;
    this.perpSymbol = ASSET_SPECS.NVDAB.binancePerpSymbol ?? "NVDAUSDT";
    this.settlementUtcHour = config.nvdabSettlementUtcHour;
    this.effectiveNowFn =
      opts.effectiveNowFn ?? (() => Math.floor(Date.now() / 1000));
    this.atlasFeedDetailFetcher = opts.atlasFeedDetailFetcher;
    this.binancePerpFetcher = opts.binancePerpFetcher;
    this.thetaDataFetcher = opts.thetaDataFetcher;
    this.thetaScriptPath =
      opts.thetaScriptPath ?? resolveDefaultThetaScriptPath();
    this.onStateChange = opts.onStateChange;
    this.blackoutDates = [...(config.nvdabBlackoutDates || [])];
  }

  /** Hydrates persisted ThetaData cache from sync_state (zero network calls). */
  async init(): Promise<void> {
    try {
      const cachedRaw = await this.db.getSyncState(THETADATA_SYNC_STATE_KEY);
      if (cachedRaw) {
        const parsed = JSON.parse(cachedRaw) as ThetaDataChainSnapshot;
        if (parsed && Array.isArray(parsed.expirations)) {
          this.thetaSnapshot = parsed;
          this.ivSource = "THETADATA_CACHED";
        }
      }
    } catch {
      // ignore corrupted cache; fall back cleanly to synthetic baseline
    }
  }

  setAtlasFeedDetailFetcher(fetcher?: AtlasFeedDetailFetcher): void {
    this.atlasFeedDetailFetcher = fetcher;
  }

  setBinancePerpFetcher(fetcher?: BinancePerpFetcher): void {
    this.binancePerpFetcher = fetcher;
  }

  setThetaDataFetcher(fetcher?: ThetaDataFetcher): void {
    this.thetaDataFetcher = fetcher;
  }

  setBlackoutDates(dates: string[]): void {
    this.blackoutDates = dates
      .map((d) => d.trim())
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  }

  /** Test & local simulation helper for injecting a ThetaData chain snapshot cleanly. */
  async setThetaSnapshot(
    snapshot: ThetaDataChainSnapshot | null,
    source: RwaIvSource = snapshot ? "THETADATA_LIVE" : "SYNTHETIC_BASELINE"
  ): Promise<void> {
    this.thetaSnapshot = snapshot;
    this.ivSource = snapshot ? source : "SYNTHETIC_BASELINE";
    this.lastThetaLiveFetchMs =
      snapshot && source === "THETADATA_LIVE" ? Date.now() : 0;
    if (snapshot) {
      try {
        await this.db.setSyncState(
          THETADATA_SYNC_STATE_KEY,
          JSON.stringify(snapshot)
        );
      } catch {
        // non-fatal cache persist failure
      }
    }
    this.onStateChange?.();
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;

    if (
      !this.config.enableRwaFeeds &&
      !this.atlasFeedDetailFetcher &&
      !this.binancePerpFetcher &&
      !this.thetaDataFetcher
    ) {
      return;
    }

    void this.refreshShareMultiplier();
    void this.refreshPerpPrice();
    void this.refreshThetaDataIfDue(true);

    this.multiplierTimer = setInterval(() => {
      void this.refreshShareMultiplier();
    }, 60_000);
    this.multiplierTimer.unref?.();

    this.perpTimer = setInterval(() => {
      void this.refreshPerpPrice();
    }, 15_000);
    this.perpTimer.unref?.();

    // Check every 60s; internally gates to 60s during RTH vs 5m during off-hours
    this.thetaTimer = setInterval(() => {
      void this.refreshThetaDataIfDue(false);
    }, 60_000);
    this.thetaTimer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.multiplierTimer) {
      clearInterval(this.multiplierTimer);
      this.multiplierTimer = undefined;
    }
    if (this.perpTimer) {
      clearInterval(this.perpTimer);
      this.perpTimer = undefined;
    }
    if (this.thetaTimer) {
      clearInterval(this.thetaTimer);
      this.thetaTimer = undefined;
    }
  }

  getShareMultiplier(): number {
    return this.shareMultiplier > 0 ? this.shareMultiplier : 1.0;
  }

  getSettlementUtcHour(): number {
    return this.settlementUtcHour;
  }

  getThetaListedExpirations(): string[] | undefined {
    const exps = this.thetaSnapshot?.expirations;
    return exps && exps.length > 0 ? exps : undefined;
  }

  getThetaStrikes(tenor: ExpiryTenor = "DAILY"): number[] | undefined {
    if (!this.thetaSnapshot) return undefined;
    const raw =
      tenor === "WEEKLY" &&
      this.thetaSnapshot.weeklyStrikes &&
      this.thetaSnapshot.weeklyStrikes.length > 0
        ? this.thetaSnapshot.weeklyStrikes
        : this.thetaSnapshot.strikes;
    return raw && raw.length > 0 ? raw : undefined;
  }

  getEffectiveAtmIv(tenor: ExpiryTenor = "DAILY"): number {
    const fallback = ASSET_SPECS.NVDAB.defaultIv;
    if (!this.thetaSnapshot) return fallback;
    const raw =
      tenor === "WEEKLY"
        ? (this.thetaSnapshot.weeklyAtmIv ?? this.thetaSnapshot.atmIv)
        : this.thetaSnapshot.atmIv;
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0.05) {
      return Number(clamp(raw, 0.15, 2.0).toFixed(4));
    }
    return fallback;
  }

  /**
   * Maps ThetaData per-strike IV onto an Atlas `#1005` NVDAB strike via Sticky-Delta:
   *   `S_share = S_atlas / shareMultiplier`
   *   `K_share = K_nvdab / shareMultiplier`
   * When a ThetaData synthetic forward `F_theta` is available, preserves moneyness
   * (`K_lookup = (K_share / S_share) * F_theta`); otherwise interpolates directly at `K_share`.
   */
  resolveStrikeIv(
    strikeNvdab: number,
    spotAtlas: number,
    tenor: ExpiryTenor = "DAILY"
  ): number {
    const fallbackIv = this.getEffectiveAtmIv(tenor);
    if (!this.thetaSnapshot) return fallbackIv;

    const rawMap =
      tenor === "WEEKLY" &&
      this.thetaSnapshot.weeklyStrikeIvs &&
      Object.keys(this.thetaSnapshot.weeklyStrikeIvs).length > 0
        ? this.thetaSnapshot.weeklyStrikeIvs
        : this.thetaSnapshot.strikeIvs;

    if (!rawMap || Object.keys(rawMap).length === 0) {
      return fallbackIv;
    }

    const pairs: Array<[number, number]> = [];
    for (const [kStr, ivVal] of Object.entries(rawMap)) {
      const kNum = Number(kStr);
      const ivNum = Number(ivVal);
      if (
        Number.isFinite(kNum) &&
        kNum > 0 &&
        Number.isFinite(ivNum) &&
        ivNum > 0.05 &&
        ivNum < 3.0
      ) {
        pairs.push([kNum, ivNum]);
      }
    }
    if (pairs.length === 0) return fallbackIv;
    pairs.sort((a, b) => a[0] - b[0]);

    const mult = this.getShareMultiplier();
    const sShare = spotAtlas / mult;
    const kShare = strikeNvdab / mult;
    const synFwd =
      tenor === "WEEKLY"
        ? (this.thetaSnapshot.weeklySyntheticForward ??
          this.thetaSnapshot.syntheticForward)
        : this.thetaSnapshot.syntheticForward;

    const lookupK =
      typeof synFwd === "number" &&
      Number.isFinite(synFwd) &&
      synFwd > 0 &&
      sShare > 0
        ? (kShare / sShare) * synFwd
        : kShare;

    if (lookupK <= pairs[0]![0]) {
      return Number(clamp(pairs[0]![1], 0.15, 2.0).toFixed(4));
    }
    const last = pairs[pairs.length - 1]!;
    if (lookupK >= last[0]) {
      return Number(clamp(last[1], 0.15, 2.0).toFixed(4));
    }

    for (let i = 0; i < pairs.length - 1; i++) {
      const [k0, iv0] = pairs[i]!;
      const [k1, iv1] = pairs[i + 1]!;
      if (lookupK >= k0 && lookupK <= k1) {
        const span = k1 - k0;
        const w = span > 0 ? (lookupK - k0) / span : 0;
        const interp = iv0 + w * (iv1 - iv0);
        return Number(clamp(interp, 0.15, 2.0).toFixed(4));
      }
    }

    return fallbackIv;
  }

  /**
   * Registers an active `NVDAB` expiry so its baseline `shareMultiplier` is
   * loaded from or persisted to `sync_state` (`nvdab_open_multiplier:<expiry>`).
   */
  async observeExpiry(expiry: number): Promise<number> {
    if (!Number.isInteger(expiry) || expiry <= 0) {
      return this.defaultBaselineShareMultiplier;
    }
    this.observedExpiries.add(expiry);

    const existingMem = this.expiryBaselines.get(expiry);
    if (existingMem !== undefined) return existingMem;

    const key = `${MULTIPLIER_SYNC_STATE_PREFIX}${expiry}`;
    try {
      const saved = await this.db.getSyncState(key);
      const parsed = toPositiveFinite(saved);
      if (parsed !== null) {
        this.expiryBaselines.set(expiry, parsed);
        return parsed;
      }
    } catch {
      // fall through
    }

    if (this.hasLiveMultiplier) {
      const baseline = this.shareMultiplier;
      this.expiryBaselines.set(expiry, baseline);
      try {
        await this.db.setSyncState(key, String(baseline));
      } catch {
        // non-fatal persistence failure
      }
      return baseline;
    }

    return this.defaultBaselineShareMultiplier;
  }

  /**
   * Polls Atlas `feed-detail` for `NVDAB` (`id: 1005`), extracts Binance `shareMultiplier`
   * and max cross-venue multiplier divergence across active `sourceMarkets`, and persists
   * opening baselines for observed expiries in `sync_state`.
   */
  async refreshShareMultiplier(): Promise<boolean> {
    if (!this.config.enableRwaFeeds && !this.atlasFeedDetailFetcher) {
      return false;
    }

    try {
      const response = this.atlasFeedDetailFetcher
        ? await this.atlasFeedDetailFetcher(this.feedIdNum)
        : await fetchJsonWithTimeout<AtlasFeedDetailResponse>(
            ATLAS_FEED_DETAIL_URL,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "User-Agent": "PayoffProtocol/1.0",
              },
              body: JSON.stringify({ id: this.feedIdNum }),
            }
          );

      const markets =
        response?.data?.sourceMarkets ?? response?.sourceMarkets ?? [];
      const activeMarkets: Array<{
        name: string;
        volumeUsd: number;
        shareMultiplier: number;
      }> = [];

      for (const m of markets) {
        const excluded = m.exclude === 1 || m.exclude === true;
        const selected =
          m.selected === undefined || m.selected === 1 || m.selected === true;
        if (excluded || !selected) continue;
        const mult = toPositiveFinite(m.shareMultiplier);
        if (mult === null) continue;
        const name = String(m.exchangeName || m.dataSourceName || "").trim();
        const volumeUsd = Number(m.volumeUsd ?? 0);
        activeMarkets.push({
          name,
          volumeUsd: Number.isFinite(volumeUsd) ? volumeUsd : 0,
          shareMultiplier: mult,
        });
      }

      if (activeMarkets.length === 0) return false;

      const binanceMarket = activeMarkets.find((m) => /binance/i.test(m.name));
      const primary =
        binanceMarket ??
        [...activeMarkets].sort((a, b) => b.volumeUsd - a.volumeUsd)[0]!;

      let minMult = Infinity;
      let maxMult = -Infinity;
      for (const m of activeMarkets) {
        if (m.shareMultiplier < minMult) minMult = m.shareMultiplier;
        if (m.shareMultiplier > maxMult) maxMult = m.shareMultiplier;
      }
      const crossGapPct =
        activeMarkets.length >= 2 && minMult > 0
          ? Number((((maxMult - minMult) / minMult) * 100).toFixed(4))
          : 0;

      const wasFirstLive = !this.hasLiveMultiplier;
      this.shareMultiplier = primary.shareMultiplier;
      this.hasLiveMultiplier = true;
      this.crossVenueMultiplierGapPct = crossGapPct;
      this.multiplierUpdatedAtMs = Date.now();

      if (wasFirstLive) {
        this.defaultBaselineShareMultiplier = primary.shareMultiplier;
      }

      // Ensure currently active daily & weekly expiries have persisted opening baselines
      const effNow = this.effectiveNowFn();
      const listedDates = this.getThetaListedExpirations();
      const activeDaily = getNextUsEquityOptionExpiry(
        effNow,
        "DAILY",
        this.settlementUtcHour,
        listedDates
      );
      const activeWeekly = getNextUsEquityOptionExpiry(
        effNow,
        "WEEKLY",
        this.settlementUtcHour,
        listedDates
      );
      this.observedExpiries.add(activeDaily);
      this.observedExpiries.add(activeWeekly);

      for (const exp of this.observedExpiries) {
        if (!this.expiryBaselines.has(exp)) {
          const key = `${MULTIPLIER_SYNC_STATE_PREFIX}${exp}`;
          let savedVal: number | null = null;
          try {
            savedVal = toPositiveFinite(await this.db.getSyncState(key));
          } catch {
            savedVal = null;
          }
          if (savedVal !== null) {
            this.expiryBaselines.set(exp, savedVal);
          } else {
            this.expiryBaselines.set(exp, primary.shareMultiplier);
            try {
              await this.db.setSyncState(key, String(primary.shareMultiplier));
            } catch {
              // non-fatal persistence failure
            }
          }
        }
      }

      this.onStateChange?.();
      return true;
    } catch {
      return false;
    }
  }

  /** Polls Binance Futures `NVDAUSDT` perp mark/last ticker price every 15s. */
  async refreshPerpPrice(): Promise<boolean> {
    if (!this.config.enableRwaFeeds && !this.binancePerpFetcher) {
      return false;
    }

    try {
      const res = this.binancePerpFetcher
        ? await this.binancePerpFetcher(this.perpSymbol)
        : await fetchJsonWithTimeout<BinancePerpPriceResponse>(
            `${BINANCE_FAPI_TICKER_PRICE_URL}?symbol=${encodeURIComponent(this.perpSymbol)}`,
            {
              method: "GET",
              headers: { "User-Agent": "PayoffProtocol/1.0" },
            }
          );

      const px = toPositiveFinite(res?.price);
      if (px === null) return false;
      this.perpPriceUsd = Number(px.toFixed(4));
      this.perpUpdatedAtMs = Date.now();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Optional fail-soft ThetaData bridge:
   * - Refreshes every 60s during RTH and every 5m during EXTENDED/WEEKEND.
   * - Fails soft cleanly in Docker/CI without Python to cached snapshot or synthetic baseline (0.52).
   * - NEVER prints or logs THETADATA_API_KEY.
   */
  async refreshThetaDataIfDue(force = false): Promise<boolean> {
    if (this.thetaFetchInFlight) return false;
    if (!this.config.enableRwaFeeds && !this.thetaDataFetcher) {
      return false;
    }

    const nowMs = Date.now();
    const session = classifyUsEquitySession(new Date(nowMs));
    const minIntervalMs = session === "RTH" ? 60_000 : 300_000;
    if (
      !force &&
      this.lastThetaLiveFetchMs > 0 &&
      nowMs - this.lastThetaLiveFetchMs < minIntervalMs
    ) {
      return false;
    }

    this.thetaFetchInFlight = true;
    try {
      const snapshot = this.thetaDataFetcher
        ? await this.thetaDataFetcher()
        : await this.runThetaPythonBridge();

      if (snapshot && Array.isArray(snapshot.expirations)) {
        this.thetaSnapshot = snapshot;
        this.ivSource = "THETADATA_LIVE";
        this.lastThetaLiveFetchMs = Date.now();
        try {
          await this.db.setSyncState(
            THETADATA_SYNC_STATE_KEY,
            JSON.stringify(snapshot)
          );
        } catch {
          // non-fatal persistence failure
        }
        this.onStateChange?.();
        return true;
      }

      this.downgradeThetaSourceOnFailure();
      return false;
    } catch {
      this.downgradeThetaSourceOnFailure();
      return false;
    } finally {
      this.thetaFetchInFlight = false;
    }
  }

  private downgradeThetaSourceOnFailure(): void {
    if (this.thetaSnapshot) {
      this.ivSource = "THETADATA_CACHED";
    } else {
      this.ivSource = "SYNTHETIC_BASELINE";
    }
  }

  private async runThetaPythonBridge(): Promise<ThetaDataChainSnapshot | null> {
    const apiKey = this.config.thetaDataApiKey?.trim();
    if (!apiKey) return null;

    const pythonBin = this.config.thetaDataPythonBin?.trim();
    if (!pythonBin) return null;

    if (!fs.existsSync(this.thetaScriptPath)) return null;

    try {
      const { stdout } = await execFileAsync(
        pythonBin,
        [
          this.thetaScriptPath,
          "--settlement-utc-hour",
          String(this.settlementUtcHour),
        ],
        {
          timeout: 20_000,
          maxBuffer: 2 * 1024 * 1024,
          env: {
            ...process.env,
            THETADATA_API_KEY: apiKey,
            NVDAB_SETTLEMENT_UTC_HOUR: String(this.settlementUtcHour),
          },
        }
      );
      const parsed = JSON.parse(stdout.trim()) as ThetaDataChainSnapshot;
      if (!parsed || !Array.isArray(parsed.expirations)) {
        return null;
      }
      return parsed;
    } catch {
      // Fail soft cleanly without leaking env or crashing in Docker/CI without Python
      return null;
    }
  }

  private getBaselineSync(expiry?: number): number {
    if (expiry !== undefined) {
      const expBase = this.expiryBaselines.get(expiry);
      if (expBase !== undefined && expBase > 0) return expBase;
    }
    return this.defaultBaselineShareMultiplier > 0
      ? this.defaultBaselineShareMultiplier
      : 1.0;
  }

  /** Fast synchronous check used by keeper candidate discovery. */
  isSplitGuardActive(): boolean {
    if (!this.hasLiveMultiplier) return false;
    if (
      Math.abs(
        this.shareMultiplier / this.defaultBaselineShareMultiplier - 1
      ) > SPLIT_GUARD_DRIFT_THRESHOLD
    ) {
      return true;
    }
    for (const baseline of this.expiryBaselines.values()) {
      if (
        baseline > 0 &&
        Math.abs(this.shareMultiplier / baseline - 1) >
          SPLIT_GUARD_DRIFT_THRESHOLD
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Async split-cutover guard check for a specific `NVDAB` expiry (checks memory +
   * persisted `sync_state` `nvdab_open_multiplier:<expiry>` baseline).
   */
  async isSplitGuardTriggeredForExpiry(expiry: number): Promise<boolean> {
    if (!this.hasLiveMultiplier) return false;
    let baseline = this.expiryBaselines.get(expiry);
    if (baseline === undefined) {
      try {
        const saved = await this.db.getSyncState(
          `${MULTIPLIER_SYNC_STATE_PREFIX}${expiry}`
        );
        const parsed = toPositiveFinite(saved);
        if (parsed !== null) {
          baseline = parsed;
          this.expiryBaselines.set(expiry, parsed);
        }
      } catch {
        // ignore
      }
    }
    const effectiveBaseline = baseline ?? this.defaultBaselineShareMultiplier;
    if (!(effectiveBaseline > 0)) return false;
    return (
      Math.abs(this.shareMultiplier / effectiveBaseline - 1) >
      SPLIT_GUARD_DRIFT_THRESHOLD
    );
  }

  private evaluateBlackout(
    nowSec: number,
    expirySec?: number
  ): { blackout: boolean; reason: string | null } {
    if (this.blackoutDates.length === 0) {
      return { blackout: false, reason: null };
    }
    const startYmd = formatUtcYmdFromSec(nowSec);
    const effectiveExpiry =
      expirySec ??
      getNextUsEquityOptionExpiry(
        nowSec,
        "DAILY",
        this.settlementUtcHour,
        this.getThetaListedExpirations()
      );
    const endYmd = formatUtcYmdFromSec(Math.max(nowSec, effectiveExpiry));

    for (const rawDate of this.blackoutDates) {
      const d = rawDate.trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
      if (d >= startYmd && d <= endYmd) {
        return {
          blackout: true,
          reason: `Corporate action blackout window crosses ${d}`,
        };
      }
    }
    return { blackout: false, reason: null };
  }

  private resolveCurrentIvSource(session: RwaMarketSession): RwaIvSource {
    if (!this.thetaSnapshot) return "SYNTHETIC_BASELINE";
    if (this.ivSource === "THETADATA_LIVE") {
      const maxLiveAgeMs = session === "RTH" ? 15 * 60_000 : 30 * 60_000;
      if (
        this.lastThetaLiveFetchMs > 0 &&
        Date.now() - this.lastThetaLiveFetchMs <= maxLiveAgeMs
      ) {
        return "THETADATA_LIVE";
      }
      return "THETADATA_CACHED";
    }
    return this.ivSource;
  }

  getTelemetry(
    underlying: UnderlyingSymbol,
    opts?: { expiry?: number; nowSec?: number }
  ): RwaAssetTelemetry | undefined {
    if (underlying !== "NVDAB") return undefined;

    const nowMs = Date.now();
    const nowSec = opts?.nowSec ?? this.effectiveNowFn();
    const session = classifyUsEquitySession(new Date(nowSec * 1000));

    const currentMult = this.getShareMultiplier();
    const baselineMult = this.getBaselineSync(opts?.expiry);
    const driftRatio =
      baselineMult > 0 ? currentMult / baselineMult - 1 : 0;
    const multiplierDriftPct = Number((driftRatio * 100).toFixed(4));
    const splitGuardTriggered =
      this.hasLiveMultiplier &&
      Math.abs(driftRatio) > SPLIT_GUARD_DRIFT_THRESHOLD;

    const { blackout, reason: blackoutReason } = this.evaluateBlackout(
      nowSec,
      opts?.expiry
    );

    const atlasSpot = this.atlasOracle.getTelemetry("NVDAB").price;
    const perpPriceUsd = this.perpPriceUsd;
    const singleShareSpot =
      currentMult > 0 && atlasSpot > 0 ? atlasSpot / currentMult : 0;
    const spotPerpBasisBps =
      perpPriceUsd !== null && perpPriceUsd > 0 && singleShareSpot > 0
        ? Number(
            (
              (Math.abs(singleShareSpot - perpPriceUsd) / perpPriceUsd) *
              10_000
            ).toFixed(2)
          )
        : null;

    const ivSource = this.resolveCurrentIvSource(session);
    const updatedAtMs = Math.max(
      this.multiplierUpdatedAtMs,
      this.perpUpdatedAtMs,
      this.thetaSnapshot?.fetchedAtMs ?? 0,
      nowMs
    );

    return {
      underlying: "NVDAB",
      session,
      shareMultiplier: Number(currentMult.toFixed(8)),
      baselineShareMultiplier: Number(baselineMult.toFixed(8)),
      multiplierDriftPct,
      crossVenueMultiplierGapPct: this.crossVenueMultiplierGapPct,
      splitGuardTriggered,
      corporateActionBlackout: blackout,
      blackoutReason,
      perpSymbol: this.perpSymbol,
      perpPriceUsd,
      spotPerpBasisBps,
      ivSource,
      thetaAtmIv: this.thetaSnapshot?.atmIv ?? null,
      thetaExpiration: this.thetaSnapshot?.nearestExp ?? null,
      thetaStrikeCount: this.thetaSnapshot?.strikes?.length ?? 0,
      thetaUpdatedAtMs: this.thetaSnapshot?.fetchedAtMs ?? null,
      settlementUtcHour: this.settlementUtcHour,
      updatedAtMs,
    };
  }

  getAllTelemetry(opts?: {
    expiry?: number;
    nowSec?: number;
  }): Partial<Record<UnderlyingSymbol, RwaAssetTelemetry>> {
    const nvdab = this.getTelemetry("NVDAB", opts);
    return nvdab ? { NVDAB: nvdab } : {};
  }
}

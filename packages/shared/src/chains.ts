import { keccak256, toBytes } from "viem";

export interface ChainConfig {
  chainId: number;
  name: string;
  rpcUrl: string;
  explorerUrl?: string;
  usdtAddress?: `0x${string}`;
  usdtDecimals: number;
  nativeSymbol: string;
}

export const BSC_TESTNET: ChainConfig = {
  chainId: 97,
  name: "BNB Smart Chain Testnet",
  rpcUrl: "https://data-seed-prebsc-1-s1.bnbchain.org:8545",
  explorerUrl: "https://testnet.bscscan.com",
  usdtDecimals: 6,
  nativeSymbol: "tBNB",
};

export const LOCAL_HARDHAT: ChainConfig = {
  chainId: 31337,
  name: "Payoff Local Devnet",
  rpcUrl: "http://127.0.0.1:8545",
  usdtDecimals: 6,
  nativeSymbol: "ETH",
};

export enum Underlying {
  BTC = 0,
  ETH = 1,
  NVDAB = 2,
}

export type UnderlyingSymbol = "BTC" | "ETH" | "NVDAB";

export const SUPPORTED_UNDERLYINGS: readonly UnderlyingSymbol[] = [
  "BTC",
  "ETH",
  "NVDAB",
] as const;

export function isSupportedUnderlying(
  value: unknown
): value is UnderlyingSymbol {
  return (
    typeof value === "string" &&
    (SUPPORTED_UNDERLYINGS as readonly string[]).includes(value)
  );
}

export const ASSET_BTC_ID: `0x${string}` = keccak256(toBytes("BTC"));
export const ASSET_ETH_ID: `0x${string}` = keccak256(toBytes("ETH"));
export const ASSET_NVDAB_ID: `0x${string}` = keccak256(toBytes("NVDAB"));

export const ASSET_IDS: Record<UnderlyingSymbol, `0x${string}`> = {
  BTC: ASSET_BTC_ID,
  ETH: ASSET_ETH_ID,
  NVDAB: ASSET_NVDAB_ID,
};

export interface AtlasFeedConfig {
  feedId: string;
  feedIdHex: `0x${string}`;
  pair: string;
}

export const ATLAS_FEEDS: Record<UnderlyingSymbol, AtlasFeedConfig> = {
  BTC: { feedId: "626", feedIdHex: "0x00000272", pair: "BTC/USD" },
  ETH: { feedId: "632", feedIdHex: "0x00000278", pair: "ETH/USD" },
  NVDAB: { feedId: "1005", feedIdHex: "0x000003ed", pair: "NVDAB/USD" },
};

export type AssetClass = "CRYPTO" | "RWA_EQUITY";

export interface AssetSpec {
  symbol: UnderlyingSymbol;
  displaySymbol: string;
  displayName: string;
  assetClass: AssetClass;
  settlementUtcHour: number;
  expiryCadence: "DAILY_24_7" | "US_EQUITY_MWF";
  binanceSpotSymbol: string;
  binancePerpSymbol?: string;
  defaultSpot: number;
  defaultIv: number;
  defaultDailyStep: number;
  defaultWeeklyStep: number;
}

export const ASSET_SPECS: Record<UnderlyingSymbol, AssetSpec> = {
  BTC: {
    symbol: "BTC",
    displaySymbol: "BTC",
    displayName: "Bitcoin",
    assetClass: "CRYPTO",
    settlementUtcHour: 8,
    expiryCadence: "DAILY_24_7",
    binanceSpotSymbol: "BTCUSDT",
    defaultSpot: 61500,
    defaultIv: 0.6,
    defaultDailyStep: 500,
    defaultWeeklyStep: 500,
  },
  ETH: {
    symbol: "ETH",
    displaySymbol: "ETH",
    displayName: "Ethereum",
    assetClass: "CRYPTO",
    settlementUtcHour: 8,
    expiryCadence: "DAILY_24_7",
    binanceSpotSymbol: "ETHUSDT",
    defaultSpot: 1750,
    defaultIv: 0.65,
    defaultDailyStep: 25,
    defaultWeeklyStep: 50,
  },
  NVDAB: {
    symbol: "NVDAB",
    displaySymbol: "NVDA",
    displayName: "NVIDIA (bStock)",
    assetClass: "RWA_EQUITY",
    settlementUtcHour: 21,
    expiryCadence: "US_EQUITY_MWF",
    binanceSpotSymbol: "NVDABUSDT",
    binancePerpSymbol: "NVDAUSDT",
    defaultSpot: 153.0,
    defaultIv: 0.52,
    defaultDailyStep: 2.5,
    defaultWeeklyStep: 5,
  },
};

export function getAssetSettlementUtcHour(
  underlying: UnderlyingSymbol
): number {
  return ASSET_SPECS[underlying].settlementUtcHour;
}

/** Official Atlas Oracle production ECDSA signer verified on-chain */
export const ATLAS_OFFICIAL_SIGNER: `0x${string}` =
  "0x59eD4701224fD9e2a85Ef2946c2ab828C1dDC600";

/** Atlas Pull Oracle trailing calldata magic marker */
export const ATLAS_MAGIC_MARKER: `0x${string}` = "0x7096";

export function symbolToAssetId(
  symbol: UnderlyingSymbol | string
): `0x${string}` {
  const upper = symbol.toUpperCase();
  if (upper === "BTC") return ASSET_BTC_ID;
  if (upper === "ETH") return ASSET_ETH_ID;
  if (upper === "NVDAB") return ASSET_NVDAB_ID;
  return keccak256(toBytes(upper));
}

export function assetIdToSymbol(
  assetId: `0x${string}` | string
): UnderlyingSymbol {
  const lower = assetId.toLowerCase();
  if (lower === ASSET_BTC_ID.toLowerCase()) return "BTC";
  if (lower === ASSET_ETH_ID.toLowerCase()) return "ETH";
  if (lower === ASSET_NVDAB_ID.toLowerCase()) return "NVDAB";
  throw new Error(`Unsupported assetId: ${assetId}`);
}

export function underlyingToSymbol(u: Underlying | number): UnderlyingSymbol {
  if (u === Underlying.BTC) return "BTC";
  if (u === Underlying.ETH) return "ETH";
  if (u === Underlying.NVDAB) return "NVDAB";
  throw new Error(`Unsupported underlying: ${u}`);
}

export function symbolToUnderlying(s: string): Underlying {
  if (s === "BTC") return Underlying.BTC;
  if (s === "ETH") return Underlying.ETH;
  if (s === "NVDAB") return Underlying.NVDAB;
  throw new Error(`Unsupported underlying symbol: ${s}`);
}

export const PRICE_DECIMALS = 8;
export const USDT_DECIMALS = 6;
export const PRICE_SCALE = 10n ** 8n;
export const USDT_SCALE = 10n ** 6n;

/** Hard protocol cap on open markup: 5% (500 bps) */
export const MAX_OPEN_FEE_BPS = 500;
/** Default disciplined markup: 4% (400 bps) within 3-5% target */
export const DEFAULT_OPEN_FEE_BPS = 400;
/** Hard protocol cap on early close fee: 1% (100 bps) */
export const MAX_CLOSE_FEE_BPS = 100;
export const DEFAULT_CLOSE_FEE_BPS = 0;

/** Unified daily/weekly option settlement hour in UTC */
export const SETTLEMENT_UTC_HOUR = 8;

/** Deterministic 30-minute TWAP settlement constants (aligned with Deribit / OKX / Binance) */
export const SETTLEMENT_TWAP_SAMPLE_COUNT = 30;
export const SETTLEMENT_TWAP_INTERVAL_SEC = 60;
export const SETTLEMENT_DELAY_SEC = 60;
export const SETTLEMENT_EXACT_MATCH_GRACE_SEC = 900;
export const SETTLEMENT_FALLBACK_TOLERANCE_SEC = 10;
export const SETTLEMENT_HEALTH_MIN_AVG_SCORE = 0.4;
export const SETTLEMENT_HEALTH_MIN_OBSERVED_MINUTES = 20;
export const MIN_CLOSE_LEAD_TIME_SEC = 1800; // 30 minutes (locked once TWAP window starts)

const MIN_US_EQUITY_DAILY_LEAD_SEC = 8 * 3600;
const MIN_US_EQUITY_WEEKLY_LEAD_SEC = 72 * 3600;

const usHolidayCache = new Map<number, Set<string>>();

function formatUtcYmd(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function nthWeekdayOfMonthUtc(
  year: number,
  month1Based: number,
  weekday: number,
  nth: number
): Date {
  const firstDow = new Date(Date.UTC(year, month1Based - 1, 1)).getUTCDay();
  const offset = (weekday - firstDow + 7) % 7;
  const day = 1 + offset + (nth - 1) * 7;
  return new Date(Date.UTC(year, month1Based - 1, day));
}

function lastWeekdayOfMonthUtc(
  year: number,
  month1Based: number,
  weekday: number
): Date {
  const lastDay = new Date(Date.UTC(year, month1Based, 0));
  const lastDow = lastDay.getUTCDay();
  const back = (lastDow - weekday + 7) % 7;
  return new Date(
    Date.UTC(year, month1Based - 1, lastDay.getUTCDate() - back)
  );
}

/** Meeus/Jones/Butcher Gregorian Easter algorithm -> Good Friday (Easter - 2 days). */
function goodFridayUtc(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day - 2));
}

function addObservedFixedHoliday(
  set: Set<string>,
  year: number,
  month1Based: number,
  day: number,
  allowFridayForSaturday = true
): void {
  const d = new Date(Date.UTC(year, month1Based - 1, day));
  const dow = d.getUTCDay();
  if (dow === 6) {
    if (allowFridayForSaturday) {
      set.add(formatUtcYmd(new Date(Date.UTC(year, month1Based - 1, day - 1))));
    }
  } else if (dow === 0) {
    set.add(formatUtcYmd(new Date(Date.UTC(year, month1Based - 1, day + 1))));
  } else {
    set.add(formatUtcYmd(d));
  }
}

function getUsEquityHolidaysForYear(year: number): Set<string> {
  const cached = usHolidayCache.get(year);
  if (cached) return cached;

  const holidays = new Set<string>();
  // New Year's Day (NYSE Rule 7.2: if Jan 1 is Saturday, preceding Dec 31 is open)
  addObservedFixedHoliday(holidays, year, 1, 1, false);
  // MLK Jr. Day: 3rd Monday of January
  holidays.add(formatUtcYmd(nthWeekdayOfMonthUtc(year, 1, 1, 3)));
  // Presidents' Day: 3rd Monday of February
  holidays.add(formatUtcYmd(nthWeekdayOfMonthUtc(year, 2, 1, 3)));
  // Good Friday
  holidays.add(formatUtcYmd(goodFridayUtc(year)));
  // Memorial Day: Last Monday of May
  holidays.add(formatUtcYmd(lastWeekdayOfMonthUtc(year, 5, 1)));
  // Juneteenth (NYSE/NASDAQ holiday since 2022)
  if (year >= 2022) {
    addObservedFixedHoliday(holidays, year, 6, 19);
  }
  // Independence Day
  addObservedFixedHoliday(holidays, year, 7, 4);
  // Labor Day: 1st Monday of September
  holidays.add(formatUtcYmd(nthWeekdayOfMonthUtc(year, 9, 1, 1)));
  // Thanksgiving Day: 4th Thursday of November
  holidays.add(formatUtcYmd(nthWeekdayOfMonthUtc(year, 11, 4, 4)));
  // Christmas Day
  addObservedFixedHoliday(holidays, year, 12, 25);

  usHolidayCache.set(year, holidays);
  return holidays;
}

/** Returns true if the UTC calendar date is a full-day NYSE/NASDAQ market holiday. */
export function isUsEquityMarketHoliday(utcDate: Date): boolean {
  const year = utcDate.getUTCFullYear();
  const ymd = formatUtcYmd(utcDate);
  return getUsEquityHolidaysForYear(year).has(ymd);
}

/** OCC rule: walk a weekend or US market holiday backward to the preceding US trading day. */
function adjustToPrecedingUsTradingDay(utcDate: Date): Date {
  const adj = new Date(utcDate.getTime());
  while (
    adj.getUTCDay() === 0 ||
    adj.getUTCDay() === 6 ||
    isUsEquityMarketHoliday(adj)
  ) {
    adj.setUTCDate(adj.getUTCDate() - 1);
  }
  return adj;
}

function parseListedDateString(
  raw: string,
  settlementUtcHour: number
): { sec: number; utcDate: Date; dayOfWeek: number } | null {
  const trimmed = raw.trim();
  const match =
    /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed) ??
    /^(\d{4})(\d{2})(\d{2})$/.exec(trimmed);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utcDate = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
  if (
    utcDate.getUTCFullYear() !== year ||
    utcDate.getUTCMonth() !== month - 1 ||
    utcDate.getUTCDate() !== day
  ) {
    return null;
  }

  const sec = Math.floor(
    Date.UTC(year, month - 1, day, settlementUtcHour, 0, 0) / 1000
  );
  return { sec, utcDate, dayOfWeek: utcDate.getUTCDay() };
}

/**
 * Computes the next US equity option expiration (Unix seconds at `settlementUtcHour:00 UTC`),
 * aligned 1:1 with CBOE/OCC NVDA Mon/Wed/Fri short-term & Friday weekly expirations.
 *
 * - `DAILY`: picks the first listed date with `expiry - fromSec >= 8h` (offline fallback:
 *   next Mon / Wed / Fri, moving any US market holiday backward to the preceding US trading
 *   day per OCC rules and deduplicating, with `>= 8h` lead time).
 * - `WEEKLY`: picks the first listed Friday (or holiday-adjusted Thursday when Friday is a US
 *   market holiday) with `expiry - fromSec >= 72h` (offline fallback: next Friday 3–9+ days ahead,
 *   shifted to the preceding trading day if Friday is a US holiday, preserving `>= 72h` lead).
 */
export function getNextUsEquityOptionExpiry(
  fromSec: number,
  tenor: "DAILY" | "WEEKLY",
  settlementUtcHour: number = ASSET_SPECS.NVDAB.settlementUtcHour,
  listedDates?: readonly string[]
): number {
  const hour = Math.max(0, Math.min(23, Math.trunc(settlementUtcHour)));

  if (listedDates && listedDates.length > 0) {
    const parsedBySec = new Map<
      number,
      { sec: number; utcDate: Date; dayOfWeek: number }
    >();
    for (const raw of listedDates) {
      const parsed = parseListedDateString(raw, hour);
      if (parsed && !parsedBySec.has(parsed.sec)) {
        parsedBySec.set(parsed.sec, parsed);
      }
    }
    const sorted = [...parsedBySec.values()].sort((a, b) => a.sec - b.sec);

    if (tenor === "DAILY") {
      const match = sorted.find(
        (d) => d.sec - fromSec >= MIN_US_EQUITY_DAILY_LEAD_SEC
      );
      if (match) return match.sec;
    } else {
      const match = sorted.find((d) => {
        if (d.sec - fromSec < MIN_US_EQUITY_WEEKLY_LEAD_SEC) return false;
        if (d.dayOfWeek === 5) return true;
        if (d.dayOfWeek === 4) {
          const nextDay = new Date(d.utcDate.getTime() + 86_400_000);
          return isUsEquityMarketHoliday(nextDay);
        }
        return false;
      });
      if (match) return match.sec;
    }
  }

  const base = new Date(fromSec * 1000);
  const startYear = base.getUTCFullYear();
  const startMonth = base.getUTCMonth();
  const startDay = base.getUTCDate();

  if (tenor === "DAILY") {
    const seenSecs = new Set<number>();
    for (let offset = 0; offset <= 21; offset++) {
      const utcDate = new Date(
        Date.UTC(startYear, startMonth, startDay + offset, 0, 0, 0)
      );
      const dow = utcDate.getUTCDay();
      if (dow !== 1 && dow !== 3 && dow !== 5) continue;

      const adjDate = adjustToPrecedingUsTradingDay(utcDate);
      const sec = Math.floor(
        Date.UTC(
          adjDate.getUTCFullYear(),
          adjDate.getUTCMonth(),
          adjDate.getUTCDate(),
          hour,
          0,
          0
        ) / 1000
      );
      if (seenSecs.has(sec)) continue;
      seenSecs.add(sec);

      if (sec - fromSec >= MIN_US_EQUITY_DAILY_LEAD_SEC) {
        return sec;
      }
    }
  } else {
    const seenSecs = new Set<number>();
    for (let offset = 0; offset <= 28; offset++) {
      const friDate = new Date(
        Date.UTC(startYear, startMonth, startDay + offset, 0, 0, 0)
      );
      if (friDate.getUTCDay() !== 5) continue;

      // Holiday-adjust Friday backward to the preceding US trading day if Friday is a market holiday
      const adjDate = adjustToPrecedingUsTradingDay(friDate);
      const sec = Math.floor(
        Date.UTC(
          adjDate.getUTCFullYear(),
          adjDate.getUTCMonth(),
          adjDate.getUTCDate(),
          hour,
          0,
          0
        ) / 1000
      );
      if (seenSecs.has(sec)) continue;
      seenSecs.add(sec);

      if (sec - fromSec >= MIN_US_EQUITY_WEEKLY_LEAD_SEC) {
        return sec;
      }
    }
  }

  // Unreachable defensive fallback
  return Math.floor(
    Date.UTC(startYear, startMonth, startDay + 7, hour, 0, 0) / 1000
  );
}

function snapDownToOccStrike(price: number): number {
  if (price <= 1) return 1;
  if (price <= 150) return Math.floor(price);
  if (price <= 200) return Math.floor(price / 2.5) * 2.5;
  return Math.floor(price / 5) * 5;
}

function nextOccStrike(strike: number): number {
  if (strike < 150) return strike + 1;
  if (strike < 200) return strike + 2.5;
  return strike + 5;
}

/**
 * Generates exact CBOE/OCC listed equity strikes spanning ±`rangePct` (default ±20%) around `spot`:
 * - `$1.00` steps for `K <= 150`
 * - `$2.50` steps for `150 < K <= 200`
 * - `$5.00` steps for `K > 200`
 */
export function generateOccEquityStrikes(
  spot: number,
  rangePct = 0.2
): number[] {
  if (!Number.isFinite(spot) || spot <= 0) return [];
  const boundedRange = Math.max(0.05, Math.min(0.6, rangePct));
  const minStrike = Math.max(1, spot * (1 - boundedRange));
  const maxStrike = Math.max(minStrike, spot * (1 + boundedRange));
  const strikes: number[] = [];

  let k = snapDownToOccStrike(minStrike);
  while (true) {
    strikes.push(k);
    if (k >= maxStrike) break;
    k = nextOccStrike(k);
  }
  return strikes;
}

import { describe, expect, it } from "vitest";
import {
  ASSET_IDS,
  ASSET_NVDAB_ID,
  ASSET_SPECS,
  ATLAS_FEEDS,
  SUPPORTED_UNDERLYINGS,
  Underlying,
  assetIdToSymbol,
  computeMaxAllowedWidthPct,
  computeUnclampedSpreadFairRatio,
  estimateCustomTicketPreview,
  formatSettlementLabel,
  generateOccEquityStrikes,
  getAssetSettlementUtcHour,
  getNextUsEquityOptionExpiry,
  isSupportedUnderlying,
  isUsEquityMarketHoliday,
  resolveClampedCustomRange,
  symbolToAssetId,
  symbolToUnderlying,
  underlyingToSymbol,
  validateCustomSpreadRange,
  type CustomRangeConfig,
} from "../src/index.js";

const btcStrikes = [
  59000, 59500, 60000, 60500, 61000, 61500, 62000, 62500, 63000, 63500, 64000,
  64500, 65000, 66000, 68000,
];

describe("@payoff/shared Layer-2 custom range guardrails", () => {
  it("accepts standard aligned 24h range", () => {
    const res = validateCustomSpreadRange({
      underlying: "BTC",
      isCall: true,
      spot: 61900,
      lowerStrike: 62000,
      upperStrike: 64000,
      tenor: "DAILY",
      hoursToExpiry: 24,
      atmIv: 0.6,
      availableStrikes: btcStrikes,
      maxMultiplier: 2.95,
      shortLegSubsidyRatio: 0.31,
    });
    expect(res.valid).toBe(true);
    expect(res.strikeAligned).toBe(true);
    expect(res.widthWithinCap).toBe(true);
    expect(res.lowMultiplierWarning).toBe(false);
  });

  it("Guardrail 1: rejects unaligned fractional strikes", () => {
    const res = validateCustomSpreadRange({
      underlying: "BTC",
      isCall: true,
      spot: 61900,
      lowerStrike: 61888,
      upperStrike: 63999,
      tenor: "DAILY",
      hoursToExpiry: 24,
      atmIv: 0.6,
      availableStrikes: btcStrikes,
      maxMultiplier: 2.8,
      shortLegSubsidyRatio: 0.25,
    });
    expect(res.valid).toBe(false);
    expect(res.strikeAligned).toBe(false);
  });

  it("Guardrail 2: rejects excessively wide 24h range (9.69% width)", () => {
    const res = validateCustomSpreadRange({
      underlying: "BTC",
      isCall: true,
      spot: 61900,
      lowerStrike: 62000,
      upperStrike: 68000,
      tenor: "DAILY",
      hoursToExpiry: 24,
      atmIv: 0.6,
      availableStrikes: btcStrikes,
      maxMultiplier: 4.5,
      shortLegSubsidyRatio: 0.03,
    });
    expect(res.valid).toBe(false);
    expect(res.widthWithinCap).toBe(false);
  });

  it("Guardrail 2: accepts all 4 fixed-grid maximum daily and weekly targets", () => {
    // BTC Daily +6Δ = $3,000 (~5.17% at spot 58,000)
    const btcDaily = validateCustomSpreadRange({
      underlying: "BTC",
      isCall: true,
      spot: 58000,
      lowerStrike: 58000,
      upperStrike: 61000,
      tenor: "DAILY",
      hoursToExpiry: 24,
      atmIv: 0.55,
      availableStrikes: [57500, 58000, 58500, 59000, 60000, 61000],
      maxMultiplier: 3.4,
      shortLegSubsidyRatio: 0.15,
    });
    expect(btcDaily.valid).toBe(true);
    expect(btcDaily.widthWithinCap).toBe(true);
    expect(btcDaily.maxAllowedWidthPct).toBe(7.2);

    // ETH Daily +4Δ = $100 (~6.10% at spot 1,640)
    const ethDaily = validateCustomSpreadRange({
      underlying: "ETH",
      isCall: true,
      spot: 1640,
      lowerStrike: 1625,
      upperStrike: 1725,
      tenor: "DAILY",
      hoursToExpiry: 24,
      atmIv: 0.65,
      availableStrikes: [1600, 1625, 1650, 1675, 1700, 1725],
      maxMultiplier: 2.9,
      shortLegSubsidyRatio: 0.12,
    });
    expect(ethDaily.valid).toBe(true);
    expect(ethDaily.widthWithinCap).toBe(true);
    expect(ethDaily.maxAllowedWidthPct).toBeGreaterThanOrEqual(7.2);
    expect(ethDaily.maxAllowedWidthPct).toBeLessThanOrEqual(8.0);

    // BTC Weekly +12Δ = $6,000 (~10.20% at spot 58,800)
    const btcWeekly = validateCustomSpreadRange({
      underlying: "BTC",
      isCall: true,
      spot: 58800,
      lowerStrike: 58500,
      upperStrike: 64500,
      tenor: "WEEKLY",
      hoursToExpiry: 168,
      atmIv: 0.55,
      availableStrikes: [58000, 58500, 59500, 60500, 62500, 64500],
      maxMultiplier: 2.8,
      shortLegSubsidyRatio: 0.2,
    });
    expect(btcWeekly.valid).toBe(true);
    expect(btcWeekly.widthWithinCap).toBe(true);
    expect(btcWeekly.maxAllowedWidthPct).toBeGreaterThanOrEqual(14.0);
    expect(btcWeekly.maxAllowedWidthPct).toBeLessThanOrEqual(16.0);

    // ETH Weekly +4Δ = $200 (~12.12% at spot 1,650)
    const ethWeekly = validateCustomSpreadRange({
      underlying: "ETH",
      isCall: true,
      spot: 1650,
      lowerStrike: 1650,
      upperStrike: 1850,
      tenor: "WEEKLY",
      hoursToExpiry: 168,
      atmIv: 0.65,
      availableStrikes: [1600, 1650, 1700, 1750, 1800, 1850],
      maxMultiplier: 3.1,
      shortLegSubsidyRatio: 0.18,
    });
    expect(ethWeekly.valid).toBe(true);
    expect(ethWeekly.widthWithinCap).toBe(true);
    expect(ethWeekly.maxAllowedWidthPct).toBeGreaterThanOrEqual(14.0);
    expect(ethWeekly.maxAllowedWidthPct).toBeLessThanOrEqual(16.0);
  });

  it("Guardrail 2: enforces daily (8.0%) and weekly (14.0% floor / 16.0% ceiling) width caps", () => {
    // High-IV daily caps at 8.0%: 8.5% width must fail
    const dailyOverCap = validateCustomSpreadRange({
      underlying: "BTC",
      isCall: true,
      spot: 60000,
      lowerStrike: 60000,
      upperStrike: 65100,
      tenor: "DAILY",
      hoursToExpiry: 24,
      atmIv: 1.0,
      availableStrikes: [60000, 64500, 65100],
      maxMultiplier: 3.8,
      shortLegSubsidyRatio: 0.1,
    });
    expect(dailyOverCap.maxAllowedWidthPct).toBe(8.0);
    expect(dailyOverCap.valid).toBe(false);
    expect(dailyOverCap.widthWithinCap).toBe(false);

    // Low-IV weekly floors at 14.0%: 14.17% width must fail
    const weeklyOverFloor = validateCustomSpreadRange({
      underlying: "BTC",
      isCall: true,
      spot: 60000,
      lowerStrike: 60000,
      upperStrike: 68500,
      tenor: "WEEKLY",
      hoursToExpiry: 120,
      atmIv: 0.35,
      availableStrikes: [60000, 68000, 68500],
      maxMultiplier: 4.1,
      shortLegSubsidyRatio: 0.1,
    });
    expect(weeklyOverFloor.maxAllowedWidthPct).toBe(14.0);
    expect(weeklyOverFloor.valid).toBe(false);
    expect(weeklyOverFloor.widthWithinCap).toBe(false);

    // High-IV weekly caps at 16.0%: 17.01% width must fail
    const weeklyOverCap = validateCustomSpreadRange({
      underlying: "BTC",
      isCall: true,
      spot: 58800,
      lowerStrike: 58500,
      upperStrike: 68500,
      tenor: "WEEKLY",
      hoursToExpiry: 168,
      atmIv: 0.85,
      availableStrikes: [58500, 64500, 68500],
      maxMultiplier: 4.5,
      shortLegSubsidyRatio: 0.08,
    });
    expect(weeklyOverCap.maxAllowedWidthPct).toBe(16.0);
    expect(weeklyOverCap.valid).toBe(false);
    expect(weeklyOverCap.widthWithinCap).toBe(false);
  });

  it("Guardrail 3: warns when deep ITM multiplier < 1.3x", () => {
    const res = validateCustomSpreadRange({
      underlying: "BTC",
      isCall: true,
      spot: 61900,
      lowerStrike: 59500,
      upperStrike: 61500,
      tenor: "DAILY",
      hoursToExpiry: 24,
      atmIv: 0.6,
      availableStrikes: btcStrikes,
      maxMultiplier: 1.18,
      shortLegSubsidyRatio: 0.85,
    });
    expect(res.valid).toBe(true);
    expect(res.lowMultiplierWarning).toBe(true);
    expect(res.warnings[0]).toContain("当前区间偏保守收租");
  });

  it("validates NVDAB:DAILY ($2.50-$10.00) and NVDAB:WEEKLY ($5-$20) OCC-aligned spreads against width caps", () => {
    const spot = 153.5;
    const occStrikes = generateOccEquityStrikes(spot);

    // NVDAB:DAILY widths: $2.50 (1.63%), $5.00 (3.26%), $7.50 (4.89%), $10.00 (6.51% <= 7.2%)
    for (const width of [2.5, 5.0, 7.5, 10.0]) {
      const lower = 152.5;
      const upper = lower + width;
      const res = validateCustomSpreadRange({
        underlying: "NVDAB",
        isCall: true,
        spot,
        lowerStrike: lower,
        upperStrike: upper,
        tenor: "DAILY",
        hoursToExpiry: 24,
        atmIv: 0.52,
        availableStrikes: occStrikes,
        maxMultiplier: 2.6,
        shortLegSubsidyRatio: 0.22,
      });
      expect(res.valid).toBe(true);
      expect(res.strikeAligned).toBe(true);
      expect(res.widthWithinCap).toBe(true);
    }

    // NVDAB:DAILY over-cap ($15.00 = 9.77% > 8.0%) must fail
    const dailyOver = validateCustomSpreadRange({
      underlying: "NVDAB",
      isCall: true,
      spot,
      lowerStrike: 152.5,
      upperStrike: 167.5,
      tenor: "DAILY",
      hoursToExpiry: 24,
      atmIv: 0.52,
      availableStrikes: occStrikes,
      maxMultiplier: 3.8,
      shortLegSubsidyRatio: 0.1,
    });
    expect(dailyOver.valid).toBe(false);
    expect(dailyOver.widthWithinCap).toBe(false);

    // Unaligned non-OCC strike ($151.50 in >$150 $2.50 zone) must fail
    const unaligned = validateCustomSpreadRange({
      underlying: "NVDAB",
      isCall: true,
      spot,
      lowerStrike: 151.5,
      upperStrike: 155,
      tenor: "DAILY",
      hoursToExpiry: 24,
      atmIv: 0.52,
      availableStrikes: occStrikes,
      maxMultiplier: 2.2,
      shortLegSubsidyRatio: 0.2,
    });
    expect(unaligned.valid).toBe(false);
    expect(unaligned.strikeAligned).toBe(false);

    // NVDAB:WEEKLY widths: $5 (3.26%), $10 (6.51%), $15 (9.77%), $20 (13.03% <= 14.0%)
    for (const width of [5, 10, 15, 20]) {
      const lower = 150;
      const upper = lower + width;
      const res = validateCustomSpreadRange({
        underlying: "NVDAB",
        isCall: true,
        spot,
        lowerStrike: lower,
        upperStrike: upper,
        tenor: "WEEKLY",
        hoursToExpiry: 144,
        atmIv: 0.52,
        availableStrikes: occStrikes,
        maxMultiplier: 2.8,
        shortLegSubsidyRatio: 0.25,
      });
      expect(res.valid).toBe(true);
      expect(res.strikeAligned).toBe(true);
      expect(res.widthWithinCap).toBe(true);
    }

    // NVDAB:WEEKLY over-cap ($27.50 = 17.92% > 16.0%) must fail
    const weeklyOver = validateCustomSpreadRange({
      underlying: "NVDAB",
      isCall: true,
      spot,
      lowerStrike: 150,
      upperStrike: 177.5,
      tenor: "WEEKLY",
      hoursToExpiry: 144,
      atmIv: 0.52,
      availableStrikes: occStrikes,
      maxMultiplier: 4.2,
      shortLegSubsidyRatio: 0.1,
    });
    expect(weeklyOver.valid).toBe(false);
    expect(weeklyOver.widthWithinCap).toBe(false);
  });
});

describe("@payoff/shared NVDAB metadata, OCC strikes, US equity expiry & settlement label", () => {
  it("exports NVDAB asset metadata, Atlas feed #1005, and conversion helpers", () => {
    expect(Underlying.NVDAB).toBe(2);
    expect(SUPPORTED_UNDERLYINGS).toEqual(["BTC", "ETH", "NVDAB"]);
    expect(isSupportedUnderlying("BTC")).toBe(true);
    expect(isSupportedUnderlying("ETH")).toBe(true);
    expect(isSupportedUnderlying("NVDAB")).toBe(true);
    expect(isSupportedUnderlying("SOL")).toBe(false);
    expect(isSupportedUnderlying(undefined)).toBe(false);

    expect(ASSET_IDS.NVDAB).toBe(ASSET_NVDAB_ID);
    expect(symbolToAssetId("NVDAB")).toBe(ASSET_NVDAB_ID);
    expect(assetIdToSymbol(ASSET_NVDAB_ID)).toBe("NVDAB");
    expect(underlyingToSymbol(Underlying.NVDAB)).toBe("NVDAB");
    expect(symbolToUnderlying("NVDAB")).toBe(Underlying.NVDAB);

    expect(ATLAS_FEEDS.NVDAB).toEqual({
      feedId: "1005",
      feedIdHex: "0x000003ed",
      pair: "NVDAB/USD",
    });

    expect(ASSET_SPECS.NVDAB.assetClass).toBe("RWA_EQUITY");
    expect(ASSET_SPECS.NVDAB.displaySymbol).toBe("NVDA");
    expect(ASSET_SPECS.NVDAB.binanceSpotSymbol).toBe("NVDABUSDT");
    expect(ASSET_SPECS.NVDAB.binancePerpSymbol).toBe("NVDAUSDT");
    expect(getAssetSettlementUtcHour("BTC")).toBe(8);
    expect(getAssetSettlementUtcHour("ETH")).toBe(8);
    expect(getAssetSettlementUtcHour("NVDAB")).toBe(21);
  });

  it("generates exact CBOE/OCC equity strikes across $1, $2.50, and $5 transitions", () => {
    // Spanning both $150 and $200 boundaries: spot = 180 -> [144, 216]
    const wide = generateOccEquityStrikes(180);
    expect(wide[0]).toBeLessThanOrEqual(180 * 0.8);
    expect(wide[wide.length - 1]).toBeGreaterThanOrEqual(180 * 1.2);

    // Check transitions explicitly
    expect(wide).toContain(148);
    expect(wide).toContain(149);
    expect(wide).toContain(150);
    expect(wide).toContain(152.5);
    expect(wide).toContain(155);
    expect(wide).not.toContain(151);
    expect(wide).not.toContain(152);
    expect(wide).toContain(197.5);
    expect(wide).toContain(200);
    expect(wide).toContain(205);
    expect(wide).toContain(210);
    expect(wide).not.toContain(202.5);

    // Verify exact step size between every adjacent pair
    for (let i = 1; i < wide.length; i++) {
      const prev = wide[i - 1]!;
      const curr = wide[i]!;
      const step = curr - prev;
      if (curr <= 150) {
        expect(step).toBe(1);
      } else if (curr <= 200) {
        expect(step).toBe(2.5);
      } else {
        expect(step).toBe(5);
      }
    }

    // Sub-$150 zone (spot = 100 -> [80..120], all $1 steps)
    const low = generateOccEquityStrikes(100);
    expect(low[0]).toBe(80);
    expect(low[low.length - 1]).toBe(120);
    expect(low.length).toBe(41);

    // Above-$200 zone (spot = 250 -> [200..300], all $5 steps)
    const high = generateOccEquityStrikes(250);
    expect(high[0]).toBe(200);
    expect(high[high.length - 1]).toBe(300);
    expect(high.length).toBe(21);

    // Edge boundary spot where minStrike = 150.4 snaps down to 150 cleanly
    const boundary = generateOccEquityStrikes(188);
    expect(boundary[0]).toBe(150);
    expect(boundary[1]).toBe(152.5);

    // Non-positive spot guard
    expect(generateOccEquityStrikes(0)).toEqual([]);
    expect(generateOccEquityStrikes(-10)).toEqual([]);
  });

  it("computes deterministic Mon/Wed/Fri DAILY and Friday WEEKLY US equity expiries (lead time, weekends, holidays, DST, listedDates)", () => {
    const utcSec = (iso: string) => Math.floor(Date.parse(iso) / 1000);

    // 1. Weekday M/W/F with >= 8h lead time vs < 8h lead time
    // Wed 2026-12-02 12:00 UTC -> 9h before 21:00 UTC -> same day Wed 2026-12-02 21:00 UTC
    expect(
      getNextUsEquityOptionExpiry(utcSec("2026-12-02T12:00:00Z"), "DAILY", 21)
    ).toBe(utcSec("2026-12-02T21:00:00Z"));

    // Wed 2026-12-02 13:01 UTC -> 7h59m (< 8h) -> rolls to Fri 2026-12-04 21:00 UTC
    expect(
      getNextUsEquityOptionExpiry(utcSec("2026-12-02T13:01:00Z"), "DAILY", 21)
    ).toBe(utcSec("2026-12-04T21:00:00Z"));

    // 2. Weekend rollover (Saturday & Sunday -> Monday 21:00 UTC)
    expect(
      getNextUsEquityOptionExpiry(utcSec("2026-11-28T15:00:00Z"), "DAILY", 21)
    ).toBe(utcSec("2026-11-30T21:00:00Z"));
    expect(
      getNextUsEquityOptionExpiry(utcSec("2026-11-29T18:00:00Z"), "DAILY", 21)
    ).toBe(utcSec("2026-11-30T21:00:00Z"));

    // 3. WEEKLY Friday >= 72h lead time
    // Tue 2026-12-01 12:00 UTC -> Fri 2026-12-04 21:00 UTC is 81h (>= 72h)
    expect(
      getNextUsEquityOptionExpiry(utcSec("2026-12-01T12:00:00Z"), "WEEKLY", 21)
    ).toBe(utcSec("2026-12-04T21:00:00Z"));
    // Wed 2026-12-02 12:00 UTC -> Fri 2026-12-04 21:00 UTC is 57h (< 72h) -> next Fri 2026-12-11 21:00 UTC
    expect(
      getNextUsEquityOptionExpiry(utcSec("2026-12-02T12:00:00Z"), "WEEKLY", 21)
    ).toBe(utcSec("2026-12-11T21:00:00Z"));

    // 4. US Market Holidays:
    // MLK Day Mon 2026-01-19 is a holiday -> Sun 2026-01-18 DAILY skips Mon to Wed 2026-01-21
    expect(isUsEquityMarketHoliday(new Date("2026-01-19T00:00:00Z"))).toBe(true);
    expect(
      getNextUsEquityOptionExpiry(utcSec("2026-01-18T12:00:00Z"), "DAILY", 21)
    ).toBe(utcSec("2026-01-21T21:00:00Z"));

    // Good Friday 2026-04-03: OCC rule moves Friday expiry to preceding trading day Thu 2026-04-02
    expect(isUsEquityMarketHoliday(new Date("2026-04-03T00:00:00Z"))).toBe(true);
    expect(
      getNextUsEquityOptionExpiry(utcSec("2026-04-01T15:00:00Z"), "DAILY", 20)
    ).toBe(utcSec("2026-04-02T20:00:00Z"));
    // Once within <8h of Thu 2026-04-02 20:00 UTC, DAILY rolls to Mon 2026-04-06
    expect(
      getNextUsEquityOptionExpiry(utcSec("2026-04-02T14:00:00Z"), "DAILY", 20)
    ).toBe(utcSec("2026-04-06T20:00:00Z"));
    expect(
      getNextUsEquityOptionExpiry(utcSec("2026-03-30T12:00:00Z"), "WEEKLY", 20)
    ).toBe(utcSec("2026-04-02T20:00:00Z"));

    // Christmas Friday 2026-12-25 & New Year Friday 2027-01-01 -> holiday-adjusted Thu 12-24 & Thu 12-31 for both DAILY & WEEKLY
    expect(
      getNextUsEquityOptionExpiry(utcSec("2026-12-23T13:00:01Z"), "DAILY", 21)
    ).toBe(utcSec("2026-12-24T21:00:00Z"));
    expect(
      getNextUsEquityOptionExpiry(utcSec("2026-12-30T14:00:00Z"), "DAILY", 21)
    ).toBe(utcSec("2026-12-31T21:00:00Z"));
    expect(
      getNextUsEquityOptionExpiry(utcSec("2026-12-21T12:00:00Z"), "WEEKLY", 21)
    ).toBe(utcSec("2026-12-24T21:00:00Z"));
    expect(
      getNextUsEquityOptionExpiry(utcSec("2026-12-27T12:00:00Z"), "WEEKLY", 21)
    ).toBe(utcSec("2026-12-31T21:00:00Z"));

    // Independence Day 2026 (Sat Jul 4 -> observed Fri Jul 3) -> holiday-adjusted Thu 2026-07-02
    expect(isUsEquityMarketHoliday(new Date("2026-07-03T00:00:00Z"))).toBe(true);
    expect(
      getNextUsEquityOptionExpiry(utcSec("2026-06-29T12:00:00Z"), "WEEKLY", 20)
    ).toBe(utcSec("2026-07-02T20:00:00Z"));

    // 5. ThetaData listedDates override (supports both YYYY-MM-DD and YYYYMMDD)
    const listed = [
      "2026-11-27",
      "20261130",
      "2026-12-02",
      "2026-12-04",
      "2026-12-24",
    ];
    // Fri 11-27 14:00 UTC (< 8h to 21:00) -> selects next listed Mon 11-30
    expect(
      getNextUsEquityOptionExpiry(
        utcSec("2026-11-27T14:00:00Z"),
        "DAILY",
        21,
        listed
      )
    ).toBe(utcSec("2026-11-30T21:00:00Z"));
    // WEEKLY picks listed Fri 12-04 (>= 72h)
    expect(
      getNextUsEquityOptionExpiry(
        utcSec("2026-11-27T14:00:00Z"),
        "WEEKLY",
        21,
        listed
      )
    ).toBe(utcSec("2026-12-04T21:00:00Z"));
    // WEEKLY recognizes holiday-adjusted listed Thu 2026-12-24 (Fri 12-25 is Christmas)
    expect(
      getNextUsEquityOptionExpiry(
        utcSec("2026-12-20T12:00:00Z"),
        "WEEKLY",
        21,
        listed
      )
    ).toBe(utcSec("2026-12-24T21:00:00Z"));
  });

  it("formats settlement labels with dynamic UTC+8 hour rollover", () => {
    const utcSec = (iso: string) => Math.floor(Date.parse(iso) / 1000);
    // BTC / ETH: 08:00 UTC -> 16:00 UTC+8
    expect(formatSettlementLabel(utcSec("2026-11-27T08:00:00Z"))).toBe(
      "11-27 08:00 UTC (16:00 UTC+8)"
    );
    // NVDAB EST: 21:00 UTC -> 05:00 UTC+8 (rollover past midnight)
    expect(formatSettlementLabel(utcSec("2026-11-27T21:00:00Z"))).toBe(
      "11-27 21:00 UTC (05:00 UTC+8)"
    );
    // NVDAB EDT (DST): 20:00 UTC -> 04:00 UTC+8
    expect(formatSettlementLabel(utcSec("2026-07-02T20:00:00Z"))).toBe(
      "07-02 20:00 UTC (04:00 UTC+8)"
    );
    // Exact midnight rollover: 16:00 UTC -> 00:00 UTC+8
    expect(formatSettlementLabel(utcSec("2026-11-27T16:00:00Z"))).toBe(
      "11-27 16:00 UTC (00:00 UTC+8)"
    );
  });
});

describe("@payoff/shared Guardrail 4 (OTM/ITM fair bounds), Custom auto-clamping & preview", () => {
  it("enforces OTM/ITM fair-pricing bounds and extended ±30% OCC strike coverage", () => {
    const spot = 149.41;
    const wideOcc = generateOccEquityStrikes(spot, 0.3);
    expect(wideOcc).toContain(170);
    expect(wideOcc).toContain(190);
    expect(wideOcc[0]).toBeLessThanOrEqual(105);
    expect(wideOcc[wideOcc.length - 1]).toBeGreaterThanOrEqual(195);

    // Extreme OTM NVDA Weekly ($175 -> $195 at low IV 0.52) is trapped by 0.04W/0.045W floor -> must reject
    const extremeOtm = validateCustomSpreadRange({
      underlying: "NVDAB",
      isCall: true,
      spot,
      lowerStrike: 175,
      upperStrike: 195,
      tenor: "WEEKLY",
      hoursToExpiry: 144,
      atmIv: 0.52,
      availableStrikes: wideOcc,
      maxMultiplier: 21.37,
      shortLegSubsidyRatio: 0.12,
    });
    expect(extremeOtm.valid).toBe(false);
    expect(extremeOtm.withinFairBounds).toBe(false);
    expect(extremeOtm.rawFairRatio).toBeLessThan(0.045);

    // High-IV NVDA Weekly ($170 -> $190 at IV 0.85, 168h) sits cleanly inside fair pricing bounds (~5.7% fair ratio, ~15.8x)
    const fairHighConviction = validateCustomSpreadRange({
      underlying: "NVDAB",
      isCall: true,
      spot,
      lowerStrike: 170,
      upperStrike: 190,
      tenor: "WEEKLY",
      hoursToExpiry: 168,
      atmIv: 0.85,
      availableStrikes: wideOcc,
      maxMultiplier: 15.8,
      shortLegSubsidyRatio: 0.25,
    });
    expect(fairHighConviction.valid).toBe(true);
    expect(fairHighConviction.withinFairBounds).toBe(true);
    expect(fairHighConviction.rawFairRatio).toBeGreaterThanOrEqual(0.045);

    // Extreme ITM (< 1.12x) rejects while still setting lowMultiplierWarning
    const extremeItm = validateCustomSpreadRange({
      underlying: "NVDAB",
      isCall: true,
      spot,
      lowerStrike: 125,
      upperStrike: 135,
      tenor: "WEEKLY",
      hoursToExpiry: 144,
      atmIv: 0.52,
      availableStrikes: wideOcc,
      maxMultiplier: 1.06,
      shortLegSubsidyRatio: 0.9,
    });
    expect(extremeItm.valid).toBe(false);
    expect(extremeItm.withinFairBounds).toBe(false);
    expect(extremeItm.lowMultiplierWarning).toBe(true);

    // Symmetry check: call + put unclamped fair ratios sum to 1.0
    const callRatio = computeUnclampedSpreadFairRatio({
      isCall: true,
      spot,
      lowerStrike: 150,
      upperStrike: 170,
      hoursToExpiry: 144,
      atmIv: 0.52,
    });
    const putRatio = computeUnclampedSpreadFairRatio({
      isCall: false,
      spot,
      lowerStrike: 150,
      upperStrike: 170,
      hoursToExpiry: 144,
      atmIv: 0.52,
    });
    expect(callRatio + putRatio).toBeCloseTo(1, 8);
    expect(computeMaxAllowedWidthPct("DAILY", 24, 0.52)).toBeCloseTo(7.2, 2);
    expect(computeMaxAllowedWidthPct("WEEKLY", 144, 0.52)).toBeGreaterThanOrEqual(14.0);
  });

  it("auto-clamps Custom Start/Target cap selections for width cap, OTM/ITM fair bounds, and ordering (BULL & BEAR)", () => {
    const bullConfig: CustomRangeConfig = {
      validStarts: [130, 140, 150, 160, 165],
      validCapsByStart: {
        "130": [149, 150], // closer caps too deep ITM (<1.15x)
        "140": [145, 150, 155, 160], // $160 is width cap (~13.4%)
        "150": [152.5, 155, 160, 165, 170],
        "160": [162.5, 165, 170, 175], // stops at $175 due to OTM fair limit (10% < 14.7% width cap)
        "165": [167.5],
      },
      defaultStart: 150,
      defaultCap: 160,
      maxAllowedWidthPct: 14.7,
      minMultiplier: 1.15,
      maxMultiplier: 20,
      pricingParams: {
        spot: 149.41,
        hoursToExpiry: 144,
        baseIv: 0.52,
        effectiveIv: 0.52,
        varianceTimeScale: 1,
        spreadMultiplier: 1,
        protocolFeeBps: 400,
        mmOpenMarkupBps: 110,
      },
    };

    // 1. Valid pair passes untouched
    const unchanged = resolveClampedCustomRange({
      config: bullConfig,
      direction: "BULL",
      desiredStart: 150,
      desiredCap: 165,
    });
    expect(unchanged).toMatchObject({
      startPrice: 150,
      capPrice: 165,
      lowerStrike: 150,
      upperStrike: 165,
      capClamped: false,
      clampReason: "NONE",
    });

    // 2. Lowering Start to 140 while keeping Cap 170 exceeds 14.7% width cap -> clamps to 160 (WIDTH_CAP)
    const widthClamped = resolveClampedCustomRange({
      config: bullConfig,
      direction: "BULL",
      desiredStart: 140,
      desiredCap: 170,
    });
    expect(widthClamped).toMatchObject({
      startPrice: 140,
      capPrice: 160,
      capClamped: true,
      clampReason: "WIDTH_CAP",
    });

    // 3. Raising Start to 160 while keeping Cap 180 is within width cap (13.4% <= 14.7%) but hits OTM fair limit -> clamps to 175 (OTM_FAIR_LIMIT)
    const otmClamped = resolveClampedCustomRange({
      config: bullConfig,
      direction: "BULL",
      desiredStart: 160,
      desiredCap: 180,
    });
    expect(otmClamped).toMatchObject({
      startPrice: 160,
      capPrice: 175,
      capClamped: true,
      clampReason: "OTM_FAIR_LIMIT",
    });

    // 4. Lowering Start to 130 with Cap 140 hits ITM fair floor (<1.15x) -> clamps up to 149 (ITM_FAIR_LIMIT)
    const itmClamped = resolveClampedCustomRange({
      config: bullConfig,
      direction: "BULL",
      desiredStart: 130,
      desiredCap: 140,
    });
    expect(itmClamped).toMatchObject({
      startPrice: 130,
      capPrice: 149,
      capClamped: true,
      clampReason: "ITM_FAIR_LIMIT",
    });

    // 5. Raising Start to 165 past old Cap 160 -> shifts Cap above Start (ORDERING)
    const orderingClamped = resolveClampedCustomRange({
      config: bullConfig,
      direction: "BULL",
      desiredStart: 165,
      desiredCap: 160,
    });
    expect(orderingClamped).toMatchObject({
      startPrice: 165,
      capPrice: 167.5,
      capClamped: true,
      clampReason: "ORDERING",
    });

    // 6. BEAR direction ordering & lower/upper strike inversion
    const bearConfig: CustomRangeConfig = {
      ...bullConfig,
      validStarts: [165, 150, 135],
      validCapsByStart: {
        "165": [150, 145],
        "150": [149, 145, 140, 130],
        "135": [134, 133],
      },
      defaultStart: 150,
      defaultCap: 140,
    };
    const bearOrder = resolveClampedCustomRange({
      config: bearConfig,
      direction: "BEAR",
      desiredStart: 135,
      desiredCap: 140,
    });
    expect(bearOrder).toMatchObject({
      startPrice: 135,
      capPrice: 134,
      lowerStrike: 134,
      upperStrike: 135,
      capClamped: true,
      clampReason: "ORDERING",
    });

    // 7. Empty config returns null safely
    expect(
      resolveClampedCustomRange({
        config: { ...bullConfig, validStarts: [] },
        direction: "BULL",
        desiredStart: 150,
        desiredCap: 160,
      })
    ).toBeNull();

    // 8. Start-only clamping reports exact OTM/ITM/STRIKE_ALIGN reason (never "NONE")
    const startOtmOnly = resolveClampedCustomRange({
      config: bullConfig,
      direction: "BULL",
      desiredStart: 175, // above last validStart 165, while cap 167.5 remains valid for 165
      desiredCap: 167.5,
    });
    expect(startOtmOnly).toMatchObject({
      startPrice: 165,
      capPrice: 167.5,
      startClamped: true,
      capClamped: false,
      clampReason: "OTM_FAIR_LIMIT",
    });

    const startItmOnly = resolveClampedCustomRange({
      config: bullConfig,
      direction: "BULL",
      desiredStart: 120, // below first validStart 130, while cap 150 remains valid for 130
      desiredCap: 150,
    });
    expect(startItmOnly).toMatchObject({
      startPrice: 130,
      capPrice: 150,
      startClamped: true,
      capClamped: false,
      clampReason: "ITM_FAIR_LIMIT",
    });

    // 9. Unaligned cap strictly between OTM start and firstCap reports STRIKE_ALIGN (not ITM_FAIR_LIMIT)
    const unalignedOtmCap = resolveClampedCustomRange({
      config: bullConfig,
      direction: "BULL",
      desiredStart: 165,
      desiredCap: 166, // off-grid between 165 and 167.5 on an OTM spread
    });
    expect(unalignedOtmCap).toMatchObject({
      startPrice: 165,
      capPrice: 167.5,
      capClamped: true,
      clampReason: "STRIKE_ALIGN",
    });

    // 10. Synchronous preview estimator produces valid ticket matching Custom range (including skewed strikeIvs)
    const preview = estimateCustomTicketPreview({
      underlying: "NVDAB",
      direction: "BULL",
      tenor: "WEEKLY",
      expiry: 1_795_813_200,
      availableStrikes: generateOccEquityStrikes(149.41, 0.3),
      lowerStrike: 155,
      upperStrike: 175,
      stakeUsdt: 20,
      config: bullConfig,
    });
    expect(preview.tierKind).toBe("CUSTOM");
    expect(preview.startPrice).toBe(155);
    expect(preview.capPrice).toBe(175);
    expect(preview.guardrails.valid).toBe(true);
    expect(preview.maxMultiplier).toBeGreaterThan(5);
    expect(preview.maxMultiplier).toBeLessThan(20);

    // Put-wing skew: elevated strike IVs keep BEAR [128, 135] valid (~14x) instead of falsely clamping at ~21.37x
    const skewedBearConfig: CustomRangeConfig = {
      ...bearConfig,
      pricingParams: {
        ...bearConfig.pricingParams,
        baseIv: 0.55,
        effectiveIv: 0.55,
        ivFloorBoost: 0,
        strikeIvs: { "128": 0.68, "135": 0.63 },
      },
    };
    const skewedBearPreview = estimateCustomTicketPreview({
      underlying: "NVDAB",
      direction: "BEAR",
      tenor: "WEEKLY",
      expiry: 1_795_813_200,
      availableStrikes: generateOccEquityStrikes(149.41, 0.3),
      lowerStrike: 128,
      upperStrike: 135,
      stakeUsdt: 20,
      config: skewedBearConfig,
    });
    expect(skewedBearPreview.guardrails.valid).toBe(true);
    expect(skewedBearPreview.maxMultiplier).toBeGreaterThan(10);
    expect(skewedBearPreview.maxMultiplier).toBeLessThan(18);
  });
});

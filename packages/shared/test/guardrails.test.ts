import { describe, expect, it } from "vitest";
import { validateCustomSpreadRange } from "../src/index.js";

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
});

import { describe, expect, it } from "vitest";
import {
  ASSET_BTC_ID,
  ASSET_ETH_ID,
  ASSET_IDS,
  ATLAS_FEEDS,
  ATLAS_MAGIC_MARKER,
  ATLAS_OFFICIAL_SIGNER,
  ATLAS_SETTLEMENT_ORACLE_ABI,
  BSC_TESTNET,
  MOCK_USDT_ABI,
  PAYOFF_LENS_ABI,
  PAYOFF_VAULT_ABI,
  USDT_DECIMALS,
  USDT_SCALE,
  assetIdToSymbol,
  bsOptionPrice,
  computeDownTokenId,
  computeExpiryPayoffUsdt,
  computeProtocolFee,
  computeSeriesId,
  computeSettlementKey,
  computeTicketNumbers,
  computeTokenId,
  computeUpTokenId,
  evaluateSpreadHedgeRoutes,
  symbolToAssetId,
  unitsToUsdt,
  usdtToUnits,
  type GuardrailResult,
  type OptionStrikeQuote,
} from "../src/index.js";

const okGuardrails: GuardrailResult = {
  valid: true,
  errors: [],
  warnings: [],
  strikeAligned: true,
  widthWithinCap: true,
  widthPct: 3.0,
  maxAllowedWidthPct: 4.5,
  shortLegSubsidyRatio: 0.3,
  lowMultiplierWarning: false,
};

describe("@payoff/shared BSC Testnet, Atlas & math", () => {
  it("exports BSC Testnet, Atlas feeds, and USDT constants", () => {
    expect(BSC_TESTNET.chainId).toBe(97);
    expect(BSC_TESTNET.nativeSymbol).toBe("tBNB");
    expect(BSC_TESTNET.usdtDecimals).toBe(6);
    expect(USDT_DECIMALS).toBe(6);
    expect(USDT_SCALE).toBe(1_000_000n);
    expect(ATLAS_FEEDS.BTC).toEqual({
      feedId: "626",
      feedIdHex: "0x00000272",
      pair: "BTC/USD",
    });
    expect(ATLAS_FEEDS.ETH).toEqual({
      feedId: "632",
      feedIdHex: "0x00000278",
      pair: "ETH/USD",
    });
    expect(ATLAS_OFFICIAL_SIGNER).toBe(
      "0x59eD4701224fD9e2a85Ef2946c2ab828C1dDC600"
    );
    expect(ATLAS_MAGIC_MARKER).toBe("0x7096");
    expect(ASSET_IDS.BTC).toBe(ASSET_BTC_ID);
    expect(ASSET_IDS.ETH).toBe(ASSET_ETH_ID);
    expect(MOCK_USDT_ABI.length).toBeGreaterThan(10);
    expect(ATLAS_SETTLEMENT_ORACLE_ABI.length).toBeGreaterThan(10);
    expect(PAYOFF_VAULT_ABI.length).toBeGreaterThan(20);
    expect(PAYOFF_LENS_ABI.length).toBe(4);
  });

  it("computes protocol fee matching Solidity Math.mulDiv(userPayAmount, bps, 10000 + bps)", () => {
    // 20 USDT (20_000_000) with 400 bps (4%)
    const userPay = usdtToUnits(20);
    expect(userPay).toBe(20_000_000n);
    expect(unitsToUsdt(userPay)).toBe(20);
    const fee = computeProtocolFee(userPay, 400);
    expect(fee).toBe((20_000_000n * 400n) / 10_400n);
    expect(fee).toBe(769_230n);
  });

  it("reproduces $90k -> $92.7k ticket example numbers", () => {
    const summary = computeTicketNumbers({
      tierKind: "STANDARD",
      tierLabel: "标准短线档",
      underlying: "BTC",
      direction: "BULL",
      tenor: "DAILY",
      spot: 90_000,
      lowerStrike: 90_000,
      upperStrike: 92_700,
      expiry: 1795507200,
      hoursToExpiry: 24,
      atmIv: 0.61,
      stakeUsdt: 20,
      maxPayoutUsdt: 53.54,
      nakedSingleLegCostUsdt: 23.7,
      guardrails: okGuardrails,
    });

    expect(summary.maxMultiplier).toBeCloseTo(2.68, 2);
    expect(summary.breakevenPrice).toBeCloseTo(91008.6, 0);
    expect(summary.breakevenPct).toBeCloseTo(1.12, 1);
    expect(summary.flatPayoutUsdt).toBe(0);
    expect(summary.perp50xLiqPrice).toBeCloseTo(88290, 0);
  });

  it("reproduces $61.9k conservative, standard, and breakout examples", () => {
    // Conservative ITM: 61,000 -> 63,500, 2.02x, flat 73%
    const conservative = computeTicketNumbers({
      tierKind: "CONSERVATIVE",
      tierLabel: "稳健防归零档",
      underlying: "BTC",
      direction: "BULL",
      tenor: "DAILY",
      spot: 61_900,
      lowerStrike: 61_000,
      upperStrike: 63_500,
      expiry: 1795507200,
      hoursToExpiry: 24,
      atmIv: 0.6,
      stakeUsdt: 20,
      maxPayoutUsdt: 40.4,
      nakedSingleLegCostUsdt: 26.0,
      guardrails: okGuardrails,
    });
    expect(conservative.maxMultiplier).toBeCloseTo(2.02, 2);
    expect(conservative.breakevenPct).toBeCloseTo(0.55, 1);
    expect(conservative.flatReturnPct).toBeCloseTo(72.7, 0);

    // Breakout OTM: 63,000 -> 65,000, $20 -> $117.9 (5.89x)
    const breakout = computeTicketNumbers({
      tierKind: "BREAKOUT",
      tierLabel: "突破翻倍彩票",
      underlying: "BTC",
      direction: "BULL",
      tenor: "DAILY",
      spot: 61_900,
      lowerStrike: 63_000,
      upperStrike: 65_000,
      expiry: 1795507200,
      hoursToExpiry: 24,
      atmIv: 0.6,
      stakeUsdt: 20,
      maxPayoutUsdt: 117.9,
      nakedSingleLegCostUsdt: 28.0,
      guardrails: okGuardrails,
    });
    expect(breakout.maxMultiplier).toBeCloseTo(5.9, 1);
    expect(breakout.breakevenPrice).toBeCloseTo(63339, 0);
    expect(breakout.breakevenPct).toBeCloseTo(2.33, 1);
  });

  it("switches to put-call parity hedge when ITM call spread has wider spreads than OTM put spread", () => {
    const spot = 61_900;
    const T = 24 / (365 * 24);
    const iv = 0.6;

    const makeQuote = (k: number, wideCallSpread: boolean): OptionStrikeQuote => {
      const cMid = bsOptionPrice(true, spot, k, T, iv);
      const pMid = bsOptionPrice(false, spot, k, T, iv);
      const cHalf = wideCallSpread ? 45 : 10;
      const pHalf = wideCallSpread ? 8 : 10;
      return {
        strike: k,
        call: {
          strike: k,
          instId: `BTC-USD-261124-${k}-C`,
          bidUsd: Math.max(0, cMid - cHalf),
          askUsd: cMid + cHalf,
          markUsd: cMid,
          iv,
          bidSize: 50,
          askSize: 50,
        },
        put: {
          strike: k,
          instId: `BTC-USD-261124-${k}-P`,
          bidUsd: Math.max(0, pMid - pHalf),
          askUsd: pMid + pHalf,
          markUsd: pMid,
          iv,
          bidSize: 50,
          askSize: 50,
        },
      };
    };

    const lower = makeQuote(60_000, true); // deep ITM call, OTM put
    const upper = makeQuote(62_500, true);

    const evalOpen = evaluateSpreadHedgeRoutes({
      venue: "MOCK_MAKER",
      spotUsd: spot,
      isCall: true,
      lowerQuote: lower,
      upperQuote: upper,
      notionalUnderlying: 0.01,
      side: "OPEN",
    });

    expect(evalOpen.isParityFlip).toBe(true);
    expect(evalOpen.route).toBe("PARITY_PUT_SPREAD");
    expect(evalOpen.paritySavedUsd).toBeGreaterThan(0);
    expect(evalOpen.longLegInstId).toContain("-P");
    expect(evalOpen.shortLegInstId).toContain("-P");
  });

  it("computes consistent expiry payoff and EIP-712 seriesId / tokenIds", () => {
    expect(computeExpiryPayoffUsdt(true, 62000, 64000, 100, 61000)).toBe(0);
    expect(computeExpiryPayoffUsdt(true, 62000, 64000, 100, 63000)).toBe(50);
    expect(computeExpiryPayoffUsdt(true, 62000, 64000, 100, 65000)).toBe(100);

    expect(computeExpiryPayoffUsdt(false, 60000, 62000, 100, 63000)).toBe(0);
    expect(computeExpiryPayoffUsdt(false, 60000, 62000, 100, 61000)).toBe(50);
    expect(computeExpiryPayoffUsdt(false, 60000, 62000, 100, 59000)).toBe(100);

    const sid = computeSeriesId(
      ASSET_BTC_ID,
      62000_00000000n,
      64000_00000000n,
      1795507200
    );
    const upId = computeUpTokenId(sid);
    const downId = computeDownTokenId(sid);
    expect((upId & 1n) === 0n).toBe(true);
    expect((downId & 1n) === 1n).toBe(true);
    expect(downId - upId).toBe(1n);
    expect(computeTokenId(sid, true)).toBe(upId);
    expect(computeTokenId(sid, false)).toBe(downId);

    // Asset ID conversions & settlement key
    expect(symbolToAssetId("BTC")).toBe(ASSET_BTC_ID);
    expect(symbolToAssetId("ETH")).toBe(ASSET_ETH_ID);
    expect(assetIdToSymbol(ASSET_BTC_ID)).toBe("BTC");
    expect(assetIdToSymbol(ASSET_ETH_ID)).toBe("ETH");
    expect(computeSettlementKey(ASSET_BTC_ID, 1795507200)).toMatch(
      /^0x[0-9a-f]{64}$/
    );
  });
});

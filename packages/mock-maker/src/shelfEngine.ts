import {
  bsOptionPrice,
  computeTicketNumbers,
  evaluateSpreadHedgeRoutes,
  validateCustomSpreadRange,
  type AtlasFeedTelemetry,
  type Direction,
  type ExpiryBook,
  type ExpiryTenor,
  type FixedGridMeta,
  type HedgeEvaluation,
  type OptionLegQuote,
  type TicketSummary,
  type TierKind,
  type UnderlyingSymbol,
  type VenueName,
} from "@payoff/shared";

export const DEFAULT_MM_OPEN_MARKUP_BPS = 110;

export interface GridConfigEntry {
  step: number;
  hysteresis: number;
  offsets: readonly number[];
  defaultSlot: number;
}

export const GRID_CONFIG: Record<
  `${UnderlyingSymbol}:${ExpiryTenor}`,
  GridConfigEntry
> = {
  "BTC:DAILY": {
    step: 500,
    hysteresis: 125,
    offsets: [1, 2, 4, 6],
    defaultSlot: 1,
  },
  "BTC:WEEKLY": {
    step: 500,
    hysteresis: 125,
    offsets: [2, 4, 8, 12],
    defaultSlot: 1,
  },
  "ETH:DAILY": {
    step: 25,
    hysteresis: 6,
    offsets: [1, 2, 3, 4],
    defaultSlot: 1,
  },
  "ETH:WEEKLY": {
    step: 50,
    hysteresis: 12,
    offsets: [1, 2, 3, 4],
    defaultSlot: 1,
  },
};

export interface ConsensusRiskAdjustment {
  quotingAllowed: boolean;
  spreadMultiplier: number;
  ivFloorBoost: number;
  reason: string;
}

const fixedGridCache = new Map<string, { gridLow: number; gridHigh: number }>();

/** Clears the in-memory fixed-grid hysteresis cache (primarily for unit tests). */
export function resetFixedGridCache(): void {
  fixedGridCache.clear();
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function validIv(iv: number | undefined): number | null {
  return typeof iv === "number" && Number.isFinite(iv) && iv > 0.05 && iv < 5.0
    ? iv
    : null;
}

function legMidAndSpreadRatio(
  leg: OptionLegQuote | undefined
): { mid: number; spreadRatio: number } | null {
  if (!leg) return null;
  const { bidUsd, askUsd } = leg;
  if (
    !Number.isFinite(bidUsd) ||
    !Number.isFinite(askUsd) ||
    bidUsd <= 0 ||
    askUsd < bidUsd
  ) {
    return null;
  }
  const mid = (bidUsd + askUsd) / 2;
  if (mid <= 0) return null;
  return {
    mid,
    spreadRatio: (askUsd - bidUsd) / mid,
  };
}

/**
 * Translates live Atlas Enterprise `ConsensusScore` and `priceVolatility` telemetry
 * into deterministic risk adjustments for the Reference / Mock Market Maker:
 *
 * - `HEALTHY` (score >= 0.70): normal quoting (`spreadMultiplier = 1.0`, volatility boost only if `priceVolatility` spikes)
 * - `DEGRADED` (or low score < 0.70): widens spread (`1.35x`) and raises IV floor (`>= +0.05`)
 * - `WARNING`: widens spread aggressively (`1.85x` - `2.0x`) and raises IV floor (`>= +0.12`)
 * - `CRITICAL` / `SPLIT_MARKET`: triggers OpenQuote quoting circuit breaker (`quotingAllowed = false`)
 *   while CloseQuote exits remain available with conservative exit spread (`2.5x` - `3.0x`).
 */
export function computeConsensusRiskAdjustments(
  telemetry?: AtlasFeedTelemetry
): ConsensusRiskAdjustment {
  if (!telemetry) {
    return {
      quotingAllowed: true,
      spreadMultiplier: 1.0,
      ivFloorBoost: 0,
      reason: "No live Atlas telemetry supplied; baseline risk parameters active",
    };
  }

  const rawVol =
    telemetry.priceVolatility !== null &&
    Number.isFinite(telemetry.priceVolatility) &&
    telemetry.priceVolatility > 0
      ? telemetry.priceVolatility
      : 0;

  // Trigger IV floor boost whenever short-window Atlas priceVolatility exceeds 0.5%
  const volBoost =
    rawVol > 0.005 ? Number(clamp((rawVol - 0.005) * 4.0, 0.02, 0.5).toFixed(4)) : 0;

  const score =
    telemetry.consensusScore !== null && Number.isFinite(telemetry.consensusScore)
      ? telemetry.consensusScore
      : null;

  switch (telemetry.consensusStatus) {
    case "CRITICAL":
      return {
        quotingAllowed: false,
        spreadMultiplier: 2.75,
        ivFloorBoost: Math.max(volBoost, 0.25),
        reason:
          "Atlas ConsensusScore is CRITICAL — new OpenQuote signing halted by circuit breaker",
      };
    case "SPLIT_MARKET":
      return {
        quotingAllowed: false,
        spreadMultiplier: 3.0,
        ivFloorBoost: Math.max(volBoost, 0.3),
        reason:
          "Atlas ConsensusScore detected SPLIT_MARKET — new OpenQuote signing halted by circuit breaker",
      };
    case "WARNING": {
      const spreadMultiplier = score !== null && score < 0.7 ? 2.0 : 1.85;
      return {
        quotingAllowed: true,
        spreadMultiplier,
        ivFloorBoost: Math.max(volBoost, 0.12),
        reason: `Atlas ConsensusScore WARNING${score !== null ? ` (${(score * 100).toFixed(1)}%)` : ""} — widened spread (${spreadMultiplier}x) and elevated IV floor`,
      };
    }
    case "DEGRADED":
      return {
        quotingAllowed: true,
        spreadMultiplier: 1.35,
        ivFloorBoost: Math.max(volBoost, 0.05),
        reason: `Atlas ConsensusScore DEGRADED${score !== null ? ` (${(score * 100).toFixed(1)}%)` : ""} — widened mock maker spread (1.35x)`,
      };
    case "HEALTHY": {
      if (score !== null && score < 0.7) {
        return {
          quotingAllowed: true,
          spreadMultiplier: 1.35,
          ivFloorBoost: Math.max(volBoost, 0.05),
          reason: `Atlas consensusScore below 70% (${(score * 100).toFixed(1)}%) — defensive spread widening applied`,
        };
      }
      if (volBoost > 0) {
        return {
          quotingAllowed: true,
          spreadMultiplier: 1.15,
          ivFloorBoost: volBoost,
          reason: `Atlas HEALTHY with elevated priceVolatility (${(rawVol * 100).toFixed(2)}%) — IV floor boosted by +${(volBoost * 100).toFixed(1)}%`,
        };
      }
      return {
        quotingAllowed: true,
        spreadMultiplier: 1.0,
        ivFloorBoost: 0,
        reason: "Atlas ConsensusScore HEALTHY — standard quoting active",
      };
    }
    case "UNKNOWN":
    default:
      return {
        quotingAllowed: true,
        spreadMultiplier: 1.1,
        ivFloorBoost: volBoost,
        reason:
          "Atlas ConsensusScore UNKNOWN — applying 1.10x conservative spread buffer",
      };
  }
}

/**
 * Computes the no-arbitrage fair mid price per 1.0 unit of spread `[lowerStrike, upperStrike]`
 * using European Black-Scholes anchored on live Atlas Oracle spot and synthetic reference quotes.
 *
 * Enforces strict Put-Call Parity:
 *   computeFairSpreadUnitUsd(book, true, K1, K2) + computeFairSpreadUnitUsd(book, false, K1, K2) === K2 - K1
 * with both sides clamped to `[0.04 * width, 0.96 * width]`.
 */
export function computeFairSpreadUnitUsd(
  book: ExpiryBook,
  isCall: boolean,
  lowerStrike: number,
  upperStrike: number,
  hoursRemainingOverride?: number,
  atlasTelemetry?: AtlasFeedTelemetry
): number {
  const width = upperStrike - lowerStrike;
  if (width <= 0) return 0;

  const hours = hoursRemainingOverride ?? book.hoursToExpiry;
  const T = Math.max(hours, 0.25) / (365 * 24);
  const useReferenceBook =
    hoursRemainingOverride === undefined ||
    Math.abs(book.hoursToExpiry - hoursRemainingOverride) < 4;

  const lq = useReferenceBook ? book.syntheticStrikes[lowerStrike] : undefined;
  const uq = useReferenceBook ? book.syntheticStrikes[upperStrike] : undefined;

  // Symmetric strike IV average across call & put legs so Put-Call Parity holds identically
  const lowerIvs = [validIv(lq?.call.iv), validIv(lq?.put.iv)].filter(
    (v): v is number => v !== null
  );
  const upperIvs = [validIv(uq?.call.iv), validIv(uq?.put.iv)].filter(
    (v): v is number => v !== null
  );
  const strikeIvs: number[] = [];
  if (lowerIvs.length > 0) {
    strikeIvs.push(lowerIvs.reduce((a, b) => a + b, 0) / lowerIvs.length);
  }
  if (upperIvs.length > 0) {
    strikeIvs.push(upperIvs.reduce((a, b) => a + b, 0) / upperIvs.length);
  }
  const baseIv =
    strikeIvs.length > 0
      ? strikeIvs.reduce((a, b) => a + b, 0) / strikeIvs.length
      : book.atmIv;

  const risk = computeConsensusRiskAdjustments(atlasTelemetry);
  const effectiveIv = clamp(
    Math.max(baseIv, book.atmIv + risk.ivFloorBoost),
    0.1,
    3.0
  );

  const bsCallSpread =
    bsOptionPrice(true, book.spot, lowerStrike, T, effectiveIv) -
    bsOptionPrice(true, book.spot, upperStrike, T, effectiveIv);

  let rawCallFair = bsCallSpread;

  // Anchor with tight reference book mids only under calm baseline IV
  if (lq && uq && risk.ivFloorBoost === 0) {
    const candidates: Array<{ callEqMid: number; avgSpreadRatio: number }> = [];

    const lc = legMidAndSpreadRatio(lq.call);
    const uc = legMidAndSpreadRatio(uq.call);
    if (lc && uc) {
      const avgRatio = (lc.spreadRatio + uc.spreadRatio) / 2;
      const refCallMid = lc.mid - uc.mid;
      if (avgRatio < 0.06 && refCallMid > 0 && refCallMid < width) {
        candidates.push({ callEqMid: refCallMid, avgSpreadRatio: avgRatio });
      }
    }

    const lp = legMidAndSpreadRatio(lq.put);
    const up = legMidAndSpreadRatio(uq.put);
    if (lp && up) {
      const avgRatio = (lp.spreadRatio + up.spreadRatio) / 2;
      const refPutMid = up.mid - lp.mid;
      if (avgRatio < 0.06 && refPutMid > 0 && refPutMid < width) {
        candidates.push({
          callEqMid: width - refPutMid,
          avgSpreadRatio: avgRatio,
        });
      }
    }

    if (candidates.length > 0) {
      candidates.sort((a, b) => a.avgSpreadRatio - b.avgSpreadRatio);
      const tightest = candidates[0]!;
      const boundedRef = clamp(
        tightest.callEqMid,
        bsCallSpread - 0.1 * width,
        bsCallSpread + 0.1 * width
      );
      rawCallFair = 0.5 * bsCallSpread + 0.5 * boundedRef;
    }
  }

  const clampedCallFair = clamp(rawCallFair, 0.04 * width, 0.96 * width);
  return isCall ? clampedCallFair : width - clampedCallFair;
}

/**
 * Fixed-grid inventory MM open ask per 1.0 unit of spread.
 * Strictly > fairMidUsd across `[0.04*W, 0.96*W]` so `UP_ask + DOWN_ask > width`.
 */
export function computeMmOpenUnitUsd(
  fairMidUsd: number,
  width: number,
  mmOpenMarkupBps: number,
  spreadMultiplier = 1.0
): number {
  if (width <= 0) return 0;
  const mult = Math.max(1.0, Number.isFinite(spreadMultiplier) ? spreadMultiplier : 1.0);
  const openEdge = (Math.max(0, mmOpenMarkupBps) / 10_000 + 0.0025) * mult;
  const additiveSpread = 0.003 * mult * width;
  return clamp(
    fairMidUsd * (1 + openEdge) + additiveSpread,
    0.045 * width,
    0.985 * width
  );
}

/**
 * Fixed-grid inventory MM close bid per 1.0 unit of spread.
 * Strictly < fairMidUsd across `[0.04*W, 0.96*W]` so `UP_bid + DOWN_bid < width`.
 */
export function computeMmCloseUnitUsd(
  fairMidUsd: number,
  width: number,
  spreadMultiplier = 1.0
): number {
  if (width <= 0) return 0;
  const mult = Math.max(1.0, Number.isFinite(spreadMultiplier) ? spreadMultiplier : 1.0);
  const closeEdge = Math.min(0.18, 0.014 * mult);
  const additiveHaircut = Math.min(0.06, 0.003 * mult) * width;
  return clamp(
    fairMidUsd * (1 - closeEdge) - additiveHaircut,
    0.01 * width,
    0.99 * width
  );
}

export interface PricedSpreadResult {
  summary: TicketSummary;
  venue: VenueName;
  hedge: HedgeEvaluation;
  mmMarginBps: number;
  consensusRisk: ConsensusRiskAdjustment;
}

export interface PriceSpreadParams {
  book: ExpiryBook;
  tierKind: TierKind;
  tierLabel: string;
  direction: Direction;
  lowerStrike: number;
  upperStrike: number;
  stakeUsdt: number;
  protocolFeeBps: number;
  mmOpenMarkupBps: number;
  venue?: VenueName;
  atlasTelemetry?: AtlasFeedTelemetry;
}

/**
 * Prices a vertical spread `[lowerStrike, upperStrike]` for a given `stakeUsdt`, `protocolFeeBps`,
 * and `mmOpenMarkupBps` using Put-Call Parity fair mid + Atlas ConsensusScore risk adjustments,
 * while computing Direct vs Put-Call Parity hedge route analytics for `/ops`.
 */
export function priceSpreadOnVenue(params: PriceSpreadParams): PricedSpreadResult {
  const {
    book,
    tierKind,
    tierLabel,
    direction,
    lowerStrike,
    upperStrike,
    stakeUsdt,
    protocolFeeBps,
    mmOpenMarkupBps,
    venue = "MOCK_MAKER",
    atlasTelemetry,
  } = params;

  const isCall = direction === "BULL";
  const strikeMap = book.syntheticStrikes;
  const lowerQuote = strikeMap[lowerStrike];
  const upperQuote = strikeMap[upperStrike];
  const width = upperStrike - lowerStrike;
  const consensusRisk = computeConsensusRiskAdjustments(atlasTelemetry);
  const effectiveMmMarginBps = Math.round(
    mmOpenMarkupBps * consensusRisk.spreadMultiplier
  );

  // Protocol fee subtracted from userPayAmount using exact Solidity formula
  const protocolFeeUsdt =
    (stakeUsdt * protocolFeeBps) / (10_000 + protocolFeeBps);
  const mmNetPremiumUsdt = stakeUsdt - protocolFeeUsdt;

  if (!lowerQuote || !upperQuote || width <= 0) {
    const emptyGuardrails = validateCustomSpreadRange({
      underlying: book.underlying,
      isCall,
      spot: book.spot,
      lowerStrike,
      upperStrike,
      tenor: book.tenor,
      hoursToExpiry: book.hoursToExpiry,
      atmIv: book.atmIv,
      availableStrikes: book.availableStrikes,
      maxMultiplier: 0,
      shortLegSubsidyRatio: 0,
    });
    const dummyHedge: HedgeEvaluation = {
      venue,
      route: isCall ? "DIRECT_CALL_SPREAD" : "DIRECT_PUT_SPREAD",
      isParityFlip: false,
      longLegInstId: "",
      shortLegInstId: "",
      notionalUnderlying: 0,
      rawSpreadUsd: 0,
      exchangeFeeUsd: 0,
      totalHedgeCostUsd: 0,
      directCostUsd: 0,
      parityCostUsd: 0,
      paritySavedUsd: 0,
      paritySavedPct: 0,
      shortLegSubsidyRatio: 0,
    };
    return {
      venue,
      hedge: dummyHedge,
      mmMarginBps: effectiveMmMarginBps,
      consensusRisk,
      summary: computeTicketNumbers({
        tierKind,
        tierLabel,
        underlying: book.underlying,
        direction,
        tenor: book.tenor,
        spot: book.spot,
        lowerStrike,
        upperStrike,
        expiry: book.expiry,
        hoursToExpiry: book.hoursToExpiry,
        atmIv: book.atmIv,
        stakeUsdt,
        maxPayoutUsdt: stakeUsdt,
        nakedSingleLegCostUsdt: stakeUsdt,
        guardrails: emptyGuardrails,
        recommendedHedge: dummyHedge,
      }),
    };
  }

  // Fixed-grid inventory MM open price anchored on Put-Call Parity fair mid + Atlas risk adjustments.
  // When Atlas telemetry triggers an IV floor boost, use the conservative upper fair bound across
  // [baseIv, boostedIv] so vol spikes never underprice ITM spreads while preserving UP_ask + DOWN_ask > width.
  const baseFairMidUsd = computeFairSpreadUnitUsd(
    book,
    isCall,
    lowerStrike,
    upperStrike
  );
  const adjustedFairMidUsd =
    consensusRisk.ivFloorBoost > 0
      ? computeFairSpreadUnitUsd(
          book,
          isCall,
          lowerStrike,
          upperStrike,
          undefined,
          atlasTelemetry
        )
      : baseFairMidUsd;
  const conservativeAskFairUsd = Math.max(baseFairMidUsd, adjustedFairMidUsd);
  const mmOpenUnitUsd = computeMmOpenUnitUsd(
    conservativeAskFairUsd,
    width,
    mmOpenMarkupBps,
    consensusRisk.spreadMultiplier
  );

  const notionalUnderlying = mmNetPremiumUsdt / mmOpenUnitUsd;
  const maxPayoutUsdt = Math.max(
    stakeUsdt * 1.01,
    notionalUnderlying * width
  );

  // Preserve Direct vs Put-Call Parity hedge route evaluation for recommendedHedge & /ops metrics
  const hedge = evaluateSpreadHedgeRoutes({
    venue,
    spotUsd: book.spot,
    isCall,
    lowerQuote,
    upperQuote,
    notionalUnderlying,
    side: "OPEN",
  });

  // Cost of buying the naked single long leg alone for the exact same notional exposure
  const singleLegAskUsd = isCall
    ? lowerQuote.call.askUsd
    : upperQuote.put.askUsd;
  const nakedSingleLegCostUsdt =
    singleLegAskUsd * notionalUnderlying * (1 + protocolFeeBps / 10_000);

  // Compute indicative immediate exit value consistently with estimatePositionExitUsdt
  const exitEstimate = estimatePositionExitUsdt({
    book,
    isCall,
    lowerStrike,
    upperStrike,
    remainingLongUsdt: maxPayoutUsdt,
    hoursRemaining: book.hoursToExpiry,
    atlasTelemetry,
  });

  const effectiveIv = clamp(
    book.atmIv + consensusRisk.ivFloorBoost,
    0.1,
    3.0
  );
  const maxMultiplier = maxPayoutUsdt / stakeUsdt;
  const guardrails = validateCustomSpreadRange({
    underlying: book.underlying,
    isCall,
    spot: book.spot,
    lowerStrike,
    upperStrike,
    tenor: book.tenor,
    hoursToExpiry: book.hoursToExpiry,
    atmIv: effectiveIv,
    availableStrikes: book.availableStrikes,
    maxMultiplier,
    shortLegSubsidyRatio: hedge.shortLegSubsidyRatio,
  });

  const summary = computeTicketNumbers({
    tierKind,
    tierLabel,
    underlying: book.underlying,
    direction,
    tenor: book.tenor,
    spot: book.spot,
    lowerStrike,
    upperStrike,
    expiry: book.expiry,
    hoursToExpiry: book.hoursToExpiry,
    atmIv: effectiveIv,
    stakeUsdt,
    maxPayoutUsdt,
    nakedSingleLegCostUsdt,
    indicativeExitUsdt: Math.max(0.01, exitEstimate.bestBidUsdt),
    guardrails,
    recommendedHedge: hedge,
  });

  return {
    summary,
    venue,
    hedge,
    mmMarginBps: effectiveMmMarginBps,
    consensusRisk,
  };
}

export interface EstimatePositionExitParams {
  book: ExpiryBook;
  isCall: boolean;
  lowerStrike: number;
  upperStrike: number;
  remainingLongUsdt: number;
  hoursRemaining: number;
  atlasTelemetry?: AtlasFeedTelemetry;
}

export interface PositionExitEstimate {
  mockMakerBidUsdt: number;
  bestBidUsdt: number;
  consensusRisk: ConsensusRiskAdjustment;
}

/**
 * Computes real-time indicative early-close value for an existing open position
 * from Put-Call Parity fair mid and Atlas ConsensusScore risk spread multiplier.
 */
export function estimatePositionExitUsdt(
  params: EstimatePositionExitParams
): PositionExitEstimate {
  const {
    book,
    isCall,
    lowerStrike,
    upperStrike,
    remainingLongUsdt,
    hoursRemaining,
    atlasTelemetry,
  } = params;
  const consensusRisk = computeConsensusRiskAdjustments(atlasTelemetry);
  const width = upperStrike - lowerStrike;
  if (width <= 0 || remainingLongUsdt <= 0) {
    return { mockMakerBidUsdt: 0, bestBidUsdt: 0, consensusRisk };
  }
  const notional = remainingLongUsdt / width;

  const baseFairMidUsd = computeFairSpreadUnitUsd(
    book,
    isCall,
    lowerStrike,
    upperStrike,
    hoursRemaining
  );
  const adjustedFairMidUsd =
    consensusRisk.ivFloorBoost > 0
      ? computeFairSpreadUnitUsd(
          book,
          isCall,
          lowerStrike,
          upperStrike,
          hoursRemaining,
          atlasTelemetry
        )
      : baseFairMidUsd;
  // On early exits during elevated vol / degraded consensus, anchor bid to the conservative lower fair bound
  const conservativeBidFairUsd = Math.min(baseFairMidUsd, adjustedFairMidUsd);
  const mmCloseUnitUsd = computeMmCloseUnitUsd(
    conservativeBidFairUsd,
    width,
    consensusRisk.spreadMultiplier
  );
  const mockMakerBidUsdt = Math.min(
    remainingLongUsdt * 0.995,
    Math.max(remainingLongUsdt * 0.01, mmCloseUnitUsd * notional)
  );

  return {
    mockMakerBidUsdt,
    bestBidUsdt: mockMakerBidUsdt,
    consensusRisk,
  };
}

function resolveFixedGridBounds(
  book: ExpiryBook,
  cfg: GridConfigEntry
): { gridLow: number; gridHigh: number } {
  const strikes = [...book.availableStrikes].sort((a, b) => a - b);
  if (strikes.length < 2) {
    const rawLow = Math.floor(book.spot / cfg.step) * cfg.step;
    return { gridLow: rawLow, gridHigh: rawLow + cfg.step };
  }

  const strikeSet = new Set(strikes);
  const cacheKey = `${book.underlying}:${book.tenor}:${book.expiry}`;
  const cached = fixedGridCache.get(cacheKey);

  if (
    cached &&
    strikeSet.has(cached.gridLow) &&
    strikeSet.has(cached.gridHigh) &&
    cached.gridHigh > cached.gridLow &&
    book.spot >= cached.gridLow - cfg.hysteresis &&
    book.spot <= cached.gridHigh + cfg.hysteresis
  ) {
    return cached;
  }

  const rawLow = Math.floor(book.spot / cfg.step) * cfg.step;
  const rawHigh = rawLow + cfg.step;

  // Align gridLow to exact match or largest available strike <= rawLow
  let gridLow = strikes[0]!;
  if (strikeSet.has(rawLow)) {
    gridLow = rawLow;
  } else {
    for (const s of strikes) {
      if (s <= rawLow) {
        gridLow = s;
      } else {
        break;
      }
    }
  }

  if (gridLow >= strikes[strikes.length - 1]!) {
    gridLow = strikes[strikes.length - 2]!;
  }

  // Align gridHigh to exact match (> gridLow) or smallest available strike >= rawHigh (and > gridLow)
  let gridHigh: number | undefined;
  if (strikeSet.has(rawHigh) && rawHigh > gridLow) {
    gridHigh = rawHigh;
  } else {
    gridHigh = strikes.find((s) => s >= rawHigh && s > gridLow);
    if (gridHigh === undefined) {
      gridHigh =
        strikes.find((s) => s > gridLow) ?? strikes[strikes.length - 1]!;
    }
  }

  const resolved = { gridLow, gridHigh };
  fixedGridCache.set(cacheKey, resolved);
  return resolved;
}

function snapOutwardUnique(
  sortedStrikes: number[],
  anchor: number,
  rawTarget: number,
  isCall: boolean,
  usedCaps: Set<number>
): number | null {
  if (isCall) {
    const outward = sortedStrikes.find(
      (s) => s > anchor && s >= rawTarget && !usedCaps.has(s)
    );
    if (outward !== undefined) return outward;
    for (let i = sortedStrikes.length - 1; i >= 0; i--) {
      const s = sortedStrikes[i]!;
      if (s > anchor && !usedCaps.has(s)) return s;
    }
    return null;
  } else {
    for (let i = sortedStrikes.length - 1; i >= 0; i--) {
      const s = sortedStrikes[i]!;
      if (s < anchor && s <= rawTarget && !usedCaps.has(s)) return s;
    }
    const fallback = sortedStrikes.find((s) => s < anchor && !usedCaps.has(s));
    return fallback ?? null;
  }
}

export interface FixedGridShelfParams {
  book: ExpiryBook;
  direction: Direction;
  stakeUsdt: number;
  protocolFeeBps: number;
  mmOpenMarkupBps?: number;
  atlasTelemetry?: AtlasFeedTelemetry;
}

export interface FixedGridShelfResult {
  grid: FixedGridMeta;
  tiers: TicketSummary[];
  consensusRisk: ConsensusRiskAdjustment;
}

const TARGET_TIER_COUNT = 4;
const MIN_SHELF_MULTIPLIER = 1.15;

/**
 * Generates the Fixed-Grid Shelf with hysteresis-locked anchor (`gridLow` for BULL,
 * `gridHigh` for BEAR) and 4 standardized target tiers snapped outward to valid grid strikes.
 */
export function buildFixedGridShelf(
  params: FixedGridShelfParams
): FixedGridShelfResult {
  const {
    book,
    direction,
    stakeUsdt,
    protocolFeeBps,
    mmOpenMarkupBps = DEFAULT_MM_OPEN_MARKUP_BPS,
    atlasTelemetry,
  } = params;

  const isCall = direction === "BULL";
  const cfgKey = `${book.underlying}:${book.tenor}` as const;
  const cfg = GRID_CONFIG[cfgKey];
  const sortedStrikes = [...book.availableStrikes].sort((a, b) => a - b);
  const consensusRisk = computeConsensusRiskAdjustments(atlasTelemetry);

  const { gridLow, gridHigh } = resolveFixedGridBounds(book, cfg);
  const anchorStartPrice = isCall ? gridLow : gridHigh;

  const usedCaps = new Set<number>();
  const initialCaps: number[] = [];
  for (const offset of cfg.offsets) {
    const rawTarget = isCall
      ? anchorStartPrice + offset * cfg.step
      : anchorStartPrice - offset * cfg.step;
    const snapped = snapOutwardUnique(
      sortedStrikes,
      anchorStartPrice,
      rawTarget,
      isCall,
      usedCaps
    );
    if (snapped !== null) {
      usedCaps.add(snapped);
      initialCaps.push(snapped);
    }
  }

  const priceCap = (capStrike: number): TicketSummary => {
    const lowerStrike = isCall ? anchorStartPrice : capStrike;
    const upperStrike = isCall ? capStrike : anchorStartPrice;
    const priced = priceSpreadOnVenue({
      book,
      tierKind: "STANDARD",
      tierLabel: `Target $${capStrike.toLocaleString("en-US")}`,
      direction,
      lowerStrike,
      upperStrike,
      stakeUsdt,
      protocolFeeBps,
      mmOpenMarkupBps,
      venue: "MOCK_MAKER",
      atlasTelemetry,
    });
    return priced.summary;
  };

  const accepted: Array<{ capStrike: number; summary: TicketSummary }> = [];
  const filteredLowMult: Array<{ capStrike: number; summary: TicketSummary }> =
    [];

  for (const capStrike of initialCaps) {
    const summary = priceCap(capStrike);
    if (summary.maxMultiplier > MIN_SHELF_MULTIPLIER) {
      accepted.push({ capStrike, summary });
    } else {
      filteredLowMult.push({ capStrike, summary });
    }
  }

  // Extend outward to fill 4 tiers whenever any initial tier was filtered out
  const lastStepIncrement =
    cfg.offsets.length >= 2
      ? Math.max(
          1,
          cfg.offsets[cfg.offsets.length - 1]! -
            cfg.offsets[cfg.offsets.length - 2]!
        )
      : 1;

  let furthestCap =
    initialCaps.length > 0
      ? initialCaps[initialCaps.length - 1]!
      : anchorStartPrice;

  let extensionGuard = 0;
  while (accepted.length < TARGET_TIER_COUNT && extensionGuard < 16) {
    extensionGuard += 1;
    const desiredNext = isCall
      ? furthestCap + lastStepIncrement * cfg.step
      : furthestCap - lastStepIncrement * cfg.step;

    const nextCap = isCall
      ? sortedStrikes.find(
          (s) => s > furthestCap && s >= desiredNext && !usedCaps.has(s)
        )
      : [...sortedStrikes]
          .reverse()
          .find(
            (s) => s < furthestCap && s <= desiredNext && !usedCaps.has(s)
          );

    const immediateOutward = isCall
      ? sortedStrikes.find((s) => s > furthestCap && !usedCaps.has(s))
      : [...sortedStrikes]
          .reverse()
          .find((s) => s < furthestCap && !usedCaps.has(s));

    if (nextCap !== undefined) {
      const candidateSummary = priceCap(nextCap);
      if (
        candidateSummary.guardrails.widthWithinCap &&
        candidateSummary.maxMultiplier > MIN_SHELF_MULTIPLIER
      ) {
        usedCaps.add(nextCap);
        furthestCap = nextCap;
        accepted.push({ capStrike: nextCap, summary: candidateSummary });
        continue;
      }
      if (immediateOutward !== undefined && immediateOutward !== nextCap) {
        const stepSummary = priceCap(immediateOutward);
        usedCaps.add(immediateOutward);
        furthestCap = immediateOutward;
        if (
          stepSummary.guardrails.widthWithinCap &&
          stepSummary.maxMultiplier > MIN_SHELF_MULTIPLIER
        ) {
          accepted.push({ capStrike: immediateOutward, summary: stepSummary });
          continue;
        }
      }
      break;
    } else if (immediateOutward !== undefined) {
      usedCaps.add(immediateOutward);
      furthestCap = immediateOutward;
      const stepSummary = priceCap(immediateOutward);
      if (
        stepSummary.guardrails.widthWithinCap &&
        stepSummary.maxMultiplier > MIN_SHELF_MULTIPLIER
      ) {
        accepted.push({ capStrike: immediateOutward, summary: stepSummary });
        continue;
      }
      break;
    } else {
      break;
    }
  }

  // If outward extension hit the width cap or end of book with < 4 tiers, fill from unused intermediate strikes
  if (accepted.length < TARGET_TIER_COUNT) {
    const directionalStrikes = isCall
      ? sortedStrikes.filter((s) => s > anchorStartPrice && !usedCaps.has(s))
      : [...sortedStrikes]
          .reverse()
          .filter((s) => s < anchorStartPrice && !usedCaps.has(s));

    for (const strike of directionalStrikes) {
      if (accepted.length >= TARGET_TIER_COUNT) break;
      usedCaps.add(strike);
      const summary = priceCap(strike);
      if (
        summary.guardrails.widthWithinCap &&
        summary.maxMultiplier > MIN_SHELF_MULTIPLIER
      ) {
        accepted.push({ capStrike: strike, summary });
      }
    }
  }

  // Defensive fallback only if fewer than 4 strikes exceed MIN_SHELF_MULTIPLIER
  if (accepted.length < TARGET_TIER_COUNT && filteredLowMult.length > 0) {
    const byHighestMult = [...filteredLowMult].sort(
      (a, b) => b.summary.maxMultiplier - a.summary.maxMultiplier
    );
    for (const item of byHighestMult) {
      if (accepted.length >= TARGET_TIER_COUNT) break;
      accepted.push(item);
    }
  }

  accepted.sort((a, b) =>
    isCall ? a.capStrike - b.capStrike : b.capStrike - a.capStrike
  );

  const slotKinds: TierKind[] = [
    "CONSERVATIVE",
    "STANDARD",
    "BREAKOUT",
    "BREAKOUT",
  ];

  const tiers: TicketSummary[] = accepted
    .slice(0, TARGET_TIER_COUNT)
    .map((item, idx) => {
      const lowerStrike = isCall ? anchorStartPrice : item.capStrike;
      const upperStrike = isCall ? item.capStrike : anchorStartPrice;
      const stepSteps = Math.max(
        1,
        Math.round(Math.abs(item.capStrike - anchorStartPrice) / cfg.step)
      );
      const isSharedCenterPool =
        lowerStrike === gridLow && upperStrike === gridHigh;
      return {
        ...item.summary,
        tierKind: slotKinds[idx] ?? "BREAKOUT",
        tierLabel: `Target $${item.capStrike.toLocaleString("en-US")}`,
        isSharedCenterPool,
        stepSteps,
      };
    });

  const grid: FixedGridMeta = {
    gridStep: cfg.step,
    hysteresisBuffer: cfg.hysteresis,
    gridLow,
    gridHigh,
    anchorStartPrice,
    defaultIndex: Math.min(cfg.defaultSlot, Math.max(0, tiers.length - 1)),
  };

  return { grid, tiers, consensusRisk };
}

/** Convenience wrapper returning only the fixed-grid shelf tiers. */
export function buildDefaultShelf(params: FixedGridShelfParams): TicketSummary[] {
  return buildFixedGridShelf(params).tiers;
}

export interface ShelfEngineOptions {
  defaultMmOpenMarkupBps?: number;
}

/**
 * Stateful facade over the Reference / Mock Market Maker pricing & fixed-grid engine.
 * Can be instantiated in backend services or used via its standalone exported functions.
 */
export class ShelfEngine {
  readonly defaultMmOpenMarkupBps: number;

  constructor(options: ShelfEngineOptions = {}) {
    this.defaultMmOpenMarkupBps =
      options.defaultMmOpenMarkupBps ?? DEFAULT_MM_OPEN_MARKUP_BPS;
  }

  resetGridCache(): void {
    resetFixedGridCache();
  }

  computeConsensusRiskAdjustments(
    telemetry?: AtlasFeedTelemetry
  ): ConsensusRiskAdjustment {
    return computeConsensusRiskAdjustments(telemetry);
  }

  computeFairSpreadUnitUsd(
    book: ExpiryBook,
    isCall: boolean,
    lowerStrike: number,
    upperStrike: number,
    hoursRemainingOverride?: number,
    atlasTelemetry?: AtlasFeedTelemetry
  ): number {
    return computeFairSpreadUnitUsd(
      book,
      isCall,
      lowerStrike,
      upperStrike,
      hoursRemainingOverride,
      atlasTelemetry
    );
  }

  computeMmOpenUnitUsd(
    fairMidUsd: number,
    width: number,
    mmOpenMarkupBps = this.defaultMmOpenMarkupBps,
    spreadMultiplier = 1.0
  ): number {
    return computeMmOpenUnitUsd(
      fairMidUsd,
      width,
      mmOpenMarkupBps,
      spreadMultiplier
    );
  }

  computeMmCloseUnitUsd(
    fairMidUsd: number,
    width: number,
    spreadMultiplier = 1.0
  ): number {
    return computeMmCloseUnitUsd(fairMidUsd, width, spreadMultiplier);
  }

  priceSpread(
    params: Omit<PriceSpreadParams, "mmOpenMarkupBps"> & {
      mmOpenMarkupBps?: number;
    }
  ): PricedSpreadResult {
    return priceSpreadOnVenue({
      ...params,
      mmOpenMarkupBps: params.mmOpenMarkupBps ?? this.defaultMmOpenMarkupBps,
    });
  }

  estimatePositionExit(
    params: EstimatePositionExitParams
  ): PositionExitEstimate {
    return estimatePositionExitUsdt(params);
  }

  buildFixedGridShelf(params: FixedGridShelfParams): FixedGridShelfResult {
    return buildFixedGridShelf({
      ...params,
      mmOpenMarkupBps: params.mmOpenMarkupBps ?? this.defaultMmOpenMarkupBps,
    });
  }

  buildDefaultShelf(params: FixedGridShelfParams): TicketSummary[] {
    return this.buildFixedGridShelf(params).tiers;
  }
}

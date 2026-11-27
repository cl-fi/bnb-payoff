import { PRICE_SCALE, USDT_SCALE, type UnderlyingSymbol } from "./chains.js";
import type {
  Direction,
  ExpiryTenor,
  GuardrailResult,
  HedgeEvaluation,
  HedgeRoute,
  OptionStrikeQuote,
  TicketSummary,
  TierKind,
  VenueName,
} from "./types.js";

/** Standard normal PDF */
export function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/** Standard normal CDF (Abramowitz & Stegun approximation, max error < 7.5e-8) */
export function normCdf(x: number): number {
  if (x === 0) return 0.5;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.2316419 * ax);
  const d = 0.3989422804014327 * Math.exp(-0.5 * ax * ax);
  const p =
    d *
    t *
    (0.31938153 +
      t *
        (-0.356563782 +
          t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return sign > 0 ? 1 - p : p;
}

/**
 * European Black-Scholes option price in USD (r = 0 for crypto forward/spot parity).
 */
export function bsOptionPrice(
  isCall: boolean,
  spot: number,
  strike: number,
  timeYears: number,
  vol: number
): number {
  if (timeYears <= 0 || vol <= 0) {
    return isCall ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
  }
  const sqrtT = Math.sqrt(timeYears);
  const d1 =
    (Math.log(spot / strike) + 0.5 * vol * vol * timeYears) / (vol * sqrtT);
  const d2 = d1 - vol * sqrtT;
  if (isCall) {
    return spot * normCdf(d1) - strike * normCdf(d2);
  }
  return strike * normCdf(-d2) - spot * normCdf(-d1);
}

/**
 * Matches Solidity: Math.mulDiv(userPayAmount, protocolFeeBps, 10_000 + protocolFeeBps)
 */
export function computeProtocolFee(
  userPayAmount: bigint,
  feeBps: number
): bigint {
  if (feeBps <= 0) return 0n;
  return (userPayAmount * BigInt(feeBps)) / BigInt(10_000 + feeBps);
}

export function usdtToUnits(amountUsdt: number): bigint {
  return BigInt(Math.round(amountUsdt * Number(USDT_SCALE)));
}

export function unitsToUsdt(units: bigint): number {
  return Number(units) / Number(USDT_SCALE);
}

export function priceToUnits(price: number): bigint {
  return BigInt(Math.round(price * Number(PRICE_SCALE)));
}

export function unitsToPrice(units: bigint): number {
  return Number(units) / Number(PRICE_SCALE);
}

/**
 * Compute per-unit spread payoff at expiry as a fraction in [0, 1] of maxPayout.
 */
export function computeSpreadPayoffFraction(
  isCall: boolean,
  lowerStrike: number,
  upperStrike: number,
  settlementPrice: number
): number {
  const width = upperStrike - lowerStrike;
  if (width <= 0) return 0;
  if (isCall) {
    if (settlementPrice <= lowerStrike) return 0;
    if (settlementPrice >= upperStrike) return 1;
    return (settlementPrice - lowerStrike) / width;
  } else {
    if (settlementPrice >= upperStrike) return 0;
    if (settlementPrice <= lowerStrike) return 1;
    return (upperStrike - settlementPrice) / width;
  }
}

export function computeExpiryPayoffUsdt(
  isCall: boolean,
  lowerStrike: number,
  upperStrike: number,
  maxPayoutUsdt: number,
  settlementPrice: number
): number {
  return (
    maxPayoutUsdt *
    computeSpreadPayoffFraction(isCall, lowerStrike, upperStrike, settlementPrice)
  );
}

/**
 * Computes the proportional cost basis (in USDT) for the remaining open share of a position.
 * Uses the server-provided `remainingStakeUsdt` when present, otherwise prorates `totalStakeUsdt`
 * by `remainingBalanceUsdt / max(initialMaxPayoutUsdt, remainingBalanceUsdt + closedBalanceUsdt)`.
 */
export function computeRemainingStakeUsdt(pos: {
  totalStakeUsdt: number;
  initialMaxPayoutUsdt: number;
  remainingBalanceUsdt: number;
  closedBalanceUsdt?: number;
  remainingStakeUsdt?: number;
}): number {
  if (
    typeof pos.remainingStakeUsdt === "number" &&
    Number.isFinite(pos.remainingStakeUsdt)
  ) {
    return Math.max(0, pos.remainingStakeUsdt);
  }
  const totalStake = Math.max(0, pos.totalStakeUsdt);
  const remaining = Math.max(0, pos.remainingBalanceUsdt);
  if (totalStake <= 0 || remaining <= 0) return 0;

  const closed = Math.max(0, pos.closedBalanceUsdt ?? 0);
  const denom = Math.max(pos.initialMaxPayoutUsdt, remaining + closed);
  if (denom <= 0) return totalStake;

  const remainingRatio = Math.max(0, Math.min(1, remaining / denom));
  return totalStake * remainingRatio;
}

export interface RealizedHistoryMetrics {
  /** True when the position is still ACTIVE but has realized proceeds from an earlier partial close. */
  isPartialActiveClose: boolean;
  /** True for both fully closed-early tickets and partially closed active slices. */
  isClosedEarly: boolean;
  /** Cost basis (USDT) of the realized portion (full `totalStakeUsdt` once settled/closed, prorated sold stake while partially active). */
  realizedStakeUsdt: number;
  /** Cash proceeds / claimable payout (USDT) for the realized portion. */
  totalPayoutUsdt: number;
  /** Realized net PnL (USDT) = totalPayoutUsdt - realizedStakeUsdt. */
  netPnlUsdt: number;
  /** Initial max payout capacity (USDT). */
  maxPossibleUsdt: number;
  /** Initial max multiplier = maxPossibleUsdt / totalStakeUsdt. */
  mult: number;
  /** Percentage of the original position that was sold (1-99 for partial active close, 100 once closed/settled). */
  soldSharePct: number;
  isDirectionRight: boolean;
  isPartialRefund: boolean;
  isBufferNotZero: boolean;
}

/**
 * Extracts realized history metrics for History & Stats views.
 * - Includes finalized tickets (`CLOSED_EARLY`, `SETTLED_CLAIMED`, `SETTLED_CLAIMABLE`) using full lifetime stake & payout.
 * - Also includes the already-sold slice of `ACTIVE` positions that have been partially closed (`earlyCloseProceedsUsdt > 0.005`),
 *   so realized profit/loss from partial exits is reflected in Cumulative PnL without double-counting the remaining open slice.
 * - Returns `null` for `ACTIVE` positions with no realized partial close.
 */
export function computeRealizedHistoryEntry(pos: {
  status: "ACTIVE" | "CLOSED_EARLY" | "SETTLED_CLAIMABLE" | "SETTLED_CLAIMED";
  totalStakeUsdt: number;
  initialMaxPayoutUsdt: number;
  remainingBalanceUsdt: number;
  closedBalanceUsdt: number;
  remainingStakeUsdt?: number;
  earlyCloseProceedsUsdt: number;
  redeemedUsdt: number;
  claimableUsdt: number;
}): RealizedHistoryMetrics | null {
  const isFinalized =
    pos.status === "CLOSED_EARLY" ||
    pos.status === "SETTLED_CLAIMED" ||
    pos.status === "SETTLED_CLAIMABLE";
  const hasPartialRealized =
    pos.status === "ACTIVE" &&
    (pos.earlyCloseProceedsUsdt > 0.005 || pos.closedBalanceUsdt > 0.005);

  if (!isFinalized && !hasPartialRealized) {
    return null;
  }

  const maxPossibleUsdt = Math.max(
    pos.initialMaxPayoutUsdt,
    pos.remainingBalanceUsdt + pos.closedBalanceUsdt
  );
  const mult =
    pos.totalStakeUsdt > 0 && maxPossibleUsdt > 0
      ? maxPossibleUsdt / pos.totalStakeUsdt
      : 0;

  if (hasPartialRealized) {
    const remainingStake = computeRemainingStakeUsdt(pos);
    const realizedStakeUsdt = Math.max(0, pos.totalStakeUsdt - remainingStake);
    const totalPayoutUsdt = Math.max(0, pos.earlyCloseProceedsUsdt);
    const netPnlUsdt = totalPayoutUsdt - realizedStakeUsdt;
    const rawPct =
      maxPossibleUsdt > 0
        ? (pos.closedBalanceUsdt / maxPossibleUsdt) * 100
        : pos.totalStakeUsdt > 0
          ? (realizedStakeUsdt / pos.totalStakeUsdt) * 100
          : 0;
    const soldSharePct = Math.max(1, Math.min(99, Math.round(rawPct)));

    return {
      isPartialActiveClose: true,
      isClosedEarly: true,
      realizedStakeUsdt,
      totalPayoutUsdt,
      netPnlUsdt,
      maxPossibleUsdt,
      mult,
      soldSharePct,
      isDirectionRight: netPnlUsdt > 0,
      isPartialRefund: false,
      isBufferNotZero: false,
    };
  }

  const totalPayoutUsdt =
    pos.earlyCloseProceedsUsdt +
    pos.redeemedUsdt +
    (pos.status === "SETTLED_CLAIMABLE" ? pos.claimableUsdt : 0);
  const realizedStakeUsdt = pos.totalStakeUsdt;
  const netPnlUsdt = totalPayoutUsdt - realizedStakeUsdt;
  const isClosedEarly = pos.status === "CLOSED_EARLY";
  const isDirectionRight = isClosedEarly
    ? netPnlUsdt > 0
    : totalPayoutUsdt > 0.005;
  const isPartialRefund =
    !isClosedEarly &&
    totalPayoutUsdt > 0.005 &&
    maxPossibleUsdt > 0 &&
    totalPayoutUsdt < maxPossibleUsdt * 0.995;
  const isBufferNotZero =
    !isClosedEarly &&
    totalPayoutUsdt > 0.005 &&
    totalPayoutUsdt < realizedStakeUsdt;

  return {
    isPartialActiveClose: false,
    isClosedEarly,
    realizedStakeUsdt,
    totalPayoutUsdt,
    netPnlUsdt,
    maxPossibleUsdt,
    mult,
    soldSharePct: 100,
    isDirectionRight,
    isPartialRefund,
    isBufferNotZero,
  };
}

/**
 * Reference combo hedge fee with single-leg waiver:
 * - Only charges fee on the more expensive leg (cheaper leg is waived in a vertical spread combo).
 * - Model: min(0.03% * spot, 7% * expensiveLegPremium) * notionalUnderlying
 */
export function computeExchangeComboFeeUsd(
  _venue: VenueName,
  spotUsd: number,
  longLegUsd: number,
  shortLegUsd: number,
  notionalUnderlying: number
): number {
  const expensiveLegUsd = Math.max(longLegUsd, shortLegUsd, 0);
  const notionalFeePerUnit = 0.0003 * spotUsd;
  const premiumCapRate = 0.07;
  const feePerUnit = Math.min(notionalFeePerUnit, premiumCapRate * expensiveLegUsd);
  return feePerUnit * notionalUnderlying;
}

/**
 * Evaluates Direct vs Put-Call Parity hedge cost for vertical spreads scaled to `notionalUnderlying`.
 *
 * Put-call parity identity (same strikes [K1, K2] & expiry):
 *   Call(K1) - Call(K2) = (K2 - K1) + Put(K1) - Put(K2)
 *   Put(K2)  - Put(K1)  = (K2 - K1) + Call(K2) - Call(K1)
 */
export function evaluateSpreadHedgeRoutes(params: {
  venue: VenueName;
  spotUsd: number;
  isCall: boolean;
  lowerQuote: OptionStrikeQuote;
  upperQuote: OptionStrikeQuote;
  notionalUnderlying: number;
  side: "OPEN" | "CLOSE";
}): HedgeEvaluation {
  const {
    venue,
    spotUsd,
    isCall,
    lowerQuote,
    upperQuote,
    notionalUnderlying,
    side,
  } = params;
  const width = upperQuote.strike - lowerQuote.strike;

  if (side === "OPEN") {
    if (isCall) {
      // Direct Call Spread: Buy Call(K1) @ ask, Sell Call(K2) @ bid
      const directOptionPerUnit =
        lowerQuote.call.askUsd - upperQuote.call.bidUsd;
      const directFee = computeExchangeComboFeeUsd(
        venue,
        spotUsd,
        lowerQuote.call.askUsd,
        upperQuote.call.bidUsd,
        notionalUnderlying
      );
      const directTotal = directOptionPerUnit * notionalUnderlying + directFee;

      // Parity Put Spread: (K2 - K1) + Buy Put(K1) @ ask - Sell Put(K2) @ bid
      const parityOptionPerUnit =
        width + lowerQuote.put.askUsd - upperQuote.put.bidUsd;
      const parityFee = computeExchangeComboFeeUsd(
        venue,
        spotUsd,
        lowerQuote.put.askUsd,
        upperQuote.put.bidUsd,
        notionalUnderlying
      );
      const parityTotal = parityOptionPerUnit * notionalUnderlying + parityFee;

      const useParity = parityTotal < directTotal - 1e-6;
      const route: HedgeRoute = useParity
        ? "PARITY_PUT_SPREAD"
        : "DIRECT_CALL_SPREAD";
      const totalHedgeCostUsd = useParity ? parityTotal : directTotal;
      const exchangeFeeUsd = useParity ? parityFee : directFee;
      const rawSpreadUsd = totalHedgeCostUsd - exchangeFeeUsd;
      const paritySavedUsd = Math.max(0, directTotal - totalHedgeCostUsd);

      const shortLegSubsidyRatio =
        lowerQuote.call.askUsd > 0 && notionalUnderlying > 0
          ? Math.max(
              0,
              Math.min(
                0.95,
                1 -
                  totalHedgeCostUsd /
                    (lowerQuote.call.askUsd * notionalUnderlying)
              )
            )
          : 0;

      return {
        venue,
        route,
        isParityFlip: useParity,
        longLegInstId: useParity
          ? lowerQuote.put.instId
          : lowerQuote.call.instId,
        shortLegInstId: useParity
          ? upperQuote.put.instId
          : upperQuote.call.instId,
        notionalUnderlying,
        rawSpreadUsd,
        exchangeFeeUsd,
        totalHedgeCostUsd,
        directCostUsd: directTotal,
        parityCostUsd: parityTotal,
        paritySavedUsd,
        paritySavedPct:
          directTotal > 0 ? (paritySavedUsd / directTotal) * 100 : 0,
        shortLegSubsidyRatio,
      };
    } else {
      // Bearish Put Spread: Direct = Buy Put(K2) @ ask - Sell Put(K1) @ bid
      const directOptionPerUnit =
        upperQuote.put.askUsd - lowerQuote.put.bidUsd;
      const directFee = computeExchangeComboFeeUsd(
        venue,
        spotUsd,
        upperQuote.put.askUsd,
        lowerQuote.put.bidUsd,
        notionalUnderlying
      );
      const directTotal = directOptionPerUnit * notionalUnderlying + directFee;

      // Parity Call Spread: (K2 - K1) + Buy Call(K2) @ ask - Sell Call(K1) @ bid
      const parityOptionPerUnit =
        width + upperQuote.call.askUsd - lowerQuote.call.bidUsd;
      const parityFee = computeExchangeComboFeeUsd(
        venue,
        spotUsd,
        upperQuote.call.askUsd,
        lowerQuote.call.bidUsd,
        notionalUnderlying
      );
      const parityTotal = parityOptionPerUnit * notionalUnderlying + parityFee;

      const useParity = parityTotal < directTotal - 1e-6;
      const route: HedgeRoute = useParity
        ? "PARITY_CALL_SPREAD"
        : "DIRECT_PUT_SPREAD";
      const totalHedgeCostUsd = useParity ? parityTotal : directTotal;
      const exchangeFeeUsd = useParity ? parityFee : directFee;
      const rawSpreadUsd = totalHedgeCostUsd - exchangeFeeUsd;
      const paritySavedUsd = Math.max(0, directTotal - totalHedgeCostUsd);

      const shortLegSubsidyRatio =
        upperQuote.put.askUsd > 0 && notionalUnderlying > 0
          ? Math.max(
              0,
              Math.min(
                0.95,
                1 -
                  totalHedgeCostUsd /
                    (upperQuote.put.askUsd * notionalUnderlying)
              )
            )
          : 0;

      return {
        venue,
        route,
        isParityFlip: useParity,
        longLegInstId: useParity
          ? upperQuote.call.instId
          : upperQuote.put.instId,
        shortLegInstId: useParity
          ? lowerQuote.call.instId
          : lowerQuote.put.instId,
        notionalUnderlying,
        rawSpreadUsd,
        exchangeFeeUsd,
        totalHedgeCostUsd,
        directCostUsd: directTotal,
        parityCostUsd: parityTotal,
        paritySavedUsd,
        paritySavedPct:
          directTotal > 0 ? (paritySavedUsd / directTotal) * 100 : 0,
        shortLegSubsidyRatio,
      };
    }
  } else {
    // CLOSE side: MM unwinds long spread (maximizing net USDT proceeds returned to user)
    if (isCall) {
      // Direct unwind: Sell Call(K1) @ bid - Buy Call(K2) @ ask
      const directGross =
        (lowerQuote.call.bidUsd - upperQuote.call.askUsd) * notionalUnderlying;
      const directFee = computeExchangeComboFeeUsd(
        venue,
        spotUsd,
        lowerQuote.call.bidUsd,
        upperQuote.call.askUsd,
        notionalUnderlying
      );
      const directNet = Math.max(0, directGross - directFee);

      // Parity unwind: (K2 - K1) + Sell Put(K1) @ bid - Buy Put(K2) @ ask
      const parityGross =
        (width + lowerQuote.put.bidUsd - upperQuote.put.askUsd) *
        notionalUnderlying;
      const parityFee = computeExchangeComboFeeUsd(
        venue,
        spotUsd,
        lowerQuote.put.bidUsd,
        upperQuote.put.askUsd,
        notionalUnderlying
      );
      const parityNet = Math.max(0, parityGross - parityFee);

      const useParity = parityNet > directNet + 1e-6;
      const route: HedgeRoute = useParity
        ? "PARITY_PUT_SPREAD"
        : "DIRECT_CALL_SPREAD";
      const totalHedgeCostUsd = useParity ? parityNet : directNet;
      const exchangeFeeUsd = useParity ? parityFee : directFee;
      const paritySavedUsd = Math.max(0, totalHedgeCostUsd - directNet);

      return {
        venue,
        route,
        isParityFlip: useParity,
        longLegInstId: useParity
          ? lowerQuote.put.instId
          : lowerQuote.call.instId,
        shortLegInstId: useParity
          ? upperQuote.put.instId
          : upperQuote.call.instId,
        notionalUnderlying,
        rawSpreadUsd: totalHedgeCostUsd + exchangeFeeUsd,
        exchangeFeeUsd,
        totalHedgeCostUsd,
        directCostUsd: directNet,
        parityCostUsd: parityNet,
        paritySavedUsd,
        paritySavedPct: directNet > 0 ? (paritySavedUsd / directNet) * 100 : 0,
        shortLegSubsidyRatio: 0,
      };
    } else {
      // Bearish unwind: Sell Put(K2) @ bid - Buy Put(K1) @ ask
      const directGross =
        (upperQuote.put.bidUsd - lowerQuote.put.askUsd) * notionalUnderlying;
      const directFee = computeExchangeComboFeeUsd(
        venue,
        spotUsd,
        upperQuote.put.bidUsd,
        lowerQuote.put.askUsd,
        notionalUnderlying
      );
      const directNet = Math.max(0, directGross - directFee);

      // Parity unwind: (K2 - K1) + Sell Call(K2) @ bid - Buy Call(K1) @ ask
      const parityGross =
        (width + upperQuote.call.bidUsd - lowerQuote.call.askUsd) *
        notionalUnderlying;
      const parityFee = computeExchangeComboFeeUsd(
        venue,
        spotUsd,
        upperQuote.call.bidUsd,
        lowerQuote.call.askUsd,
        notionalUnderlying
      );
      const parityNet = Math.max(0, parityGross - parityFee);

      const useParity = parityNet > directNet + 1e-6;
      const route: HedgeRoute = useParity
        ? "PARITY_CALL_SPREAD"
        : "DIRECT_PUT_SPREAD";
      const totalHedgeCostUsd = useParity ? parityNet : directNet;
      const exchangeFeeUsd = useParity ? parityFee : directFee;
      const paritySavedUsd = Math.max(0, totalHedgeCostUsd - directNet);

      return {
        venue,
        route,
        isParityFlip: useParity,
        longLegInstId: useParity
          ? upperQuote.call.instId
          : upperQuote.put.instId,
        shortLegInstId: useParity
          ? lowerQuote.call.instId
          : lowerQuote.put.instId,
        notionalUnderlying,
        rawSpreadUsd: totalHedgeCostUsd + exchangeFeeUsd,
        exchangeFeeUsd,
        totalHedgeCostUsd,
        directCostUsd: directNet,
        parityCostUsd: parityNet,
        paritySavedUsd,
        paritySavedPct: directNet > 0 ? (paritySavedUsd / directNet) * 100 : 0,
        shortLegSubsidyRatio: 0,
      };
    }
  }
}

export function formatSettlementLabel(expiry: number): string {
  const d = new Date(expiry * 1000);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const utcHour = d.getUTCHours();
  const hh = String(utcHour).padStart(2, "0");
  const utcPlus8 = String((utcHour + 8) % 24).padStart(2, "0");
  return `${mm}-${dd} ${hh}:00 UTC (${utcPlus8}:00 UTC+8)`;
}

/**
 * Computes all 5 mandatory ticket numbers + spread savings + 50x perp comparison.
 */
export function computeTicketNumbers(params: {
  tierKind: TierKind;
  tierLabel: string;
  underlying: UnderlyingSymbol;
  direction: Direction;
  tenor: ExpiryTenor;
  spot: number;
  lowerStrike: number;
  upperStrike: number;
  expiry: number;
  hoursToExpiry: number;
  atmIv: number;
  stakeUsdt: number;
  maxPayoutUsdt: number;
  nakedSingleLegCostUsdt: number;
  indicativeExitUsdt?: number;
  guardrails: GuardrailResult;
  recommendedHedge?: HedgeEvaluation;
}): TicketSummary {
  const {
    tierKind,
    tierLabel,
    underlying,
    direction,
    tenor,
    spot,
    lowerStrike,
    upperStrike,
    expiry,
    hoursToExpiry,
    atmIv,
    stakeUsdt,
    maxPayoutUsdt,
    nakedSingleLegCostUsdt,
    indicativeExitUsdt,
    guardrails,
    recommendedHedge,
  } = params;

  const isCall = direction === "BULL";
  const width = upperStrike - lowerStrike;
  const maxMultiplier = stakeUsdt > 0 ? maxPayoutUsdt / stakeUsdt : 0;

  // Breakeven at expiry:
  // For Call spread: lower + width * (stake / maxPayout)
  // For Put spread: upper - width * (stake / maxPayout)
  const payoutRatioNeeded =
    maxPayoutUsdt > 0 ? Math.min(1, stakeUsdt / maxPayoutUsdt) : 1;
  const breakevenPrice = isCall
    ? lowerStrike + width * payoutRatioNeeded
    : upperStrike - width * payoutRatioNeeded;
  const breakevenPct = ((breakevenPrice - spot) / spot) * 100;

  // Flat settlement payoff if spot stays unchanged at `spot`
  const flatPayoutUsdt = computeExpiryPayoffUsdt(
    isCall,
    lowerStrike,
    upperStrike,
    maxPayoutUsdt,
    spot
  );
  const flatReturnPct = stakeUsdt > 0 ? (flatPayoutUsdt / stakeUsdt) * 100 : 0;

  // +6h (or +28% elapsed) mid-life reference exit value at +1.5% favorable move
  const remainingYears = Math.max(0.0001, (hoursToExpiry * 0.72) / (365 * 24));
  const simSpot = isCall ? spot * 1.015 : spot * 0.985;
  const spreadBsAtSim = isCall
    ? bsOptionPrice(true, simSpot, lowerStrike, remainingYears, atmIv) -
      bsOptionPrice(true, simSpot, upperStrike, remainingYears, atmIv)
    : bsOptionPrice(false, simSpot, upperStrike, remainingYears, atmIv) -
      bsOptionPrice(false, simSpot, lowerStrike, remainingYears, atmIv);
  const midLifeReferenceUsdt = Math.max(
    0,
    Math.min(maxPayoutUsdt, (spreadBsAtSim / width) * maxPayoutUsdt * 0.97)
  );

  // Spread savings vs naked single leg
  const spreadSavingsPct =
    nakedSingleLegCostUsdt > stakeUsdt && nakedSingleLegCostUsdt > 0
      ? ((nakedSingleLegCostUsdt - stakeUsdt) / nakedSingleLegCostUsdt) * 100
      : 0;

  // 50x perp liquidation benchmark (~1.9% adverse move with maintenance margin)
  const perp50xLiqPrice = isCall ? spot * 0.981 : spot * 1.019;

  return {
    tierKind,
    tierLabel,
    underlying,
    direction,
    tenor,
    expiry,
    expiryIso: new Date(expiry * 1000).toISOString(),
    hoursToExpiry,
    spot,
    startPrice: isCall ? lowerStrike : upperStrike,
    capPrice: isCall ? upperStrike : lowerStrike,
    lowerStrike,
    upperStrike,
    stakeUsdt: Number(stakeUsdt.toFixed(2)),
    breakevenPrice: Number(breakevenPrice.toFixed(2)),
    breakevenPct: Number(breakevenPct.toFixed(2)),
    flatPayoutUsdt: Number(flatPayoutUsdt.toFixed(2)),
    flatReturnPct: Number(flatReturnPct.toFixed(1)),
    fullPayoutPrice: isCall ? upperStrike : lowerStrike,
    maxPayoutUsdt: Number(maxPayoutUsdt.toFixed(2)),
    maxMultiplier: Number(maxMultiplier.toFixed(2)),
    settlementLabel: formatSettlementLabel(expiry),
    indicativeExitUsdt: Number(
      (indicativeExitUsdt ?? stakeUsdt * 0.92).toFixed(2)
    ),
    midLifeReferenceUsdt: Number(midLifeReferenceUsdt.toFixed(2)),
    spreadSavingsPct: Number(Math.max(0, spreadSavingsPct).toFixed(1)),
    nakedSingleLegCostUsdt: Number(nakedSingleLegCostUsdt.toFixed(2)),
    perp50xLiqPrice: Number(perp50xLiqPrice.toFixed(2)),
    recommendedHedge,
    guardrails,
  };
}

import type { UnderlyingSymbol } from "./chains.js";
import { bsOptionPrice, computeTicketNumbers } from "./math.js";
import type {
  ClampedCustomSelection,
  CustomClampReason,
  CustomRangeConfig,
  Direction,
  ExpiryTenor,
  GuardrailResult,
  TicketSummary,
} from "./types.js";

/**
 * Unclamped fair value ratio lower bound (4.5% of spread width):
 * Strictly above the 0.04W fair clamp & 0.045W MM open ask clamp so quotes never
 * flatten into dominated ~21.37x lottery pricing or lock excessive vault collateral.
 */
export const MIN_FAIR_VALUE_RATIO = 0.045;

/**
 * Unclamped fair value ratio upper bound (85% of spread width):
 * Bounds deep-ITM spreads around the ~1.15x floor even under zero protocol fees.
 */
export const MAX_FAIR_VALUE_RATIO = 0.85;

/** Target minimum multiplier for selectable Quick & Custom UI ranges */
export const MIN_CUSTOM_MULTIPLIER = 1.15;

/** Hard guardrail minimum multiplier (small buffer under 1.15x for maker markup/spot ticks) */
export const HARD_MIN_CUSTOM_MULTIPLIER = 1.12;

/** Target maximum multiplier for selectable Quick & Custom UI ranges */
export const MAX_CUSTOM_MULTIPLIER = 20.0;

/** Hard guardrail maximum multiplier (blocks flat-clamped ~21.37x OTM quotes) */
export const HARD_MAX_CUSTOM_MULTIPLIER = 20.5;

export interface ValidateCustomRangeInput {
  underlying: UnderlyingSymbol;
  isCall: boolean;
  spot: number;
  lowerStrike: number;
  upperStrike: number;
  tenor: ExpiryTenor;
  hoursToExpiry: number;
  atmIv: number;
  availableStrikes: number[];
  maxMultiplier: number;
  shortLegSubsidyRatio: number;
  /** Optional exact unclamped fair ratio (fairUsd / width) supplied by the pricing engine */
  rawFairRatio?: number;
}

function clampNum(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

/**
 * Computes the tenor- and IV-anchored maximum allowed spread width (% of spot).
 * - DAILY (<= 42h): [7.2%, 8.0%]
 * - WEEKLY (> 42h): [14.0%, 16.0%]
 */
export function computeMaxAllowedWidthPct(
  tenor: ExpiryTenor,
  hoursToExpiry: number,
  atmIv: number
): number {
  const timeYears = Math.max(hoursToExpiry, 12) / (365 * 24);
  const oneSigmaPct = Math.max(0.025, atmIv * Math.sqrt(timeYears)) * 100;
  const isDaily = tenor === "DAILY" || hoursToExpiry <= 42;
  return isDaily
    ? Math.min(8.0, Math.max(7.2, 2.2 * oneSigmaPct))
    : Math.min(16.0, Math.max(14.0, 2.2 * oneSigmaPct));
}

/**
 * Computes the unclamped European Black-Scholes fair value of a vertical spread
 * `[lowerStrike, upperStrike]` as a fraction of its width in `[0, 1]`.
 */
export function computeUnclampedSpreadFairRatio(params: {
  isCall: boolean;
  spot: number;
  lowerStrike: number;
  upperStrike: number;
  hoursToExpiry: number;
  atmIv: number;
}): number {
  const { isCall, spot, lowerStrike, upperStrike, hoursToExpiry, atmIv } =
    params;
  const width = upperStrike - lowerStrike;
  if (width <= 0 || !Number.isFinite(spot) || spot <= 0) return 0;

  const T = Math.max(hoursToExpiry, 0.25) / (365 * 24);
  const iv = clampNum(Number.isFinite(atmIv) ? atmIv : 0.6, 0.1, 3.0);

  const rawSpread = isCall
    ? bsOptionPrice(true, spot, lowerStrike, T, iv) -
      bsOptionPrice(true, spot, upperStrike, T, iv)
    : bsOptionPrice(false, spot, upperStrike, T, iv) -
      bsOptionPrice(false, spot, lowerStrike, T, iv);

  return clampNum(rawSpread / width, 0, 1);
}

/**
 * Enforces the 4 Layer-2 Spread Guardrails:
 * 1. Strict alignment with standard strike grid ticks (no arbitrary decimals).
 * 2. Cap width protection matching tenor (24h daily vs 3-7d weekly) + minimum short-leg subsidy.
 * 3. Low multiplier warning when maxMultiplier < 1.30x (hard reject below ITM floor).
 * 4. OTM/ITM fair-pricing bounds keeping spreads strictly out of the 0.04W/0.045W flat-clamp
 *    region (~1.15x–20x fair pricing, preventing dominated extreme OTM quotes & excessive lockup).
 */
export function validateCustomSpreadRange(
  input: ValidateCustomRangeInput
): GuardrailResult {
  const {
    isCall,
    spot,
    lowerStrike,
    upperStrike,
    tenor,
    hoursToExpiry,
    atmIv,
    availableStrikes,
    maxMultiplier,
    shortLegSubsidyRatio,
    rawFairRatio: suppliedRawFairRatio,
  } = input;

  const errors: string[] = [];
  const warnings: string[] = [];

  // Guardrail 1: Strict strike tick alignment
  const lowerAligned = availableStrikes.some(
    (s) => Math.abs(s - lowerStrike) < 1e-6
  );
  const upperAligned = availableStrikes.some(
    (s) => Math.abs(s - upperStrike) < 1e-6
  );
  const strikeAligned = lowerAligned && upperAligned && lowerStrike < upperStrike;

  if (lowerStrike >= upperStrike) {
    errors.push("封顶价与起步价区间无效（必须满足低行权价 < 高行权价）");
  }
  if (!lowerAligned || !upperAligned) {
    errors.push(
      "自选价格必须严格对齐标准行权价刻度，确保每笔均可 1:1 对冲"
    );
  }

  // Guardrail 2: Width cap & short-leg subsidy protection
  const widthPct = spot > 0 ? ((upperStrike - lowerStrike) / spot) * 100 : 0;
  const isDaily = tenor === "DAILY" || hoursToExpiry <= 42;
  const maxAllowedWidthPct = computeMaxAllowedWidthPct(
    tenor,
    hoursToExpiry,
    atmIv
  );

  const widthWithinCap = widthPct <= maxAllowedWidthPct + 0.05;
  if (!widthWithinCap) {
    errors.push(
      `当前区间宽度 ${widthPct.toFixed(1)}% 超过${isDaily ? "日度" : "周度"}上限 ${maxAllowedWidthPct.toFixed(1)}%，远端卖出几乎无法补贴门票，请收窄区间`
    );
  }

  const minSubsidy = isDaily ? 0.05 : 0.08;
  if (widthWithinCap && shortLegSubsidyRatio < minSubsidy) {
    warnings.push(
      "远端封顶卖出补贴比例偏低，建议适当贴近当前市价以提高性价比"
    );
  }

  // Guardrail 3 & 4: Fair-pricing OTM/ITM boundaries (~1.15x–20x, strictly above 0.04W/0.045W clamps)
  const rawFairRatio =
    typeof suppliedRawFairRatio === "number" &&
    Number.isFinite(suppliedRawFairRatio)
      ? clampNum(suppliedRawFairRatio, 0, 1)
      : lowerStrike < upperStrike && spot > 0
        ? computeUnclampedSpreadFairRatio({
            isCall,
            spot,
            lowerStrike,
            upperStrike,
            hoursToExpiry,
            atmIv,
          })
        : 0;

  let lowMultiplierWarning = false;
  let withinFairBounds = true;

  if (maxMultiplier > 0 && maxMultiplier < 1.3) {
    lowMultiplierWarning = true;
  }

  if (maxMultiplier <= 1.03) {
    withinFairBounds = false;
    errors.push(
      `当前区间最高倍数仅 ${maxMultiplier.toFixed(2)}x，扣除对冲成本后已无交易弹性`
    );
  } else if (
    lowerStrike < upperStrike &&
    (maxMultiplier < HARD_MIN_CUSTOM_MULTIPLIER ||
      rawFairRatio > MAX_FAIR_VALUE_RATIO + 1e-6)
  ) {
    withinFairBounds = false;
    errors.push(
      `当前区间偏深实值（最高倍数 ${maxMultiplier.toFixed(2)}x 低于公允下限），请向现价方向收窄或平移区间`
    );
  } else if (lowMultiplierWarning) {
    warnings.push("当前区间偏保守收租，最高回报弹性较低");
  }

  if (
    lowerStrike < upperStrike &&
    (rawFairRatio < MIN_FAIR_VALUE_RATIO - 1e-6 ||
      maxMultiplier > HARD_MAX_CUSTOM_MULTIPLIER)
  ) {
    withinFairBounds = false;
    errors.push(
      "当前区间过于虚值（已触及公允定价下限或最高约 20x 赔率边界），请将起赚线或封顶价向现价靠拢"
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    strikeAligned,
    widthWithinCap,
    widthPct: Number(widthPct.toFixed(2)),
    maxAllowedWidthPct: Number(maxAllowedWidthPct.toFixed(2)),
    shortLegSubsidyRatio: Number(shortLegSubsidyRatio.toFixed(4)),
    lowMultiplierWarning,
    withinFairBounds,
    rawFairRatio: Number(rawFairRatio.toFixed(4)),
  };
}

function findNearestStrike(strikes: readonly number[], target: number): number {
  let best = strikes[0]!;
  let bestDist = Math.abs(best - target);
  for (let i = 1; i < strikes.length; i++) {
    const s = strikes[i]!;
    const dist = Math.abs(s - target);
    if (dist < bestDist) {
      bestDist = dist;
      best = s;
    }
  }
  return best;
}

function classifyStartClampReason(
  validStarts: readonly number[],
  desiredStart: number,
  isBull: boolean
): CustomClampReason {
  const firstStart = validStarts[0]!;
  const lastStart = validStarts[validStarts.length - 1]!;
  if (isBull ? desiredStart < firstStart : desiredStart > firstStart) {
    return "ITM_FAIR_LIMIT";
  }
  if (isBull ? desiredStart > lastStart : desiredStart < lastStart) {
    return "OTM_FAIR_LIMIT";
  }
  return "STRIKE_ALIGN";
}

function resolveSpreadStrikeIvs(
  pricingParams: CustomRangeConfig["pricingParams"],
  lowerStrike: number,
  upperStrike: number
): {
  lowerIv: number | null;
  upperIv: number | null;
  ivFloorBoost: number;
  strikeBaseIv: number;
  strikeAdjIv: number;
  atmEffectiveIv: number;
} {
  const atmIv = clampNum(
    Number.isFinite(pricingParams.baseIv)
      ? pricingParams.baseIv
      : pricingParams.effectiveIv,
    0.1,
    3.0
  );
  const ivFloorBoost =
    typeof pricingParams.ivFloorBoost === "number" &&
    Number.isFinite(pricingParams.ivFloorBoost)
      ? Math.max(0, pricingParams.ivFloorBoost)
      : Math.max(
          0,
          (Number.isFinite(pricingParams.effectiveIv)
            ? pricingParams.effectiveIv
            : atmIv) - atmIv
        );
  const atmEffectiveIv = clampNum(
    Number.isFinite(pricingParams.effectiveIv)
      ? pricingParams.effectiveIv
      : atmIv + ivFloorBoost,
    0.1,
    3.0
  );

  const strikeIvs = pricingParams.strikeIvs;
  const rawLower = strikeIvs?.[String(lowerStrike)];
  const rawUpper = strikeIvs?.[String(upperStrike)];
  const lowerIv =
    typeof rawLower === "number" &&
    Number.isFinite(rawLower) &&
    rawLower > 0.05 &&
    rawLower < 5.0
      ? clampNum(rawLower, 0.1, 3.0)
      : null;
  const upperIv =
    typeof rawUpper === "number" &&
    Number.isFinite(rawUpper) &&
    rawUpper > 0.05 &&
    rawUpper < 5.0
      ? clampNum(rawUpper, 0.1, 3.0)
      : null;

  const rawIvs = [lowerIv, upperIv].filter((v): v is number => v !== null);
  const strikeBaseIv =
    rawIvs.length > 0
      ? clampNum(
          rawIvs.reduce((a, b) => a + b, 0) / rawIvs.length,
          0.1,
          3.0
        )
      : atmIv;
  const baseEffectiveIv = clampNum(Math.max(strikeBaseIv, atmIv), 0.1, 3.0);
  const strikeAdjIv = clampNum(
    Math.max(strikeBaseIv, atmIv + ivFloorBoost),
    0.1,
    3.0
  );

  return {
    lowerIv,
    upperIv,
    ivFloorBoost,
    strikeBaseIv: baseEffectiveIv,
    strikeAdjIv,
    atmEffectiveIv,
  };
}

/**
 * Auto-clamps a desired `(Start, Target cap)` selection against `CustomRangeConfig`
 * (width cap + OTM/ITM fair-pricing boundaries + strike grid alignment) and returns
 * the exact clamp reason so the UI can give immediate transparent feedback.
 */
export function resolveClampedCustomRange(params: {
  config: CustomRangeConfig;
  direction: Direction;
  desiredStart: number;
  desiredCap: number;
}): ClampedCustomSelection | null {
  const { config, direction, desiredStart, desiredCap } = params;
  if (!config.validStarts.length) return null;

  const isBull = direction === "BULL";
  const startPrice = findNearestStrike(config.validStarts, desiredStart);
  const startClamped = Math.abs(startPrice - desiredStart) > 1e-6;

  const validCaps = config.validCapsByStart[String(startPrice)] ?? [];
  if (validCaps.length === 0) return null;

  const exactCap = validCaps.find((c) => Math.abs(c - desiredCap) < 1e-6);
  if (exactCap !== undefined) {
    return {
      startPrice,
      capPrice: exactCap,
      lowerStrike: isBull ? startPrice : exactCap,
      upperStrike: isBull ? exactCap : startPrice,
      validCaps,
      startClamped,
      capClamped: false,
      clampReason: startClamped
        ? classifyStartClampReason(config.validStarts, desiredStart, isBull)
        : "NONE",
    };
  }

  const firstCap = validCaps[0]!;
  const lastCap = validCaps[validCaps.length - 1]!;
  let capPrice: number;
  let clampReason: CustomClampReason;

  if (isBull ? desiredCap <= startPrice : desiredCap >= startPrice) {
    capPrice = firstCap;
    clampReason = "ORDERING";
  } else if (isBull ? desiredCap < firstCap : desiredCap > firstCap) {
    capPrice = firstCap;
    const candidateLower = isBull ? startPrice : desiredCap;
    const candidateUpper = isBull ? desiredCap : startPrice;
    const { strikeBaseIv, strikeAdjIv } = resolveSpreadStrikeIvs(
      config.pricingParams,
      candidateLower,
      candidateUpper
    );
    const desiredFairRatio = Math.max(
      computeUnclampedSpreadFairRatio({
        isCall: isBull,
        spot: config.pricingParams.spot,
        lowerStrike: candidateLower,
        upperStrike: candidateUpper,
        hoursToExpiry: config.pricingParams.hoursToExpiry,
        atmIv: strikeBaseIv,
      }),
      computeUnclampedSpreadFairRatio({
        isCall: isBull,
        spot: config.pricingParams.spot,
        lowerStrike: candidateLower,
        upperStrike: candidateUpper,
        hoursToExpiry: Math.max(
          config.pricingParams.hoursToExpiry * config.pricingParams.varianceTimeScale,
          0.25
        ),
        atmIv: strikeAdjIv,
      })
    );
    const minFairForItm = 1 / Math.max(1.05, config.minMultiplier) - 0.08;
    clampReason =
      desiredFairRatio > Math.min(MAX_FAIR_VALUE_RATIO, minFairForItm)
        ? "ITM_FAIR_LIMIT"
        : "STRIKE_ALIGN";
  } else if (isBull ? desiredCap > lastCap : desiredCap < lastCap) {
    capPrice = lastCap;
    const spot = config.pricingParams.spot;
    const desiredWidthPct =
      spot > 0 ? (Math.abs(desiredCap - startPrice) / spot) * 100 : 0;
    clampReason =
      desiredWidthPct > config.maxAllowedWidthPct + 0.05
        ? "WIDTH_CAP"
        : "OTM_FAIR_LIMIT";
  } else {
    capPrice = findNearestStrike(validCaps, desiredCap);
    clampReason = "STRIKE_ALIGN";
  }

  return {
    startPrice,
    capPrice,
    lowerStrike: isBull ? startPrice : capPrice,
    upperStrike: isBull ? capPrice : startPrice,
    validCaps,
    startClamped,
    capClamped: true,
    clampReason,
  };
}

export interface EstimateCustomTicketPreviewParams {
  underlying: UnderlyingSymbol;
  direction: Direction;
  tenor: ExpiryTenor;
  expiry: number;
  availableStrikes: number[];
  lowerStrike: number;
  upperStrike: number;
  stakeUsdt: number;
  config: CustomRangeConfig;
}

/**
 * Pure synchronous client-side preview estimator matching `ShelfEngine.priceSpreadOnVenue`
 * so dragging Custom Start/Target sliders updates the chart and ticket numbers at 60fps
 * before `/api/market/preview-custom` server reconciliation arrives.
 */
export function estimateCustomTicketPreview(
  params: EstimateCustomTicketPreviewParams
): TicketSummary {
  const {
    underlying,
    direction,
    tenor,
    expiry,
    availableStrikes,
    lowerStrike,
    upperStrike,
    stakeUsdt,
    config,
  } = params;

  const isCall = direction === "BULL";
  const width = upperStrike - lowerStrike;
  const {
    spot,
    hoursToExpiry,
    varianceTimeScale,
    spreadMultiplier,
    protocolFeeBps,
    mmOpenMarkupBps,
  } = config.pricingParams;

  const safeStake = Math.max(1, Number.isFinite(stakeUsdt) ? stakeUsdt : 20);
  const protocolFeeUsdt =
    (safeStake * protocolFeeBps) / (10_000 + protocolFeeBps);
  const mmNetPremiumUsdt = safeStake - protocolFeeUsdt;

  const {
    lowerIv,
    upperIv,
    ivFloorBoost,
    strikeBaseIv,
    strikeAdjIv,
    atmEffectiveIv,
  } = resolveSpreadStrikeIvs(config.pricingParams, lowerStrike, upperStrike);
  const baseBsRatio = computeUnclampedSpreadFairRatio({
    isCall,
    spot,
    lowerStrike,
    upperStrike,
    hoursToExpiry,
    atmIv: strikeBaseIv,
  });
  let baseRawRatio = baseBsRatio;
  // Mirror ShelfEngine's 50/50 reference-mid blend under skewed strike IVs
  if (
    width > 0 &&
    spot > 0 &&
    lowerIv !== null &&
    upperIv !== null &&
    Math.abs(lowerIv - upperIv) > 1e-4
  ) {
    const Tbase = Math.max(hoursToExpiry, 0.25) / (365 * 24);
    const refCallUsd =
      bsOptionPrice(true, spot, lowerStrike, Tbase, lowerIv) -
      bsOptionPrice(true, spot, upperStrike, Tbase, upperIv);
    if (refCallUsd > 0 && refCallUsd < width) {
      const bsCallRatio = isCall ? baseBsRatio : 1 - baseBsRatio;
      const refCallRatio = clampNum(
        refCallUsd / width,
        bsCallRatio - 0.1,
        bsCallRatio + 0.1
      );
      const blendedCallRatio = 0.5 * bsCallRatio + 0.5 * refCallRatio;
      baseRawRatio = clampNum(
        isCall ? blendedCallRatio : 1 - blendedCallRatio,
        0,
        1
      );
    }
  }
  const scaledHours = Math.max(hoursToExpiry * varianceTimeScale, 0.25);
  const hasRiskShift = ivFloorBoost > 1e-6 || varianceTimeScale !== 1.0;
  const adjRawRatio = hasRiskShift
    ? computeUnclampedSpreadFairRatio({
        isCall,
        spot,
        lowerStrike,
        upperStrike,
        hoursToExpiry: scaledHours,
        atmIv: strikeAdjIv,
      })
    : baseRawRatio;

  const conservativeRawRatio = Math.max(baseRawRatio, adjRawRatio);
  const clampedFairUsd =
    width > 0 ? clampNum(conservativeRawRatio, 0.04, 0.96) * width : 0;

  const mult = Math.max(1.0, Number.isFinite(spreadMultiplier) ? spreadMultiplier : 1.0);
  const openEdge = (Math.max(0, mmOpenMarkupBps) / 10_000 + 0.0025) * mult;
  const additiveSpread = 0.003 * mult * width;
  const mmOpenUnitUsd =
    width > 0
      ? clampNum(
          clampedFairUsd * (1 + openEdge) + additiveSpread,
          0.045 * width,
          0.985 * width
        )
      : 1;

  const notionalUnderlying = width > 0 ? mmNetPremiumUsdt / mmOpenUnitUsd : 0;
  const maxPayoutUsdt =
    width > 0
      ? Math.max(safeStake * 1.01, notionalUnderlying * width)
      : safeStake;

  const closeFairUsd =
    width > 0 ? clampNum(Math.min(baseRawRatio, adjRawRatio), 0.04, 0.96) * width : 0;
  const closeEdge = Math.min(0.18, 0.014 * mult);
  const closeHaircut = Math.min(0.06, 0.003 * mult) * width;
  const mmCloseUnitUsd =
    width > 0
      ? clampNum(
          closeFairUsd * (1 - closeEdge) - closeHaircut,
          0.01 * width,
          0.99 * width
        )
      : 0;
  const indicativeExitUsdt =
    width > 0
      ? Math.max(
          0.01,
          Math.min(
            maxPayoutUsdt * 0.995,
            Math.max(maxPayoutUsdt * 0.01, mmCloseUnitUsd * (maxPayoutUsdt / width))
          )
        )
      : safeStake * 0.92;

  const T = Math.max(hoursToExpiry, 0.25) / (365 * 24);
  const longLegBs = bsOptionPrice(
    isCall,
    spot,
    isCall ? lowerStrike : upperStrike,
    T,
    strikeAdjIv
  );
  const shortLegBs = bsOptionPrice(
    isCall,
    spot,
    isCall ? upperStrike : lowerStrike,
    T,
    strikeAdjIv
  );
  const shortLegSubsidyRatio =
    longLegBs > 0 ? clampNum(shortLegBs / longLegBs, 0, 0.95) : 0;
  const nakedSingleLegCostUsdt =
    longLegBs * notionalUnderlying * (1 + protocolFeeBps / 10_000);

  const maxMultiplier = maxPayoutUsdt / safeStake;
  const guardrails = validateCustomSpreadRange({
    underlying,
    isCall,
    spot,
    lowerStrike,
    upperStrike,
    tenor,
    hoursToExpiry,
    atmIv: atmEffectiveIv,
    availableStrikes,
    maxMultiplier,
    shortLegSubsidyRatio,
    rawFairRatio: conservativeRawRatio,
  });

  return computeTicketNumbers({
    tierKind: "CUSTOM",
    tierLabel: "Custom Range",
    underlying,
    direction,
    tenor,
    spot,
    lowerStrike,
    upperStrike,
    expiry,
    hoursToExpiry,
    atmIv: atmEffectiveIv,
    stakeUsdt: safeStake,
    maxPayoutUsdt,
    nakedSingleLegCostUsdt,
    indicativeExitUsdt,
    guardrails,
  });
}

import type { UnderlyingSymbol } from "./chains.js";
import type { ExpiryTenor, GuardrailResult } from "./types.js";

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
}

/**
 * Enforces the 3 Layer-2 Custom Range Guardrails:
 * 1. Strict alignment with standard strike grid ticks (no arbitrary decimals).
 * 2. Cap width protection matching tenor (24h daily vs 3-7d weekly) + minimum short-leg subsidy.
 * 3. Low multiplier warning when maxMultiplier < 1.30x (hard reject if <= 1.03x).
 */
export function validateCustomSpreadRange(
  input: ValidateCustomRangeInput
): GuardrailResult {
  const {
    spot,
    lowerStrike,
    upperStrike,
    tenor,
    hoursToExpiry,
    atmIv,
    availableStrikes,
    maxMultiplier,
    shortLegSubsidyRatio,
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
  const timeYears = Math.max(hoursToExpiry, 12) / (365 * 24);
  const oneSigmaPct = Math.max(0.025, atmIv * Math.sqrt(timeYears)) * 100;

  const isDaily = tenor === "DAILY" || hoursToExpiry <= 42;
  const maxAllowedWidthPct = isDaily
    ? Math.min(8.0, Math.max(7.2, 2.2 * oneSigmaPct))
    : Math.min(16.0, Math.max(14.0, 2.2 * oneSigmaPct));

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

  // Guardrail 3: Low multiplier warning (< 1.3x) / hard floor (<= 1.03x)
  let lowMultiplierWarning = false;
  if (maxMultiplier <= 1.03) {
    errors.push(
      `当前区间最高倍数仅 ${maxMultiplier.toFixed(2)}x，扣除对冲成本后已无交易弹性`
    );
  } else if (maxMultiplier < 1.3) {
    lowMultiplierWarning = true;
    warnings.push("当前区间偏保守收租，最高回报弹性较低");
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
  };
}

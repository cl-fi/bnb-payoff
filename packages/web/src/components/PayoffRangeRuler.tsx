import {
  computeRemainingStakeUsdt,
  computeSpreadPayoffFraction,
  type PositionView,
} from "@payoff/shared";
import { formatStrikePrice } from "../lib/format";
import type { Locale } from "../lib/i18n";

export interface PayoffRangeRulerProps {
  pos: PositionView;
  locale: Locale;
}

/**
 * Labeled price/payoff ruler (`Start → Breakeven → Cap`) shown inside expanded position cards.
 * Makes Payoff's linear payout and partial-refund buffer immediately unambiguous.
 */
export function PayoffRangeRuler({ pos, locale }: PayoffRangeRulerProps) {
  const isZh = locale === "zh";
  const isSettled =
    pos.status === "SETTLED_CLAIMABLE" || pos.status === "SETTLED_CLAIMED";
  const refPrice = isSettled ? pos.settlementPrice : pos.spotPrice;
  const maxRefBalance =
    pos.status === "ACTIVE" || pos.status === "SETTLED_CLAIMABLE"
      ? pos.remainingBalanceUsdt
      : pos.initialMaxPayoutUsdt;

  const payoffFrac =
    refPrice !== undefined && Number.isFinite(refPrice)
      ? computeSpreadPayoffFraction(
          pos.isUp,
          pos.lowerStrike,
          pos.upperStrike,
          refPrice
        )
      : maxRefBalance > 0
        ? Math.max(
            0,
            Math.min(
              1,
              (isSettled ? pos.claimableUsdt || pos.redeemedUsdt : pos.flatPayoutUsdt) /
                maxRefBalance
            )
          )
        : 0;

  const beFrac = computeSpreadPayoffFraction(
    pos.isUp,
    pos.lowerStrike,
    pos.upperStrike,
    pos.breakevenPrice
  );

  const spotPct = Math.round(payoffFrac * 100);
  const bePct = Math.max(2, Math.min(98, Math.round(beFrac * 100)));
  const dotLeft = Math.max(2, Math.min(98, spotPct));

  const payoffAmt = isSettled
    ? pos.status === "SETTLED_CLAIMABLE"
      ? pos.claimableUsdt
      : pos.redeemedUsdt
    : pos.flatPayoutUsdt;
  const costBasis =
    pos.status === "ACTIVE" || pos.status === "SETTLED_CLAIMABLE"
      ? computeRemainingStakeUsdt(pos)
      : pos.totalStakeUsdt;

  let accent = "#555c66";
  let textColor = "#7e8690";
  let zoneNote: string;

  if (payoffAmt <= 0.005) {
    zoneNote = isSettled
      ? isZh
        ? "未入区 · 到期赔付 $0"
        : "Out of range · $0 payout"
      : isZh
        ? "暂未入区 · 现价到期 $0"
        : "Out of range · $0 at spot";
  } else if (costBasis > 0 && payoffAmt < costBasis - 0.005) {
    accent = "#E6BA5C";
    textColor = "#E6BA5C";
    const backPct = Math.round((payoffAmt / costBasis) * 100);
    zoneNote = isSettled
      ? isZh
        ? `部分赔付 · 返还 $${payoffAmt.toFixed(2)}（回本 ${backPct}%）`
        : `Partial payout · $${payoffAmt.toFixed(2)} (${backPct}% back)`
      : isZh
        ? `部分赔付区 · 现价到期返还 $${payoffAmt.toFixed(2)}（${backPct}%）`
        : `Partial payout · $${payoffAmt.toFixed(2)} (${backPct}%) at spot`;
  } else if (payoffFrac >= 0.999) {
    accent = "#2EC26B";
    textColor = "#2EC26B";
    zoneNote = isSettled
      ? isZh
        ? `封顶全赢 · 赔付 $${payoffAmt.toFixed(2)}`
        : `Full cap win · $${payoffAmt.toFixed(2)}`
      : isZh
        ? `已达封顶 · 现价到期拿满 $${payoffAmt.toFixed(2)}`
        : `Full cap · $${payoffAmt.toFixed(2)} at spot`;
  } else {
    accent = "#2EC26B";
    textColor = "#2EC26B";
    zoneNote = isSettled
      ? isZh
        ? `盈利结算 · 赔付 $${payoffAmt.toFixed(2)}`
        : `Settled in profit · $${payoffAmt.toFixed(2)}`
      : isZh
        ? `盈利区 · 现价到期赔付 $${payoffAmt.toFixed(2)}`
        : `Profit zone · $${payoffAmt.toFixed(2)} at spot`;
  }

  const startStr = formatStrikePrice(pos.startPrice, pos.underlying);
  const capStr = formatStrikePrice(pos.capPrice, pos.underlying);
  const beStr = formatStrikePrice(pos.breakevenPrice, pos.underlying);
  const refStr =
    refPrice !== undefined && Number.isFinite(refPrice)
      ? formatStrikePrice(refPrice, pos.underlying)
      : null;

  return (
    <div className="space-y-1.5 pb-2.5 border-b border-[#1d2025] tabular-nums">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="font-medium text-[#b8bec6]">
          {refStr
            ? `${isSettled ? (isZh ? "结算价" : "Settled") : isZh ? "现价" : "Spot"} ${refStr}`
            : isZh
              ? "赔付区间"
              : "Payoff range"}
        </span>
        <span className="font-medium" style={{ color: textColor }}>
          {zoneNote}
        </span>
      </div>

      <div className="relative py-1">
        <div className="relative h-[3px] w-full rounded-full bg-[#24282f]">
          {spotPct > 0 && (
            <div
              className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-300"
              style={{ width: `${spotPct}%`, backgroundColor: accent }}
            />
          )}
          <div
            aria-hidden="true"
            title={`${isZh ? "回本线" : "Breakeven"} ${beStr}`}
            className="absolute -top-[3px] h-[9px] w-[1.5px] bg-white/75"
            style={{ left: `${bePct}%` }}
          />
          <div
            aria-hidden="true"
            className="absolute -top-[3.5px] h-[10px] w-[10px] -ml-[5px] rounded-full border-2 border-[#121417] transition-[left] duration-300"
            style={{
              left: `${dotLeft}%`,
              backgroundColor: accent === "#555c66" ? "#7e8690" : accent,
            }}
          />
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 text-[11px] text-[#7e8690]">
        <span>
          {isZh ? "起赚" : "Start"} {startStr}
        </span>
        <span className="text-[#b8bec6]">
          {isZh ? "回本" : "BE"} {beStr}
        </span>
        <span>
          {isZh ? "封顶" : "Cap"} {capStr}
        </span>
      </div>
    </div>
  );
}

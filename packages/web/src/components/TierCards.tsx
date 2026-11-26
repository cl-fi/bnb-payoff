import { Check } from "lucide-react";
import type { TicketSummary, TierKind } from "@payoff/shared";
import { formatStrikePrice } from "../lib/format";
import { getCopy, type Locale } from "../lib/i18n";

interface Props {
  locale: Locale;
  tiers: TicketSummary[];
  selectedTier: TierKind;
  onSelectTier: (tier: TicketSummary) => void;
}

export function TierCards({ locale, tiers, selectedTier, onSelectTier }: Props) {
  const t = getCopy(locale);

  const labelMap: Record<TierKind, string> = {
    CONSERVATIVE: t.tierConservative,
    STANDARD: t.tierStandard,
    BREAKOUT: t.tierBreakout,
    CUSTOM: t.tierCustom,
  };

  const tagMap: Record<string, string> = {
    CONSERVATIVE: t.tagConservative,
    STANDARD: t.tagStandard,
    BREAKOUT: t.tagBreakout,
  };

  const hintMap: Record<string, string> = {
    CONSERVATIVE: t.hintConservative,
    STANDARD: t.hintStandard,
    BREAKOUT: t.hintBreakout,
  };

  return (
    <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
      {tiers.map((tier) => {
        const isSelected = selectedTier === tier.tierKind;
        const isBull = tier.direction === "BULL";
        const dataColor = isBull ? "text-[#0e7c72]" : "text-[#b54134]";

        return (
          <button
            key={tier.tierKind}
            type="button"
            onClick={() => onSelectTier(tier)}
            className={`relative flex flex-col justify-between rounded-xl border p-4 text-left transition cursor-pointer ${
              isSelected
                ? "border-[#14202a] bg-white ring-1 ring-[#14202a] shadow-[0_4px_12px_rgba(20,32,42,0.08)]"
                : "border-[#e2e5e8] bg-white hover:border-[#c8ccd1]"
            }`}
          >
            <div>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-semibold text-[#14202a]">
                    {labelMap[tier.tierKind]}
                  </span>
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                      isSelected
                        ? "bg-[#14202a] text-white"
                        : "bg-[#eef0f2] text-[#3a4552]"
                    }`}
                  >
                    {tagMap[tier.tierKind]}
                  </span>
                </div>
                {isSelected && (
                  <span className="flex h-4 w-4 items-center justify-center rounded-full bg-[#14202a] text-white">
                    <Check className="h-2.5 w-2.5 stroke-[3]" />
                  </span>
                )}
              </div>

              <div className="mt-2.5 flex items-baseline justify-between">
                <div className="text-xs font-medium text-[#667080] tabular-nums">
                  {formatStrikePrice(tier.startPrice, tier.underlying)} →{" "}
                  {formatStrikePrice(tier.capPrice, tier.underlying)}
                </div>
                <div
                  className={`text-2xl font-bold tracking-tight tabular-nums ${dataColor}`}
                >
                  {tier.maxMultiplier.toFixed(2)}x
                </div>
              </div>
            </div>

            <div className="mt-3 flex items-center justify-between border-t border-[#eef0f2] pt-2.5 text-[11px] text-[#667080]">
              <span>{hintMap[tier.tierKind]}</span>
              <span className="font-semibold text-[#14202a] tabular-nums">
                {tier.flatPayoutUsdt > 0
                  ? t.flatReturnShort(tier.flatReturnPct.toFixed(0))
                  : t.breakevenShort(
                      `${tier.breakevenPct >= 0 ? "+" : ""}${tier.breakevenPct.toFixed(2)}`
                    )}
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

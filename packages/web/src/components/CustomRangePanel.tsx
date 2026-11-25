import { AlertTriangle, ChevronDown, ChevronUp, SlidersHorizontal } from "lucide-react";
import type { TicketSummary } from "@payoff/shared";
import { getCopy, type Locale } from "../lib/i18n";

interface Props {
  locale: Locale;
  expanded: boolean;
  onToggle: () => void;
  availableStrikes: number[];
  lowerStrike: number;
  upperStrike: number;
  customTicket?: TicketSummary;
  onChangeStrikes: (lower: number, upper: number) => void;
}

export function CustomRangePanel({
  locale,
  expanded,
  onToggle,
  availableStrikes,
  lowerStrike,
  upperStrike,
  customTicket,
  onChangeStrikes,
}: Props) {
  const t = getCopy(locale);
  const lowerIdx = Math.max(
    0,
    availableStrikes.findIndex((s) => s === lowerStrike)
  );
  const upperIdx = Math.max(
    lowerIdx + 1,
    availableStrikes.findIndex((s) => s === upperStrike)
  );
  const maxIdx = Math.max(1, availableStrikes.length - 1);

  const setLowerByIdx = (idx: number) => {
    const clamped = Math.max(0, Math.min(upperIdx - 1, idx));
    onChangeStrikes(availableStrikes[clamped], availableStrikes[upperIdx]);
  };

  const setUpperByIdx = (idx: number) => {
    const clamped = Math.max(lowerIdx + 1, Math.min(maxIdx, idx));
    onChangeStrikes(availableStrikes[lowerIdx], availableStrikes[clamped]);
  };

  const g = customTicket?.guardrails;

  return (
    <div className="rounded-xl border border-[#e2e5e8] bg-white overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between px-4 py-3.5 text-left transition hover:bg-[#f7f8f9] cursor-pointer"
      >
        <div className="flex flex-wrap items-center gap-2">
          <SlidersHorizontal className="h-4 w-4 text-[#14202a]" />
          <span className="text-sm font-semibold text-[#14202a]">
            {t.customRangeTitle}
          </span>
          <span className="rounded bg-[#eef0f2] px-2 py-0.5 text-[11px] font-medium text-[#667080]">
            {t.customRangeBadge}
          </span>
        </div>
        {expanded ? (
          <ChevronUp className="h-4 w-4 text-[#667080]" />
        ) : (
          <ChevronDown className="h-4 w-4 text-[#667080]" />
        )}
      </button>

      {expanded && (
        <div className="border-t border-[#eef0f2] p-4 space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="rounded-xl bg-[#f7f8f9] border border-[#e2e5e8] p-3.5 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-[#667080]">
                  {t.lowerBound}
                </span>
                <span className="text-base font-bold text-[#14202a] tabular-nums">
                  ${(availableStrikes[lowerIdx] ?? lowerStrike).toLocaleString()}
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={Math.max(0, upperIdx - 1)}
                step={1}
                value={lowerIdx}
                onChange={(e) => setLowerByIdx(Number(e.target.value))}
                className="w-full cursor-pointer"
              />
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setLowerByIdx(lowerIdx - 1)}
                  disabled={lowerIdx <= 0}
                  className="flex-1 rounded-lg border border-[#c8ccd1] bg-white py-1.5 text-xs font-medium text-[#14202a] hover:bg-[#f7f8f9] disabled:opacity-40 cursor-pointer"
                >
                  {t.stepDown}
                </button>
                <button
                  type="button"
                  onClick={() => setLowerByIdx(lowerIdx + 1)}
                  disabled={lowerIdx >= upperIdx - 1}
                  className="flex-1 rounded-lg border border-[#c8ccd1] bg-white py-1.5 text-xs font-medium text-[#14202a] hover:bg-[#f7f8f9] disabled:opacity-40 cursor-pointer"
                >
                  {t.stepUp}
                </button>
              </div>
            </div>

            <div className="rounded-xl bg-[#f7f8f9] border border-[#e2e5e8] p-3.5 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-[#667080]">
                  {t.upperBound}
                </span>
                <span className="text-base font-bold text-[#14202a] tabular-nums">
                  ${(availableStrikes[upperIdx] ?? upperStrike).toLocaleString()}
                </span>
              </div>
              <input
                type="range"
                min={Math.min(maxIdx, lowerIdx + 1)}
                max={maxIdx}
                step={1}
                value={upperIdx}
                onChange={(e) => setUpperByIdx(Number(e.target.value))}
                className="w-full cursor-pointer"
              />
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setUpperByIdx(upperIdx - 1)}
                  disabled={upperIdx <= lowerIdx + 1}
                  className="flex-1 rounded-lg border border-[#c8ccd1] bg-white py-1.5 text-xs font-medium text-[#14202a] hover:bg-[#f7f8f9] disabled:opacity-40 cursor-pointer"
                >
                  {t.stepDown}
                </button>
                <button
                  type="button"
                  onClick={() => setUpperByIdx(upperIdx + 1)}
                  disabled={upperIdx >= maxIdx}
                  className="flex-1 rounded-lg border border-[#c8ccd1] bg-white py-1.5 text-xs font-medium text-[#14202a] hover:bg-[#f7f8f9] disabled:opacity-40 cursor-pointer"
                >
                  {t.stepUp}
                </button>
              </div>
            </div>
          </div>

          {g && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-[#667080]">
                <span>{t.alignedNotice}</span>
                <span className="tabular-nums font-medium">
                  {t.widthInfo(g.widthPct.toFixed(1), g.maxAllowedWidthPct.toFixed(1))}
                </span>
              </div>

              {g.errors.map((err, i) => (
                <div
                  key={i}
                  className="flex items-start gap-2 rounded-lg bg-[#fbeeea] px-3.5 py-2.5 text-xs font-medium text-[#b54134]"
                >
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{err}</span>
                </div>
              ))}

              {g.warnings.map((w, i) => (
                <div
                  key={i}
                  className="flex items-start gap-2 rounded-lg bg-[#fbf3dd] px-3.5 py-2.5 text-xs font-medium text-[#8a6410]"
                >
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{w}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

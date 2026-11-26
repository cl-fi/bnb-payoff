import { useEffect, useId, useMemo, useRef } from "react";
import { Building2, Check, X } from "lucide-react";
import {
  ASSET_SPECS,
  SUPPORTED_UNDERLYINGS,
  type PositionView,
  type RwaAssetTelemetry,
  type UnderlyingSymbol,
} from "@payoff/shared";
import type { Locale } from "../lib/i18n";

export interface MarketPickerSheetProps {
  open: boolean;
  locale: Locale;
  selectedUnderlying: UnderlyingSymbol;
  liveSpots: Record<UnderlyingSymbol, { spot: number; change24hPct: number }>;
  liveRwaTelemetry?: Partial<Record<UnderlyingSymbol, RwaAssetTelemetry>>;
  positions?: PositionView[];
  onSelectUnderlying: (underlying: UnderlyingSymbol) => void;
  onClose: () => void;
}

const ASSET_SUBTITLES: Record<
  UnderlyingSymbol,
  { zh: string; en: string; badge: string }
> = {
  BTC: { zh: "比特币", en: "Bitcoin", badge: "₿" },
  ETH: { zh: "以太坊", en: "Ethereum", badge: "Ξ" },
  NVDAB: { zh: "英伟达 · 美股 RWA", en: "NVIDIA · US Stock RWA", badge: "N" },
};

function formatSpotPrice(spot: number, underlying: UnderlyingSymbol): string {
  if (!Number.isFinite(spot) || spot <= 0) return "--";
  const decimals = underlying === "BTC" ? 2 : 2;
  return `$${spot.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

export function MarketPickerSheet({
  open,
  locale,
  selectedUnderlying,
  liveSpots,
  liveRwaTelemetry,
  positions = [],
  onSelectUnderlying,
  onClose,
}: MarketPickerSheetProps) {
  const isZh = locale === "zh";
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  // Safari fallback for declarative <dialog closedby="any">
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) return;
    if ("closedBy" in HTMLDialogElement.prototype) return;

    const isOutside = (e: PointerEvent) => {
      const r = dialog.getBoundingClientRect();
      return (
        e.clientX < r.left ||
        e.clientX > r.right ||
        e.clientY < r.top ||
        e.clientY > r.bottom
      );
    };

    let pressedOutside = false;
    const onPointerDown = (e: PointerEvent) => {
      pressedOutside = isOutside(e);
    };
    const onPointerUp = (e: PointerEvent) => {
      if (pressedOutside && isOutside(e)) {
        dialog.close();
      }
      pressedOutside = false;
    };

    dialog.addEventListener("pointerdown", onPointerDown);
    dialog.addEventListener("pointerup", onPointerUp);
    return () => {
      dialog.removeEventListener("pointerdown", onPointerDown);
      dialog.removeEventListener("pointerup", onPointerUp);
    };
  }, [open]);

  const positionCounts = useMemo(() => {
    const counts: Record<UnderlyingSymbol, number> = {
      BTC: 0,
      ETH: 0,
      NVDAB: 0,
    };
    for (const p of positions) {
      if (p.status === "ACTIVE" || p.status === "SETTLED_CLAIMABLE") {
        counts[p.underlying] = (counts[p.underlying] ?? 0) + 1;
      }
    }
    return counts;
  }, [positions]);

  if (!open) return null;

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      {...({ closedby: "any" } as Record<string, unknown>)}
      onClose={() => {
        if (dialogRef.current) dialogRef.current.returnValue = "";
        onClose();
      }}
      className="payoff-sheet"
    >
      <div className="flex max-h-[90dvh] flex-col md:max-h-[86dvh]">
        <div aria-hidden="true" className="payoff-sheet-handle" />

        <div className="overflow-y-auto px-5 pt-3 pb-6 sm:px-6 safe-pb space-y-4">
          {/* Header */}
          <div className="flex items-start justify-between gap-3">
            <div>
              <h1
                id={titleId}
                className="text-[19px] font-bold tracking-[-0.02em] text-white"
              >
                {isZh ? "选择市场" : "Select market"}
              </h1>
              <p className="mt-0.5 text-xs text-[#7e8690]">
                {isZh
                  ? "加密主流币 & 24/7 美股 RWA · 连续赔付"
                  : "Crypto majors & 24/7 US Equity RWA · Linear payoff"}
              </p>
            </div>
            <button
              type="button"
              autoFocus
              aria-label={isZh ? "关闭" : "Close"}
              onClick={() => dialogRef.current?.close()}
              className="rounded-full p-1.5 text-[#7e8690] hover:bg-[#24282f] hover:text-white transition cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>

          {/* Market Hairline List */}
          <div className="divide-y divide-[#1d2025]">
            {SUPPORTED_UNDERLYINGS.map((u) => {
              const spec = ASSET_SPECS[u];
              const isSelected = selectedUnderlying === u;
              const isRwa = spec.assetClass === "RWA_EQUITY";
              const spotInfo = liveSpots[u];
              const spot = spotInfo?.spot ?? spec.defaultSpot;
              const changePct = spotInfo?.change24hPct ?? 0;
              const isUp = changePct >= 0;
              const activeCount = positionCounts[u] ?? 0;
              const rwaSession = isRwa ? liveRwaTelemetry?.[u]?.session : undefined;

              const cadenceText = isRwa
                ? isZh
                  ? "美股收盘 21:00 UTC · 周一/三/五"
                  : "US Close 21:00 UTC · Mon/Wed/Fri"
                : isZh
                  ? "每日 08:00 UTC · 周五周度"
                  : "Daily 08:00 UTC · Weekly Fri";

              const rwaBadge =
                rwaSession === "RTH"
                  ? {
                      label: isZh ? "美股盘中" : "US Open",
                      cls: "bg-[#2EC26B]/13 text-[#2EC26B]",
                    }
                  : rwaSession === "EXTENDED"
                    ? {
                        label: isZh ? "盘前/盘后" : "Extended",
                        cls: "bg-[#E6BA5C]/12 text-[#E6BA5C]",
                      }
                    : rwaSession === "WEEKEND"
                      ? {
                          label: isZh ? "周末 24/7" : "Weekend 24/7",
                          cls: "bg-[#24282f] text-[#b8bec6]",
                        }
                      : null;

              return (
                <button
                  key={u}
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => {
                    onSelectUnderlying(u);
                    dialogRef.current?.close();
                  }}
                  className={`flex w-full items-center justify-between gap-3 py-3.5 px-2 -mx-2 rounded-2xl text-left transition cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white ${
                    isSelected
                      ? "bg-[#15171b]"
                      : "hover:bg-[#15171b]/70 active:bg-[#15171b]"
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span
                      aria-hidden="true"
                      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-bold ${
                        isSelected
                          ? "bg-white text-black"
                          : "bg-[#15171b] border border-[#24282e] text-white"
                      }`}
                    >
                      {isRwa ? (
                        <Building2 className="h-4 w-4" />
                      ) : (
                        ASSET_SUBTITLES[u].badge
                      )}
                    </span>

                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[15px] font-bold text-white tracking-[-0.01em]">
                          {spec.displaySymbol}
                        </span>
                        <span className="text-xs text-[#7e8690]">
                          {isZh ? ASSET_SUBTITLES[u].zh : ASSET_SUBTITLES[u].en}
                        </span>
                        {isRwa && (
                          <span className="rounded-full bg-[#24282f] px-1.5 py-0.5 text-[10px] font-bold text-[#b8bec6]">
                            RWA
                          </span>
                        )}
                        {rwaBadge && (
                          <span
                            className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${rwaBadge.cls}`}
                          >
                            {rwaBadge.label}
                          </span>
                        )}
                      </div>

                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-[#7e8690]">
                        <span>{cadenceText}</span>
                        {activeCount > 0 && (
                          <span className="inline-flex items-center gap-1 font-semibold text-[#2EC26B] tabular-nums">
                            <span
                              aria-hidden="true"
                              className="h-1.5 w-1.5 rounded-full bg-[#2EC26B]"
                            />
                            {isZh
                              ? `${activeCount} 笔持仓`
                              : `${activeCount} active`}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2.5 shrink-0">
                    <div className="text-right tabular-nums">
                      <div className="text-[15px] font-bold text-white tracking-[-0.02em]">
                        {formatSpotPrice(spot, u)}
                      </div>
                      <div
                        className={`text-xs font-semibold ${
                          isUp ? "text-[#2EC26B]" : "text-[#E85D4A]"
                        }`}
                      >
                        {isUp ? "+" : ""}
                        {changePct.toFixed(2)}%
                      </div>
                    </div>

                    {isSelected && (
                      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-white text-black">
                        <Check className="h-3.5 w-3.5" aria-hidden="true" />
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </dialog>
  );
}

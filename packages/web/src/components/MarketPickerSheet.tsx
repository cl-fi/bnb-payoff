import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, X } from "lucide-react";
import {
  ASSET_SPECS,
  type PositionView,
  type RwaAssetTelemetry,
  type UnderlyingSymbol,
} from "@payoff/shared";
import type { Locale } from "../lib/i18n";
import { useAnchoredMenu } from "../lib/useAnchoredMenu";

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

export interface MarketSelectorProps {
  locale: Locale;
  selectedUnderlying: UnderlyingSymbol;
  assetSubtitle: string;
  liveSpots: Record<UnderlyingSymbol, { spot: number; change24hPct: number }>;
  liveRwaTelemetry?: Partial<Record<UnderlyingSymbol, RwaAssetTelemetry>>;
  positions?: PositionView[];
  disabled?: boolean;
  externalOpen?: boolean;
  onOpenExternal?: () => void;
  onCloseExternal?: () => void;
  onSelectUnderlying: (underlying: UnderlyingSymbol) => void;
}

const MARKET_PICKER_ORDER: readonly UnderlyingSymbol[] = [
  "NVDAB",
  "BTC",
  "ETH",
];

const ASSET_META: Record<
  UnderlyingSymbol,
  { zh: string; en: string; logoSrc: string }
> = {
  BTC: { zh: "比特币", en: "Bitcoin", logoSrc: "/markets/btc.svg" },
  ETH: { zh: "以太坊", en: "Ethereum", logoSrc: "/markets/eth.svg" },
  NVDAB: { zh: "英伟达", en: "NVIDIA", logoSrc: "/markets/nvda.svg" },
};

function formatSpotPrice(spot: number): string {
  if (!Number.isFinite(spot) || spot <= 0) return "--";
  return `$${spot.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

interface MarketRowListProps {
  mode: "dropdown" | "sheet";
  locale: Locale;
  selectedUnderlying: UnderlyingSymbol;
  liveSpots: Record<UnderlyingSymbol, { spot: number; change24hPct: number }>;
  liveRwaTelemetry?: Partial<Record<UnderlyingSymbol, RwaAssetTelemetry>>;
  positionCounts: Record<UnderlyingSymbol, number>;
  onSelect: (underlying: UnderlyingSymbol) => void;
}

function MarketRowList({
  mode,
  locale,
  selectedUnderlying,
  liveSpots,
  liveRwaTelemetry,
  positionCounts,
  onSelect,
}: MarketRowListProps) {
  const isZh = locale === "zh";
  const isDropdown = mode === "dropdown";

  return (
    <div
      role={isDropdown ? "group" : undefined}
      aria-label={isDropdown ? (isZh ? "可用市场" : "Available markets") : undefined}
      className={isDropdown ? "flex flex-col gap-0.5" : "divide-y divide-[#1d2025]"}
    >
      {MARKET_PICKER_ORDER.map((u) => {
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
            ? "美股收盘 21:00 UTC"
            : "US Close 21:00 UTC"
          : isZh
            ? "每日 08:00 UTC · 周五周度"
            : "Daily 08:00 UTC · Weekly Fri";

        const rwaSessionMeta =
          rwaSession === "RTH"
            ? {
                label: isZh ? "盘中" : "US Open",
                dotCls: "bg-[#2EC26B]",
                textCls: "text-[#2EC26B]",
              }
            : rwaSession === "EXTENDED"
              ? {
                  label: isZh ? "盘前/盘后" : "Extended",
                  dotCls: "bg-[#E6BA5C]",
                  textCls: "text-[#E6BA5C]",
                }
              : rwaSession === "WEEKEND"
                ? {
                    label: isZh ? "周末 24/7" : "Weekend 24/7",
                    dotCls: "bg-[#7e8690]",
                    textCls: "text-[#b8bec6]",
                  }
                : null;

        return (
          <button
            key={u}
            type="button"
            role={isDropdown ? "menuitemradio" : undefined}
            aria-checked={isDropdown ? isSelected : undefined}
            aria-pressed={!isDropdown ? isSelected : undefined}
            onClick={() => onSelect(u)}
            className={
              isDropdown
                ? `flex w-full items-center justify-between gap-3 rounded-xl px-2.5 py-2.5 text-left transition cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-white/75 ${
                    isSelected
                      ? "bg-[#1a1e24]"
                      : "hover:bg-[#1a1e24]/80 active:bg-[#1a1e24]"
                  }`
                : `flex w-full items-center justify-between gap-3 py-3.5 px-2 -mx-2 rounded-2xl text-left transition cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white ${
                    isSelected
                      ? "bg-[#15171b]"
                      : "hover:bg-[#15171b]/70 active:bg-[#15171b]"
                  }`
            }
          >
            <div className="flex items-center gap-2.5 sm:gap-3 min-w-0">
              <img
                src={ASSET_META[u].logoSrc}
                alt=""
                aria-hidden="true"
                width={isDropdown ? 36 : 40}
                height={isDropdown ? 36 : 40}
                decoding="async"
                className={`shrink-0 rounded-full object-cover ${
                  isDropdown ? "h-9 w-9" : "h-10 w-10"
                }`}
              />

              <div className="min-w-0">
                {/* Line 1: Ticker + concise asset name + RWA pill */}
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="text-[14.5px] font-bold text-white tracking-[-0.01em] shrink-0">
                    {spec.displaySymbol}
                  </span>
                  <span className="text-xs text-[#7e8690] truncate">
                    {isZh ? ASSET_META[u].zh : ASSET_META[u].en}
                  </span>
                  {isRwa && (
                    <span className="shrink-0 rounded-full bg-[#24282f] px-1.5 py-0.5 text-[10px] font-bold leading-none text-[#b8bec6]">
                      RWA
                    </span>
                  )}
                </div>

                {/* Line 2: Uniform single-line metadata (session dot + cadence + active positions) */}
                <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-[#7e8690] truncate">
                  {rwaSessionMeta && (
                    <>
                      <span
                        className={`inline-flex shrink-0 items-center gap-1 font-semibold ${rwaSessionMeta.textCls}`}
                      >
                        <span
                          aria-hidden="true"
                          className={`h-1.5 w-1.5 rounded-full ${rwaSessionMeta.dotCls}`}
                        />
                        {rwaSessionMeta.label}
                      </span>
                      <span aria-hidden="true" className="text-[#4a5058]">
                        ·
                      </span>
                    </>
                  )}
                  <span className="truncate">{cadenceText}</span>
                  {activeCount > 0 && (
                    <>
                      <span aria-hidden="true" className="text-[#4a5058]">
                        ·
                      </span>
                      <span className="inline-flex shrink-0 items-center gap-1 font-semibold text-[#2EC26B] tabular-nums">
                        <span
                          aria-hidden="true"
                          className="h-1.5 w-1.5 rounded-full bg-[#2EC26B]"
                        />
                        {isZh ? `${activeCount} 笔` : `${activeCount} open`}
                      </span>
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* Right: Price column aligned strictly across all rows via fixed-width check slot */}
            <div className="flex items-center gap-2.5 shrink-0">
              <div className="text-right tabular-nums">
                <div className="text-[14.5px] font-bold text-white tracking-[-0.02em] leading-snug">
                  {formatSpotPrice(spot)}
                </div>
                <div
                  className={`text-[11.5px] font-semibold leading-snug ${
                    isUp ? "text-[#2EC26B]" : "text-[#E85D4A]"
                  }`}
                >
                  {isUp ? "+" : ""}
                  {changePct.toFixed(2)}%
                </div>
              </div>

              <span
                aria-hidden="true"
                className="flex h-5 w-5 shrink-0 items-center justify-center"
              >
                {isSelected && (
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-white text-black">
                    <Check className="h-3.5 w-3.5" />
                  </span>
                )}
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Adaptive Market Selector:
 * - Desktop (>= 768px): Anchored top-layer popover dropdown directly below trigger (no backdrop dim/blur)
 * - Mobile (< 768px): Native bottom-sheet <dialog> for thumb reachability
 */
export function MarketSelector({
  locale,
  selectedUnderlying,
  assetSubtitle,
  liveSpots,
  liveRwaTelemetry,
  positions = [],
  disabled = false,
  externalOpen = false,
  onOpenExternal,
  onCloseExternal,
  onSelectUnderlying,
}: MarketSelectorProps) {
  const isZh = locale === "zh";
  const spec = ASSET_SPECS[selectedUnderlying];
  const isRwaAsset = spec.assetClass === "RWA_EQUITY";

  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window !== "undefined"
      ? window.matchMedia("(min-width: 768px)").matches
      : true
  );
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const sync = () => setIsDesktop(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  const desktopMenu = useAnchoredMenu({
    align: "start",
    enabled: isDesktop,
    externalOpen: isDesktop && externalOpen,
    onClose: onCloseExternal,
  });

  // Sync external open requests (e.g. from WalletModal) on mobile
  useEffect(() => {
    if (!isDesktop && externalOpen) {
      setMobileSheetOpen(true);
    }
  }, [isDesktop, externalOpen]);

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

  const isExpanded = isDesktop ? desktopMenu.open : mobileSheetOpen;

  const handleDesktopSelect = (u: UnderlyingSymbol) => {
    onSelectUnderlying(u);
    desktopMenu.hideMenu(true);
  };

  const handleCloseMobileSheet = () => {
    setMobileSheetOpen(false);
    onCloseExternal?.();
  };

  return (
    <div className="relative inline-flex items-center">
      <button
        id={isDesktop ? desktopMenu.triggerId : undefined}
        ref={desktopMenu.triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup={isDesktop ? "menu" : "dialog"}
        aria-expanded={isExpanded}
        onPointerDown={isDesktop ? desktopMenu.onTriggerPointerDown : undefined}
        onKeyDown={isDesktop ? desktopMenu.onTriggerKeyDown : undefined}
        onClick={
          isDesktop
            ? undefined
            : () => {
                setMobileSheetOpen(true);
                onOpenExternal?.();
              }
        }
        {...(isDesktop ? desktopMenu.triggerInvokerProps : {})}
        className={`group -ml-2.5 inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-left transition cursor-pointer disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white ${
          isExpanded ? "bg-[#15171b]" : "hover:bg-[#15171b]"
        }`}
      >
        <img
          src={ASSET_META[selectedUnderlying].logoSrc}
          alt=""
          aria-hidden="true"
          width={24}
          height={24}
          decoding="async"
          className="h-6 w-6 shrink-0 rounded-full object-cover"
        />
        <span className="text-lg font-bold tracking-[-0.02em] text-white">
          {spec.displaySymbol}
        </span>
        <span className="text-sm font-medium text-[#7e8690] group-hover:text-[#b8bec6] transition">
          {assetSubtitle}
        </span>
        {isRwaAsset && (
          <span className="rounded-full bg-[#1f2329] px-2 py-0.5 text-[10px] font-bold tracking-wide text-[#b8bec6]">
            RWA
          </span>
        )}
        <ChevronDown
          className={`h-4 w-4 transition-transform duration-150 ${
            isExpanded
              ? "rotate-180 text-white"
              : "text-[#7e8690] group-hover:text-white"
          }`}
          aria-hidden="true"
        />
      </button>

      {/* Desktop Anchored Popover Dropdown (immediately after trigger for implicit anchor & zero aria-details) */}
      {isDesktop && (
        <div
          id={desktopMenu.popoverId}
          ref={desktopMenu.popoverRef}
          {...(desktopMenu.supportsPopover ? { popover: "auto" } : {})}
          onKeyDown={desktopMenu.onPopoverKeyDown}
          className={`payoff-popover payoff-popover--start w-[min(92vw,376px)] ${
            !desktopMenu.supportsPopover && !desktopMenu.open ? "hidden" : ""
          }`}
        >
          <div
            ref={desktopMenu.menuGroupRef}
            {...({ focusgroup: "menu nomemory" } as Record<string, unknown>)}
            aria-labelledby={desktopMenu.triggerId}
            className="p-1.5"
          >
            <MarketRowList
              mode="dropdown"
              locale={locale}
              selectedUnderlying={selectedUnderlying}
              liveSpots={liveSpots}
              liveRwaTelemetry={liveRwaTelemetry}
              positionCounts={positionCounts}
              onSelect={handleDesktopSelect}
            />
          </div>
        </div>
      )}

      {/* Mobile Native Bottom Sheet */}
      {!isDesktop && (
        <MarketPickerSheet
          open={mobileSheetOpen}
          locale={locale}
          selectedUnderlying={selectedUnderlying}
          liveSpots={liveSpots}
          liveRwaTelemetry={liveRwaTelemetry}
          positions={positions}
          onSelectUnderlying={(u) => {
            onSelectUnderlying(u);
            handleCloseMobileSheet();
          }}
          onClose={handleCloseMobileSheet}
        />
      )}
    </div>
  );
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

          <MarketRowList
            mode="sheet"
            locale={locale}
            selectedUnderlying={selectedUnderlying}
            liveSpots={liveSpots}
            liveRwaTelemetry={liveRwaTelemetry}
            positionCounts={positionCounts}
            onSelect={(u) => {
              onSelectUnderlying(u);
              dialogRef.current?.close();
            }}
          />
        </div>
      </div>
    </dialog>
  );
}

import { Check, ChevronDown, Globe, Loader2 } from "lucide-react";
import type { ConnectedWallet } from "../lib/wallet";
import {
  getCopy,
  getLocaleOption,
  SUPPORTED_LOCALES,
  type Locale,
} from "../lib/i18n";
import { useAnchoredMenu } from "../lib/useAnchoredMenu";
import { PayoffLockup } from "./PayoffMark";

export type ConsumerTab = "TRADE" | "POSITIONS";

export interface HeaderProps {
  activeTab?: ConsumerTab;
  onSelectTab?: (tab: ConsumerTab) => void;
  /** Optional navigation aliases for compatibility */
  activePage?: ConsumerTab;
  onNavigate?: (tab: ConsumerTab) => void;
  locale: Locale;
  onSelectLocale?: (locale: Locale) => void;
  onToggleLocale?: () => void;
  wallet: ConnectedWallet;
  authReady?: boolean;
  authInitializing?: boolean;
  /** Total active + claimable position count rendered in the white pill badge */
  positionCount: number;
  /** Optional count of settled claimable positions to surface an emerald cue */
  claimableCount?: number;
  /** Opens Account Drawer when authenticated, or email login when unauthenticated */
  onOpenWalletModal?: () => void;
  /** Optional alias for onOpenWalletModal */
  onOpenWallet?: () => void;
  /** Optional explicit login handler when unauthenticated */
  onLogin?: () => void;
}

function formatCompactBalance(balance: number): string {
  if (!Number.isFinite(balance)) return "$0";
  const rounded = balance >= 100 ? Math.floor(balance) : balance;
  return `$${rounded.toLocaleString("en-US", {
    maximumFractionDigits: balance >= 100 ? 0 : 2,
  })}`;
}

export function Header({
  onSelectTab,
  onNavigate,
  locale,
  onSelectLocale,
  onToggleLocale,
  wallet,
  authReady = true,
  authInitializing = false,
  positionCount,
  claimableCount = 0,
  onOpenWalletModal,
  onOpenWallet,
  onLogin,
}: HeaderProps) {
  const t = getCopy(locale);
  const currentLocale = getLocaleOption(locale);
  const isConnected = wallet.kind !== "NONE" && Boolean(wallet.address);

  const langMenu = useAnchoredMenu({ align: "end" });

  const navigate = (tab: ConsumerTab) => {
    (onSelectTab ?? onNavigate)?.(tab);
  };

  const handleAccountClick = () => {
    if (!isConnected && onLogin) {
      onLogin();
      return;
    }
    (onOpenWalletModal ?? onOpenWallet)?.();
  };

  const handleChooseLocale = (next: Locale) => {
    if (next !== locale) {
      if (onSelectLocale) {
        onSelectLocale(next);
      } else {
        onToggleLocale?.();
      }
    }
    langMenu.hideMenu(true);
  };

  return (
    <header className="sticky top-0 z-30 h-14 bg-black/90 backdrop-blur-md">
      <div className="mx-auto flex h-full max-w-[1160px] items-center justify-between px-4 sm:px-6">
        {/* Official Reversed #F6F7F5 Payoff Brand Lockup */}
        <button
          type="button"
          onClick={() => navigate("TRADE")}
          aria-label="Payoff home"
          className="inline-flex items-center cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white rounded-md"
        >
          <PayoffLockup markSize={22} />
        </button>

        {/* Right: Globe Language Dropdown + Account Pill */}
        <div className="flex items-center gap-2">
          <button
            id={langMenu.triggerId}
            ref={langMenu.triggerRef}
            type="button"
            aria-haspopup="menu"
            aria-expanded={langMenu.open}
            onPointerDown={langMenu.onTriggerPointerDown}
            onKeyDown={langMenu.onTriggerKeyDown}
            {...langMenu.triggerInvokerProps}
            className={`inline-flex h-8 min-w-8 items-center justify-center gap-1.5 rounded-full px-2 sm:px-2.5 text-xs font-semibold transition cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white ${
              langMenu.open
                ? "bg-[#24282f] text-white"
                : "bg-[#15171b] text-[#b8bec6] hover:bg-[#24282f] hover:text-white"
            }`}
          >
            <Globe className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="sr-only">
              {locale === "zh" ? "语言 " : "Language "}
            </span>
            <span className="hidden sm:inline leading-none">
              {currentLocale.shortLabel}
            </span>
            <ChevronDown
              className={`hidden sm:inline h-3 w-3 shrink-0 transition-transform duration-150 ${
                langMenu.open ? "rotate-180 text-white" : "text-[#7e8690]"
              }`}
              aria-hidden="true"
            />
          </button>

          {/* Anchored Language Popover Menu (immediately after trigger for implicit anchor & zero aria-details) */}
          <div
            id={langMenu.popoverId}
            ref={langMenu.popoverRef}
            {...(langMenu.supportsPopover ? { popover: "auto" } : {})}
            onKeyDown={langMenu.onPopoverKeyDown}
            className={`payoff-popover payoff-popover--end min-w-[164px] ${
              !langMenu.supportsPopover && !langMenu.open ? "hidden" : ""
            }`}
          >
            <div
              ref={langMenu.menuGroupRef}
              {...({ focusgroup: "menu nomemory" } as Record<string, unknown>)}
              aria-labelledby={langMenu.triggerId}
              className="p-1.5"
            >
              <div
                role="group"
                aria-label={locale === "zh" ? "选择语言" : "Select language"}
                className="flex flex-col gap-0.5"
              >
                {SUPPORTED_LOCALES.map((opt) => {
                  const isSelected = opt.code === locale;
                  return (
                    <button
                      key={opt.code}
                      type="button"
                      role="menuitemradio"
                      aria-checked={isSelected}
                      lang={opt.htmlLang}
                      onClick={() => handleChooseLocale(opt.code)}
                      className={`flex min-h-[38px] w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left text-[13px] transition cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-white/75 ${
                        isSelected
                          ? "bg-[#1a1e24] font-semibold text-white"
                          : "font-medium text-[#b8bec6] hover:bg-[#1a1e24]/80 hover:text-white"
                      }`}
                    >
                      <span>{opt.nativeName}</span>
                      <span
                        className="flex h-4 w-4 shrink-0 items-center justify-center"
                        aria-hidden="true"
                      >
                        {isSelected && (
                          <Check className="h-3.5 w-3.5 text-[#2EC26B]" />
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <button
            type="button"
            disabled={!authReady}
            onClick={handleAccountClick}
            title={wallet.email || wallet.address || undefined}
            aria-label={isConnected ? t.drawerTitle : t.connectWallet}
            className={`inline-flex items-center gap-1.5 rounded-full text-xs font-semibold transition cursor-pointer disabled:opacity-55 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white ${
              isConnected
                ? "bg-[#15171b] px-3 py-1.5 text-white hover:bg-[#24282f]"
                : authInitializing
                  ? "bg-[#15171b] px-3 py-1.5 text-[#b8bec6]"
                  : "bg-white px-3.5 py-1.5 font-bold text-black hover:bg-[#e8eaed]"
            }`}
          >
            {isConnected ? (
              <>
                <span className="tabular-nums font-semibold tracking-[-0.01em]">
                  {formatCompactBalance(wallet.usdtBalance)}
                </span>
                {positionCount > 0 && (
                  <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-white px-1 text-[10px] font-bold text-black tabular-nums leading-none">
                    {positionCount}
                  </span>
                )}
                {claimableCount > 0 && (
                  <span
                    className="h-1.5 w-1.5 rounded-full bg-[#2ec26b] shrink-0"
                    aria-hidden="true"
                  />
                )}
                <ChevronDown
                  className="h-3.5 w-3.5 text-[#7e8690]"
                  aria-hidden="true"
                />
              </>
            ) : authInitializing ? (
              <>
                <Loader2
                  className="h-3.5 w-3.5 animate-spin text-[#b8bec6]"
                  aria-hidden="true"
                />
                <span>{t.initializingWallet}</span>
              </>
            ) : (
              <span>{t.connectWallet}</span>
            )}
          </button>
        </div>
      </div>
    </header>
  );
}

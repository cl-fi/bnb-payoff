import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  Globe,
  KeyRound,
  Loader2,
  LogOut,
  PieChart,
  User,
  Wallet,
} from "lucide-react";
import { BSC_TESTNET } from "@payoff/shared";
import { getExplorerBaseUrl, type ConnectedWallet } from "../lib/wallet";
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
  /** Total active + claimable position count rendered in the badge */
  positionCount: number;
  /** Optional count of settled claimable positions to surface an emerald cue */
  claimableCount?: number;
  /** Navigates to Portfolio when authenticated, or email login when unauthenticated */
  onOpenWalletModal?: () => void;
  /** Optional alias for onOpenWalletModal */
  onOpenWallet?: () => void;
  /** Optional explicit login handler when unauthenticated */
  onLogin?: () => void;
  /** Export Privy embedded wallet key from avatar account menu */
  onExportWallet?: () => void;
  /** Sign out from avatar account menu */
  onDisconnect?: () => void;
}

function formatCompactBalance(balance: number): string {
  if (!Number.isFinite(balance)) return "$0";
  const rounded = balance >= 100 ? Math.floor(balance) : balance;
  return `$${rounded.toLocaleString("en-US", {
    maximumFractionDigits: balance >= 100 ? 0 : 2,
  })}`;
}

function getAccountInitial(wallet: ConnectedWallet): string | null {
  const source = wallet.email?.trim() || wallet.walletName?.trim();
  if (!source) return null;
  const ch = source[0];
  return ch ? ch.toUpperCase() : null;
}

let lastHeaderCopyAnnouncement = "";

export function Header({
  activeTab,
  activePage,
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
  onExportWallet,
  onDisconnect,
}: HeaderProps) {
  const isZh = locale === "zh";
  const t = getCopy(locale);
  const currentLocale = getLocaleOption(locale);
  const isConnected = wallet.kind !== "NONE" && Boolean(wallet.address);
  const resolvedTab: ConsumerTab = activeTab ?? activePage ?? "TRADE";

  const langMenu = useAnchoredMenu({ align: "end" });
  const accountMenu = useAnchoredMenu({ align: "end", enabled: isConnected });

  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [copyStatusLive, setCopyStatusLive] = useState("");
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  const navigate = (tab: ConsumerTab) => {
    (onSelectTab ?? onNavigate)?.(tab);
  };

  const handleBalanceClick = () => {
    if (!isConnected && onLogin) {
      onLogin();
      return;
    }
    if (onOpenWalletModal ?? onOpenWallet) {
      (onOpenWalletModal ?? onOpenWallet)?.();
      return;
    }
    navigate("POSITIONS");
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

  const handleCopyAddressFromMenu = async () => {
    if (!wallet.address) return;
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
    }
    let ok = false;
    try {
      await navigator.clipboard.writeText(wallet.address);
      ok = true;
    } catch {
      ok = false;
    }
    setCopyState(ok ? "copied" : "failed");
    let msg = ok
      ? isZh
        ? "已复制地址"
        : "Address copied"
      : isZh
        ? "复制失败"
        : "Copy failed";
    if (msg === lastHeaderCopyAnnouncement) {
      msg += "\u00A0";
    }
    lastHeaderCopyAnnouncement = msg;
    setCopyStatusLive("");
    requestAnimationFrame(() => setCopyStatusLive(msg));
    copyTimerRef.current = window.setTimeout(() => {
      setCopyState("idle");
      setCopyStatusLive("");
    }, 2000);
  };

  const shortAddr = wallet.address
    ? `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}`
    : "";
  const initial = getAccountInitial(wallet);
  const explorerBase = getExplorerBaseUrl(wallet.chainId || BSC_TESTNET.chainId);

  return (
    <header className="sticky top-0 z-30 h-14 bg-black/90 backdrop-blur-md">
      <div className="mx-auto grid h-full max-w-[1160px] grid-cols-[1fr_auto_1fr] items-center gap-1.5 sm:gap-2 px-2.5 sm:px-6">
        {/* Left: Official Reversed #F6F7F5 Payoff Brand Lockup */}
        <div className="justify-self-start min-w-0">
          <button
            type="button"
            onClick={() => navigate("TRADE")}
            aria-label="Payoff home"
            className="inline-flex items-center cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white rounded-md"
          >
            <PayoffLockup markSize={22} />
          </button>
        </div>

        {/* Center: Semantic Primary Site Navigation (Trade | Portfolio) */}
        <nav
          aria-label={isZh ? "主导航" : "Primary"}
          className="justify-self-center flex h-full items-center gap-4 sm:gap-7"
        >
          <button
            type="button"
            aria-current={resolvedTab === "TRADE" ? "page" : undefined}
            onClick={() => navigate("TRADE")}
            className={`payoff-nav-link inline-flex h-full items-center px-1 text-[13px] sm:text-sm font-semibold whitespace-nowrap transition cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-[-4px] focus-visible:outline-white ${
              resolvedTab === "TRADE"
                ? "text-white"
                : "text-[#7e8690] hover:text-[#d0d6de]"
            }`}
          >
            {t.navTrade}
          </button>

          <button
            type="button"
            aria-current={resolvedTab === "POSITIONS" ? "page" : undefined}
            onClick={() => navigate("POSITIONS")}
            className={`payoff-nav-link inline-flex h-full items-center gap-1.5 px-1 text-[13px] sm:text-sm font-semibold whitespace-nowrap transition cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-[-4px] focus-visible:outline-white ${
              resolvedTab === "POSITIONS"
                ? "text-white"
                : "text-[#7e8690] hover:text-[#d0d6de]"
            }`}
          >
            <span>{t.navPositions}</span>
            {claimableCount > 0 && (
              <span
                className="h-1.5 w-1.5 rounded-full bg-[#2ec26b] shrink-0"
                aria-hidden="true"
              />
            )}
          </button>
        </nav>

        {/* Right: Language Dropdown + Wallet Balance Pill + Avatar Account Menu (3A) */}
        <div className="justify-self-end flex items-center gap-1 sm:gap-2">
          <button
            id={langMenu.triggerId}
            ref={langMenu.triggerRef}
            type="button"
            aria-haspopup="menu"
            aria-expanded={langMenu.open}
            onPointerDown={langMenu.onTriggerPointerDown}
            onKeyDown={langMenu.onTriggerKeyDown}
            {...langMenu.triggerInvokerProps}
            className={`inline-flex h-7 w-7 sm:h-8 sm:w-auto sm:min-w-8 items-center justify-center gap-1.5 rounded-full sm:px-2.5 text-xs font-semibold transition cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white ${
              langMenu.open
                ? "bg-[#24282f] text-white"
                : "bg-[#15171b] text-[#b8bec6] hover:bg-[#24282f] hover:text-white"
            }`}
          >
            <Globe className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="sr-only">
              {isZh ? "语言 " : "Language "}
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
                aria-label={isZh ? "选择语言" : "Select language"}
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

          {isConnected ? (
            <>
              {/* Wallet Balance Pill -> Portfolio Page */}
              <button
                type="button"
                disabled={!authReady}
                onClick={handleBalanceClick}
                aria-label={`${t.navPositions}: ${formatCompactBalance(wallet.usdtBalance)}`}
                className={`inline-flex h-7 sm:h-8 items-center gap-1.5 rounded-full px-2 sm:px-3 text-xs font-semibold whitespace-nowrap transition cursor-pointer disabled:opacity-55 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white ${
                  resolvedTab === "POSITIONS"
                    ? "bg-[#1f2329] ring-1 ring-white/25 text-white"
                    : "bg-[#15171b] text-white hover:bg-[#24282f]"
                }`}
              >
                <Wallet
                  className="h-3.5 w-3.5 text-[#9aa2ad] shrink-0"
                  aria-hidden="true"
                />
                <span className="tabular-nums font-semibold tracking-[-0.01em]">
                  {formatCompactBalance(wallet.usdtBalance)}
                </span>
                {positionCount > 0 && (
                  <span className="hidden sm:inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-white px-1 text-[10px] font-bold text-black tabular-nums leading-none">
                    {positionCount}
                  </span>
                )}
                {claimableCount > 0 && (
                  <span
                    className="h-1.5 w-1.5 rounded-full bg-[#2ec26b] shrink-0"
                    aria-hidden="true"
                  />
                )}
              </button>

              {/* Standalone Avatar Account Dropdown Trigger */}
              <button
                id={accountMenu.triggerId}
                ref={accountMenu.triggerRef}
                type="button"
                aria-haspopup="menu"
                aria-expanded={accountMenu.open}
                aria-label={
                  wallet.email
                    ? `${isZh ? "账户" : "Account"}: ${wallet.email}`
                    : isZh
                      ? "账户菜单"
                      : "Account menu"
                }
                title={wallet.email || wallet.address || undefined}
                onPointerDown={accountMenu.onTriggerPointerDown}
                onKeyDown={accountMenu.onTriggerKeyDown}
                {...accountMenu.triggerInvokerProps}
                className={`inline-flex h-7 sm:h-8 items-center gap-1 rounded-full p-0.5 sm:pl-1 sm:pr-2 text-xs font-semibold transition cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white ${
                  accountMenu.open
                    ? "bg-[#24282f] ring-1 ring-white/25 text-white"
                    : "bg-[#15171b] text-white hover:bg-[#24282f]"
                }`}
              >
                <span
                  aria-hidden="true"
                  className="flex h-6 w-6 items-center justify-center rounded-full bg-[#24282f] text-[11px] font-bold text-white"
                >
                  {initial ?? <User className="h-3.5 w-3.5 text-[#b8bec6]" />}
                </span>
                <ChevronDown
                  className={`hidden sm:inline h-3 w-3 shrink-0 transition-transform duration-150 ${
                    accountMenu.open ? "rotate-180 text-white" : "text-[#7e8690]"
                  }`}
                  aria-hidden="true"
                />
              </button>

              {/* Anchored Account Popover Menu (immediately after trigger for implicit anchor & zero aria-details) */}
              <div
                id={accountMenu.popoverId}
                ref={accountMenu.popoverRef}
                {...(accountMenu.supportsPopover ? { popover: "auto" } : {})}
                onKeyDown={accountMenu.onPopoverKeyDown}
                className={`payoff-popover payoff-popover--end w-[236px] ${
                  !accountMenu.supportsPopover && !accountMenu.open
                    ? "hidden"
                    : ""
                }`}
              >
                <div className="p-1.5">
                  {/* Non-interactive Account Identity Summary */}
                  <div className="px-3 pt-2 pb-2.5">
                    <div className="text-xs font-bold text-white truncate">
                      {wallet.email ||
                        wallet.walletName ||
                        (isZh ? "邮箱账户" : "Email account")}
                    </div>
                    <div className="mt-0.5 font-mono text-[11px] text-[#7e8690]">
                      {shortAddr}
                    </div>
                  </div>

                  {/* Interactive Commands & Links inside focusgroup="menu nomemory" */}
                  <div
                    ref={accountMenu.menuGroupRef}
                    {...({ focusgroup: "menu nomemory" } as Record<
                      string,
                      unknown
                    >)}
                    aria-labelledby={accountMenu.triggerId}
                    className="flex flex-col gap-0.5"
                  >
                    <hr className="my-1 border-[#1d2025]" />

                    <button
                      type="button"
                      onClick={() => void handleCopyAddressFromMenu()}
                      className="flex min-h-[36px] w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] font-medium text-[#d0d6de] hover:bg-[#1a1e24] hover:text-white transition cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-white/75"
                    >
                      {copyState === "copied" ? (
                        <Check
                          className="h-3.5 w-3.5 shrink-0 text-[#2EC26B]"
                          aria-hidden="true"
                        />
                      ) : (
                        <Copy
                          className="h-3.5 w-3.5 shrink-0 text-[#7e8690]"
                          aria-hidden="true"
                        />
                      )}
                      <span>
                        {copyState === "copied"
                          ? isZh
                            ? "已复制地址"
                            : "Copied address"
                          : copyState === "failed"
                            ? isZh
                              ? "复制失败"
                              : "Copy failed"
                            : isZh
                              ? "复制钱包地址"
                              : "Copy address"}
                      </span>
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        accountMenu.hideMenu(false);
                        navigate("POSITIONS");
                      }}
                      className="flex min-h-[36px] w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] font-medium text-[#d0d6de] hover:bg-[#1a1e24] hover:text-white transition cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-white/75"
                    >
                      <PieChart
                        className="h-3.5 w-3.5 shrink-0 text-[#7e8690]"
                        aria-hidden="true"
                      />
                      <span>{t.navPositions}</span>
                    </button>

                    {explorerBase && wallet.address && (
                      <a
                        href={`${explorerBase}/address/${wallet.address}`}
                        target="_blank"
                        rel="noreferrer"
                        onClick={() => accountMenu.hideMenu(false)}
                        className="flex min-h-[36px] w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] font-medium text-[#d0d6de] hover:bg-[#1a1e24] hover:text-white transition focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-white/75"
                      >
                        <ExternalLink
                          className="h-3.5 w-3.5 shrink-0 text-[#7e8690]"
                          aria-hidden="true"
                        />
                        <span>{t.viewOnBscScan}</span>
                      </a>
                    )}

                    <hr className="my-1 border-[#1d2025]" />

                    {onExportWallet && (
                      <button
                        type="button"
                        onClick={() => {
                          accountMenu.hideMenu(false);
                          onExportWallet();
                        }}
                        className="flex min-h-[36px] w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] font-medium text-[#d0d6de] hover:bg-[#1a1e24] hover:text-white transition cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-white/75"
                      >
                        <KeyRound
                          className="h-3.5 w-3.5 shrink-0 text-[#7e8690]"
                          aria-hidden="true"
                        />
                        <span>{t.exportPrivateKey}</span>
                      </button>
                    )}

                    {onDisconnect && (
                      <button
                        type="button"
                        onClick={() => {
                          accountMenu.hideMenu(false);
                          onDisconnect();
                        }}
                        className="flex min-h-[36px] w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] font-medium text-[#E85D4A]/90 hover:bg-[#1a1e24] hover:text-[#E85D4A] transition cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-white/75"
                      >
                        <LogOut
                          className="h-3.5 w-3.5 shrink-0"
                          aria-hidden="true"
                        />
                        <span>{t.disconnectWallet}</span>
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* Screen-reader live region kept outside menu buttons */}
              <span
                role="status"
                aria-live="polite"
                className="payoff-visually-hidden"
              >
                {copyStatusLive}
              </span>
            </>
          ) : (
            <button
              type="button"
              disabled={!authReady}
              onClick={handleBalanceClick}
              aria-label={t.connectWallet}
              className={`inline-flex h-8 items-center gap-1.5 rounded-full text-xs font-semibold whitespace-nowrap transition cursor-pointer disabled:opacity-55 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white ${
                authInitializing
                  ? "bg-[#15171b] px-2.5 sm:px-3 text-[#b8bec6]"
                  : "bg-white px-3 sm:px-3.5 font-bold text-black hover:bg-[#e8eaed]"
              }`}
            >
              {authInitializing ? (
                <>
                  <Loader2
                    className="h-3.5 w-3.5 animate-spin text-[#b8bec6]"
                    aria-hidden="true"
                  />
                  <span className="hidden sm:inline">{t.initializingWallet}</span>
                </>
              ) : (
                <span>{t.connectWallet}</span>
              )}
            </button>
          )}
        </div>
      </div>
    </header>
  );
}

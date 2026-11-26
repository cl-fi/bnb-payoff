import { ChevronDown, Loader2 } from "lucide-react";
import type { ConnectedWallet } from "../lib/wallet";
import { getCopy, type Locale } from "../lib/i18n";
import { PayoffLockup } from "./PayoffMark";

export type ConsumerTab = "TRADE" | "POSITIONS";

export interface HeaderProps {
  activeTab?: ConsumerTab;
  onSelectTab?: (tab: ConsumerTab) => void;
  /** Optional navigation aliases for compatibility */
  activePage?: ConsumerTab;
  onNavigate?: (tab: ConsumerTab) => void;
  locale: Locale;
  onToggleLocale: () => void;
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
  const isConnected = wallet.kind !== "NONE" && Boolean(wallet.address);

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

        {/* Right: Compact Language Toggle + Account Pill */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onToggleLocale}
            className="rounded-full bg-[#15171b] px-2.5 py-1.5 text-[11px] font-semibold text-[#b8bec6] transition hover:bg-[#24282f] hover:text-white cursor-pointer"
            title="Switch language / 切换语言"
            aria-label={locale === "zh" ? "Switch to English" : "切换为中文"}
          >
            {locale === "zh" ? "EN" : "中文"}
          </button>

          <button
            type="button"
            disabled={!authReady}
            onClick={handleAccountClick}
            title={wallet.email || wallet.address || undefined}
            aria-label={isConnected ? t.drawerTitle : t.connectWallet}
            className={`inline-flex items-center gap-1.5 rounded-full text-xs font-semibold transition cursor-pointer disabled:opacity-55 ${
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

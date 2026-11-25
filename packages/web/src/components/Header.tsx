import { Briefcase, TrendingUp, Wallet } from "lucide-react";
import type { ConnectedWallet } from "../lib/wallet";
import { getCopy, type Locale } from "../lib/i18n";
import { PayoffMark, UsdtIcon } from "./PayoffMark";

export type ConsumerTab = "TRADE" | "POSITIONS";

interface Props {
  activeTab: ConsumerTab;
  onSelectTab: (tab: ConsumerTab) => void;
  locale: Locale;
  onToggleLocale: () => void;
  wallet: ConnectedWallet;
  positionCount: number;
  onOpenWalletModal: () => void;
}

export function Header({
  activeTab,
  onSelectTab,
  locale,
  onToggleLocale,
  wallet,
  positionCount,
  onOpenWalletModal,
}: Props) {
  const t = getCopy(locale);
  const isConnected = wallet.kind !== "NONE" && Boolean(wallet.address);
  const shortAddr = wallet.address
    ? `${wallet.address.slice(0, 5)}...${wallet.address.slice(-4)}`
    : "";

  return (
    <>
      <header className="sticky top-0 z-30 h-16 border-b border-[#e2e5e8] bg-white/95 backdrop-blur-md">
        <div className="mx-auto flex h-full max-w-6xl items-center justify-between px-4 sm:px-6">
          {/* Official Payoff Brand Lockup + Monochrome Desktop Nav */}
          <div className="flex h-full items-center gap-8">
            <button
              type="button"
              onClick={() => onSelectTab("TRADE")}
              aria-label="Payoff home"
              className="inline-flex items-center gap-2 text-[#14202a] cursor-pointer"
            >
              <PayoffMark size={24} className="text-[#14202a]" />
              <span className="text-[21px] font-bold tracking-[-0.03em] leading-none">
                Payoff
              </span>
              <span className="hidden sm:inline-flex items-center rounded-md border border-[#e2e5e8] bg-[#f7f8f9] px-1.5 py-0.5 text-[10px] font-semibold text-[#667080]">
                BNB Testnet
              </span>
            </button>

            <nav className="hidden md:flex h-full items-center gap-7">
              <button
                type="button"
                onClick={() => onSelectTab("TRADE")}
                className={`relative flex h-full items-center text-sm transition cursor-pointer ${
                  activeTab === "TRADE"
                    ? "font-semibold text-[#14202a]"
                    : "text-[#3a4552] hover:text-[#14202a]"
                }`}
              >
                {t.navTrade}
                {activeTab === "TRADE" && (
                  <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-[#14202a]" />
                )}
              </button>
              <button
                type="button"
                onClick={() => onSelectTab("POSITIONS")}
                className={`relative flex h-full items-center gap-1.5 text-sm transition cursor-pointer ${
                  activeTab === "POSITIONS"
                    ? "font-semibold text-[#14202a]"
                    : "text-[#3a4552] hover:text-[#14202a]"
                }`}
              >
                <span>{t.navPositions}</span>
                {positionCount > 0 && (
                  <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-[#14202a] px-1 text-[10px] font-semibold text-white tabular-nums">
                    {positionCount}
                  </span>
                )}
                {activeTab === "POSITIONS" && (
                  <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-[#14202a]" />
                )}
              </button>
            </nav>
          </div>

          {/* Right: Language Toggle + Monochrome Wallet Button */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onToggleLocale}
              className="rounded-lg border border-[#e2e5e8] bg-white px-2.5 py-1.5 text-xs font-medium text-[#3a4552] transition hover:border-[#c8ccd1] hover:bg-[#f7f8f9] hover:text-[#14202a] cursor-pointer"
              title="Switch language / 切换语言"
            >
              {locale === "zh" ? "EN" : "中文"}
            </button>

            <button
              type="button"
              onClick={onOpenWalletModal}
              className={`flex items-center gap-2 rounded-lg px-3.5 py-2 text-xs font-semibold transition cursor-pointer ${
                isConnected
                  ? "border border-[#c8ccd1] bg-white text-[#14202a] hover:border-[#667080] hover:bg-[#f7f8f9]"
                  : "bg-[#14202a] text-white hover:bg-[#000a12]"
              }`}
            >
              {isConnected ? (
                <>
                  <UsdtIcon size={15} />
                  <span className="tabular-nums font-semibold">
                    {wallet.usdtBalance.toLocaleString(undefined, {
                      maximumFractionDigits: 2,
                    })}
                  </span>
                  <span className="text-[#c8ccd1]">|</span>
                  <span className="font-mono text-[#3a4552]">{shortAddr}</span>
                </>
              ) : (
                <>
                  <Wallet className="h-3.5 w-3.5" />
                  <span>{t.connectWallet}</span>
                </>
              )}
            </button>
          </div>
        </div>
      </header>

      {/* Mobile-First Monochrome Bottom Tab Bar */}
      <nav className="fixed bottom-0 left-0 right-0 z-30 border-t border-[#e2e5e8] bg-white/95 backdrop-blur-md md:hidden safe-pb">
        <div className="mx-auto grid max-w-md grid-cols-2 px-4 pt-2">
          <button
            type="button"
            onClick={() => onSelectTab("TRADE")}
            className={`flex flex-col items-center gap-1 py-1 text-[11px] font-semibold transition cursor-pointer ${
              activeTab === "TRADE" ? "text-[#14202a]" : "text-[#667080]"
            }`}
          >
            <TrendingUp className="h-5 w-5" />
            <span>{t.navTrade}</span>
          </button>

          <button
            type="button"
            onClick={() => onSelectTab("POSITIONS")}
            className={`relative flex flex-col items-center gap-1 py-1 text-[11px] font-semibold transition cursor-pointer ${
              activeTab === "POSITIONS" ? "text-[#14202a]" : "text-[#667080]"
            }`}
          >
            <div className="relative">
              <Briefcase className="h-5 w-5" />
              {positionCount > 0 && (
                <span className="absolute -right-2.5 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-[#14202a] px-1 text-[10px] font-semibold text-white tabular-nums">
                  {positionCount}
                </span>
              )}
            </div>
            <span>{t.navPositions}</span>
          </button>
        </div>
      </nav>
    </>
  );
}

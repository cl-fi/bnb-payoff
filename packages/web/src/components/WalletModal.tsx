import { useState } from "react";
import {
  Check,
  Copy,
  ExternalLink,
  Loader2,
  LogOut,
  ShieldCheck,
  Wallet,
  X,
} from "lucide-react";
import { BSC_TESTNET } from "@payoff/shared";
import {
  getExplorerBaseUrl,
  type ConnectedWallet,
  type DiscoveredWallet,
} from "../lib/wallet";
import { getCopy, type Locale } from "../lib/i18n";
import { UsdtIcon } from "./PayoffMark";

interface Props {
  open: boolean;
  locale: Locale;
  wallet: ConnectedWallet;
  discoveredWallets: DiscoveredWallet[];
  connectingId: string | null;
  errorMsg?: string;
  onClose: () => void;
  onConnectDiscovered: (w: DiscoveredWallet) => void;
  onDisconnect: () => void;
}

export function WalletModal({
  open,
  locale,
  wallet,
  discoveredWallets,
  connectingId,
  errorMsg,
  onClose,
  onConnectDiscovered,
  onDisconnect,
}: Props) {
  const [copied, setCopied] = useState(false);
  const t = getCopy(locale);

  if (!open) return null;

  const isConnected = wallet.kind !== "NONE" && Boolean(wallet.address);
  const explorerBase = getExplorerBaseUrl(wallet.chainId);
  const activeChainId = wallet.walletChainId ?? wallet.chainId;

  const handleCopy = () => {
    if (!wallet.address) return;
    void navigator.clipboard.writeText(wallet.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-[#14202a]/40 backdrop-blur-[2px] sm:items-center p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-t-2xl sm:rounded-2xl bg-white p-6 shadow-2xl border border-[#e2e5e8] space-y-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-bold text-[#14202a]">
              {isConnected ? t.myWallet : t.connectWallet}
            </h3>
            <p className="text-xs text-[#667080] mt-0.5">
              {isConnected
                ? t.walletSubtitleConnected
                : t.walletSubtitleDisconnected}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-[#667080] hover:bg-[#eef0f2] hover:text-[#14202a] cursor-pointer"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {isConnected && wallet.address ? (
          <div className="space-y-4">
            <div className="rounded-xl bg-[#f7f8f9] border border-[#e2e5e8] p-4 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2.5 min-w-0">
                  {wallet.walletIcon ? (
                    <img
                      src={wallet.walletIcon}
                      alt={wallet.walletName}
                      className="h-8 w-8 rounded-lg shrink-0"
                    />
                  ) : (
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#14202a] text-white shrink-0">
                      <Wallet className="h-4 w-4" />
                    </div>
                  )}
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-[#14202a] truncate">
                      {wallet.walletName || t.myWallet}
                    </div>
                    <div className="flex items-center gap-1.5 text-xs text-[#667080] font-mono">
                      <span>
                        {wallet.address.slice(0, 8)}...{wallet.address.slice(-6)}
                      </span>
                      <button
                        type="button"
                        onClick={handleCopy}
                        className="text-[#667080] hover:text-[#14202a] cursor-pointer"
                      >
                        {copied ? (
                          <Check className="h-3.5 w-3.5 text-[#0e7c72]" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </div>
                  </div>
                </div>
                <span
                  className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold shrink-0 ${
                    activeChainId === wallet.chainId
                      ? "bg-[#e9f3f1] text-[#0e7c72]"
                      : "bg-[#fbf3dd] text-[#8a6410]"
                  }`}
                >
                  {activeChainId === BSC_TESTNET.chainId
                    ? "BSC Testnet"
                    : `Chain #${activeChainId}`}
                </span>
              </div>

              <div className="border-t border-[#e2e5e8] pt-3 flex items-center justify-between">
                <span className="text-xs text-[#667080]">
                  {t.availableBalance}
                </span>
                <span className="inline-flex items-center gap-1.5 text-xl font-bold text-[#14202a] tabular-nums">
                  <UsdtIcon size={18} />
                  {wallet.usdtBalance.toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                  <span className="text-xs font-semibold text-[#667080]">
                    USDT
                  </span>
                </span>
              </div>

              {explorerBase && (
                <div className="border-t border-[#eef0f2] pt-2.5 flex justify-end">
                  <a
                    href={`${explorerBase}/address/${wallet.address}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#3a4552] hover:text-[#14202a] underline underline-offset-2"
                  >
                    {t.viewOnBscScan}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={() => {
                onDisconnect();
                onClose();
              }}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-[#c8ccd1] py-2.5 text-sm font-semibold text-[#14202a] hover:bg-[#f7f8f9] transition cursor-pointer"
            >
              <LogOut className="h-4 w-4" />
              {t.disconnectWallet}
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            {errorMsg && (
              <div className="rounded-lg bg-[#fbeeea] px-3.5 py-2.5 text-xs font-medium text-[#b54134]">
                {errorMsg}
              </div>
            )}

            <div>
              <div className="mb-2 flex items-center justify-between text-xs">
                <span className="font-semibold text-[#667080]">
                  {t.scannedWalletsSection}
                </span>
                <span className="text-[11px] text-[#667080]">
                  {discoveredWallets.length > 0
                    ? t.foundCount(discoveredWallets.length)
                    : t.notDetected}
                </span>
              </div>

              {discoveredWallets.length > 0 ? (
                <div className="space-y-2">
                  {discoveredWallets.map((w) => (
                    <button
                      key={w.id}
                      type="button"
                      disabled={connectingId !== null}
                      onClick={() => onConnectDiscovered(w)}
                      className="flex w-full items-center justify-between rounded-xl border border-[#e2e5e8] bg-white px-4 py-3 text-left transition hover:border-[#667080] hover:bg-[#f7f8f9] disabled:opacity-60 cursor-pointer"
                    >
                      <div className="flex items-center gap-3">
                        {w.icon ? (
                          <img
                            src={w.icon}
                            alt={w.name}
                            className="h-8 w-8 rounded-lg object-contain"
                          />
                        ) : (
                          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#eef0f2] text-[#3a4552]">
                            <Wallet className="h-4 w-4" />
                          </div>
                        )}
                        <div>
                          <div className="text-sm font-semibold text-[#14202a]">
                            {w.name}
                          </div>
                          <div className="text-[11px] text-[#667080]">
                            {w.isBnbFeatured ? t.bnbReady : t.browserWallet}
                          </div>
                        </div>
                      </div>

                      {connectingId === w.id ? (
                        <Loader2 className="h-4 w-4 animate-spin text-[#667080]" />
                      ) : (
                        <span className="rounded-full bg-[#e9f3f1] px-2.5 py-0.5 text-[11px] font-semibold text-[#0e7c72]">
                          {t.installedBadge}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="rounded-xl border border-dashed border-[#c8ccd1] bg-[#f7f8f9] p-4 text-center space-y-3">
                  <p className="text-xs text-[#667080] leading-relaxed">
                    {t.noWalletHint}
                  </p>
                  <div className="flex flex-wrap items-center justify-center gap-3">
                    <a
                      href="https://www.binance.com/en/web3wallet"
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-xs font-semibold text-[#14202a] underline underline-offset-2"
                    >
                      {t.getBinanceWallet}
                      <ExternalLink className="h-3 w-3" />
                    </a>
                    <a
                      href="https://metamask.io/download/"
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-xs font-semibold text-[#14202a] underline underline-offset-2"
                    >
                      {t.getMetaMask}
                      <ExternalLink className="h-3 w-3" />
                    </a>
                    <a
                      href="https://trustwallet.com/download"
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-xs font-semibold text-[#14202a] underline underline-offset-2"
                    >
                      {t.getTrustWallet}
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                </div>
              )}
            </div>

            <div className="flex items-center justify-center gap-1.5 pt-1 text-[11px] text-[#667080]">
              <ShieldCheck className="h-3.5 w-3.5 text-[#0e7c72]" />
              <span>{t.nonCustodialNote}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

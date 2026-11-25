import { useEffect, useId, useRef, useState } from "react";
import {
  Check,
  Copy,
  ExternalLink,
  Loader2,
  LogOut,
  QrCode,
  ShieldCheck,
  Wallet,
  X,
} from "lucide-react";
import { BSC_TESTNET } from "@payoff/shared";
import {
  getExplorerBaseUrl,
  type ConnectedWallet,
} from "../lib/wallet";
import type { WalletConnectorOption } from "../lib/wagmi";
import { getCopy, type Locale } from "../lib/i18n";
import { UsdtIcon } from "./PayoffMark";

interface Props {
  open: boolean;
  locale: Locale;
  wallet: ConnectedWallet;
  walletOptions: WalletConnectorOption[];
  connectingId: string | null;
  errorMsg?: string;
  onClose: () => void;
  onConnectOption: (w: WalletConnectorOption) => void;
  onDisconnect: () => void;
}

export function WalletModal({
  open,
  locale,
  wallet,
  walletOptions,
  connectingId,
  errorMsg,
  onClose,
  onConnectOption,
  onDisconnect,
}: Props) {
  const [copied, setCopied] = useState(false);
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const t = getCopy(locale);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  // Fallback light-dismiss for browsers without native <dialog closedby="any"> (e.g. Safari)
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
      if (connectingId === null && pressedOutside && isOutside(e)) {
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
  }, [open, connectingId]);

  if (!open) return null;

  const isConnected = wallet.kind !== "NONE" && Boolean(wallet.address);
  const explorerBase = getExplorerBaseUrl(wallet.chainId);
  const activeChainId = wallet.walletChainId ?? wallet.chainId;
  const detectedExtensionsCount = walletOptions.filter(
    (w) => !w.isQrFallback
  ).length;

  const handleCopy = () => {
    if (!wallet.address) return;
    void navigator.clipboard.writeText(wallet.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      {...({
        closedby: connectingId !== null ? "none" : "any",
      } as Record<string, unknown>)}
      onCancel={(e) => {
        if (connectingId !== null) e.preventDefault();
      }}
      onClose={() => {
        if (dialogRef.current) dialogRef.current.returnValue = "";
        onClose();
      }}
      className="m-auto w-full max-w-md rounded-t-2xl sm:rounded-2xl bg-white p-6 shadow-2xl border border-[#e2e5e8] space-y-5 text-[#14202a]"
    >
      <div className="flex items-center justify-between">
        <div>
          <h1 id={titleId} className="text-lg font-bold text-[#14202a]">
            {isConnected ? t.myWallet : t.connectWallet}
          </h1>
          <p className="text-xs text-[#667080] mt-0.5">
            {isConnected
              ? t.walletSubtitleConnected
              : t.walletSubtitleDisconnected}
          </p>
        </div>
        <button
          type="button"
          disabled={connectingId !== null}
          aria-label={t.cancel}
          onClick={() => dialogRef.current?.close()}
          className="rounded-lg p-1.5 text-[#667080] hover:bg-[#eef0f2] hover:text-[#14202a] disabled:opacity-50 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#14202a]"
        >
          <X className="h-5 w-5" aria-hidden="true" />
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
                    className="h-8 w-8 rounded-lg shrink-0 object-contain"
                  />
                ) : (
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#14202a] text-white shrink-0">
                    <Wallet className="h-4 w-4" aria-hidden="true" />
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
                      aria-label="Copy address"
                      className="text-[#667080] hover:text-[#14202a] cursor-pointer"
                    >
                      {copied ? (
                        <Check
                          className="h-3.5 w-3.5 text-[#0e7c72]"
                          aria-hidden="true"
                        />
                      ) : (
                        <Copy className="h-3.5 w-3.5" aria-hidden="true" />
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
                  <ExternalLink className="h-3 w-3" aria-hidden="true" />
                </a>
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={() => {
              onDisconnect();
              dialogRef.current?.close();
            }}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-[#c8ccd1] py-2.5 text-sm font-semibold text-[#14202a] hover:bg-[#f7f8f9] transition cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#14202a]"
          >
            <LogOut className="h-4 w-4" aria-hidden="true" />
            {t.disconnectWallet}
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {errorMsg && (
            <div
              role="alert"
              className="rounded-lg bg-[#fbeeea] px-3.5 py-2.5 text-xs font-medium text-[#b54134]"
            >
              {errorMsg}
            </div>
          )}

          <div>
            <div className="mb-2 flex items-center justify-between text-xs">
              <span className="font-semibold text-[#667080]">
                {t.scannedWalletsSection}
              </span>
              <span className="text-[11px] text-[#667080]">
                {detectedExtensionsCount > 0
                  ? t.foundCount(detectedExtensionsCount)
                  : t.notDetected}
              </span>
            </div>

            <div className="space-y-2">
              {walletOptions.map((w, idx) => (
                <button
                  key={w.uid}
                  type="button"
                  autoFocus={idx === 0}
                  disabled={connectingId !== null}
                  onClick={() => onConnectOption(w)}
                  className={`flex w-full items-center justify-between rounded-xl border px-4 py-3 text-left transition disabled:opacity-60 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#14202a] ${
                    w.isBinanceOfficial
                      ? "border-[#14202a]/25 bg-[#f7f8f9] hover:border-[#14202a] hover:bg-white"
                      : "border-[#e2e5e8] bg-white hover:border-[#667080] hover:bg-[#f7f8f9]"
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    {w.icon ? (
                      <img
                        src={w.icon}
                        alt={w.name}
                        className="h-8 w-8 rounded-lg object-contain shrink-0"
                      />
                    ) : (
                      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#eef0f2] text-[#3a4552] shrink-0">
                        <Wallet className="h-4 w-4" aria-hidden="true" />
                      </div>
                    )}
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-semibold text-[#14202a] truncate">
                          {w.name}
                        </span>
                        {w.isBinanceOfficial && (
                          <span className="rounded bg-[#14202a] px-1.5 py-0.5 text-[10px] font-semibold text-white shrink-0">
                            {t.binanceOfficialBadge}
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-[#667080] truncate">
                        {w.isBinanceOfficial && w.isQrFallback
                          ? t.binanceAppQrDesc
                          : w.isWalletConnect
                            ? t.walletConnectDesc
                            : w.isBnbFeatured
                              ? t.bnbReady
                              : t.browserWallet}
                      </div>
                    </div>
                  </div>

                  {connectingId === w.uid ? (
                    <Loader2
                      className="h-4 w-4 animate-spin text-[#667080] shrink-0"
                      aria-hidden="true"
                    />
                  ) : w.isQrFallback ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-[#eef0f2] px-2.5 py-0.5 text-[11px] font-semibold text-[#3a4552] shrink-0">
                      <QrCode className="h-3 w-3" aria-hidden="true" />
                      {w.isBinanceOfficial
                        ? t.binanceAppQrBadge
                        : t.walletConnectBadge}
                    </span>
                  ) : (
                    <span className="rounded-full bg-[#e9f3f1] px-2.5 py-0.5 text-[11px] font-semibold text-[#0e7c72] shrink-0">
                      {t.installedBadge}
                    </span>
                  )}
                </button>
              ))}
            </div>

            {detectedExtensionsCount === 0 && (
              <div className="mt-3 rounded-xl border border-dashed border-[#c8ccd1] bg-[#f7f8f9] p-3.5 text-center space-y-2.5">
                <p className="text-[11px] text-[#667080] leading-relaxed">
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
                    <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  </a>
                  <a
                    href="https://trustwallet.com/download"
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs font-semibold text-[#14202a] underline underline-offset-2"
                  >
                    {t.getTrustWallet}
                    <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  </a>
                  <a
                    href="https://metamask.io/download/"
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs font-semibold text-[#14202a] underline underline-offset-2"
                  >
                    {t.getMetaMask}
                    <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  </a>
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center justify-center gap-1.5 pt-1 text-[11px] text-[#667080]">
            <ShieldCheck
              className="h-3.5 w-3.5 text-[#0e7c72] shrink-0"
              aria-hidden="true"
            />
            <span>{t.wagmiPoweredNote}</span>
          </div>
        </div>
      )}
    </dialog>
  );
}

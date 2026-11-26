import { useEffect, useId, useRef, useState } from "react";
import {
  Check,
  Copy,
  ExternalLink,
  KeyRound,
  LogOut,
  Mail,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { BSC_TESTNET } from "@payoff/shared";
import { getExplorerBaseUrl, type ConnectedWallet } from "../lib/wallet";
import { getCopy, type Locale } from "../lib/i18n";
import { UsdtIcon } from "./PayoffMark";

interface Props {
  open: boolean;
  locale: Locale;
  wallet: ConnectedWallet;
  onClose: () => void;
  onLogin: () => void;
  onExportWallet: () => void;
  onDisconnect: () => void;
}

export function WalletModal({
  open,
  locale,
  wallet,
  onClose,
  onLogin,
  onExportWallet,
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

  if (!open) return null;

  const isConnected = wallet.kind !== "NONE" && Boolean(wallet.address);
  const explorerBase = getExplorerBaseUrl(wallet.chainId);

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
      {...({ closedby: "any" } as Record<string, unknown>)}
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
          autoFocus
          aria-label={t.cancel}
          onClick={() => dialogRef.current?.close()}
          className="rounded-lg p-1.5 text-[#667080] hover:bg-[#eef0f2] hover:text-[#14202a] cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#14202a]"
        >
          <X className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>

      {isConnected && wallet.address ? (
        <div className="space-y-4">
          <div className="rounded-xl bg-[#f7f8f9] border border-[#e2e5e8] p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#14202a] text-white shrink-0">
                  <Mail className="h-4 w-4" aria-hidden="true" />
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-[#14202a] truncate">
                    {wallet.email || wallet.walletName || t.privyEmailAccountLabel}
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
              <span className="inline-flex items-center gap-1 rounded-full bg-[#e9f3f1] px-2.5 py-0.5 text-[11px] font-semibold text-[#0e7c72] shrink-0">
                <Sparkles className="h-3 w-3" aria-hidden="true" />
                {wallet.chainId === BSC_TESTNET.chainId
                  ? t.gasFreeBadge
                  : `Chain #${wallet.chainId}`}
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
              <div className="border-t border-[#eef0f2] pt-2.5 flex items-center justify-between gap-2">
                <span className="text-[11px] text-[#667080]">
                  BNB Smart Chain Testnet
                </span>
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

          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => {
                // Close native top-layer <dialog> first so Privy's export modal is never occluded.
                dialogRef.current?.close();
                onExportWallet();
              }}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-[#e2e5e8] bg-[#f7f8f9] py-2.5 text-xs font-semibold text-[#14202a] hover:bg-[#eef0f2] transition cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#14202a]"
            >
              <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
              {t.exportPrivateKey}
            </button>

            <button
              type="button"
              onClick={() => {
                dialogRef.current?.close();
                onDisconnect();
              }}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-[#c8ccd1] py-2.5 text-sm font-semibold text-[#14202a] hover:bg-[#f7f8f9] transition cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#14202a]"
            >
              <LogOut className="h-4 w-4" aria-hidden="true" />
              {t.disconnectWallet}
            </button>
          </div>

          <div className="flex items-center justify-center gap-1.5 text-[11px] text-[#667080]">
            <ShieldCheck
              className="h-3.5 w-3.5 text-[#0e7c72] shrink-0"
              aria-hidden="true"
            />
            <span>{t.gasFreeAccountNote}</span>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <button
            type="button"
            onClick={() => {
              dialogRef.current?.close();
              onLogin();
            }}
            className="flex w-full min-h-[48px] items-center justify-center gap-2 rounded-xl bg-[#14202a] py-3 text-sm font-semibold text-white hover:bg-[#000a12] transition cursor-pointer"
          >
            <Mail className="h-4 w-4" aria-hidden="true" />
            <span>{t.connectWallet}</span>
          </button>

          <div className="flex items-center justify-center gap-1.5 text-[11px] text-[#667080]">
            <ShieldCheck
              className="h-3.5 w-3.5 text-[#0e7c72] shrink-0"
              aria-hidden="true"
            />
            <span>{t.gasFreeAccountNote}</span>
          </div>
        </div>
      )}
    </dialog>
  );
}

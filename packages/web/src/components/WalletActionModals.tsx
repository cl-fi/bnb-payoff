import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  ArrowUpRight,
  CheckCircle2,
  Droplets,
  ExternalLink,
  Loader2,
  X,
} from "lucide-react";
import { isAddress } from "viem";
import { BSC_TESTNET } from "@payoff/shared";
import type { Locale } from "../lib/i18n";
import { encodeQrMatrix } from "../lib/qrcode";
import {
  extractWalletErrorMessage,
  getExplorerBaseUrl,
  type ConnectedWallet,
} from "../lib/wallet";
import { CopyAddressButton } from "./CopyAddressButton";

function useDialogLightDismiss(
  dialogRef: React.RefObject<HTMLDialogElement | null>,
  open: boolean,
  allowLightDismiss = true
) {
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [dialogRef, open]);

  // Safari fallback for declarative <dialog closedby="any">
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !allowLightDismiss || !dialog) return;
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
  }, [dialogRef, open, allowLightDismiss]);
}

function AddressQrSvg({ address }: { address: string }) {
  const qr = useMemo(() => {
    try {
      return encodeQrMatrix(address);
    } catch {
      return null;
    }
  }, [address]);

  if (!qr) return null;

  const quiet = 2;
  const viewSize = qr.size + quiet * 2;

  return (
    <svg
      viewBox={`0 0 ${viewSize} ${viewSize}`}
      width={116}
      height={116}
      role="img"
      aria-label={`QR code for ${address}`}
      shapeRendering="crispEdges"
      className="h-[116px] w-[116px] shrink-0 rounded-xl bg-white p-1"
    >
      <rect width={viewSize} height={viewSize} fill="#ffffff" />
      {qr.modules.map((row, r) =>
        row.map((dark, c) =>
          dark ? (
            <rect
              key={`${r}-${c}`}
              x={c + quiet}
              y={r + quiet}
              width={1}
              height={1}
              fill="#000000"
            />
          ) : null
        )
      )}
    </svg>
  );
}

export interface MintModalProps {
  open: boolean;
  locale: Locale;
  wallet: ConnectedWallet;
  onClose: () => void;
  onClaimFaucet: (amountUsdt: number) => Promise<`0x${string}` | void>;
}

const MINT_PRESET_AMOUNTS = [1000, 5000, 10000] as const;
const MAX_MINT_AMOUNT = 100_000;

export function MintModal({
  open,
  locale,
  wallet,
  onClose,
  onClaimFaucet,
}: MintModalProps) {
  const isZh = locale === "zh";
  const titleId = useId();
  const faucetInputId = useId();
  const amountHintId = useId();
  const amountErrorId = useId();

  const dialogRef = useRef<HTMLDialogElement>(null);
  const amountInputRef = useRef<HTMLInputElement>(null);
  const doneBtnRef = useRef<HTMLButtonElement>(null);
  const announceTimerRef = useRef<number | null>(null);

  const [amountText, setAmountText] = useState("1000");
  const [amountTouched, setAmountTouched] = useState(false);
  const [submittedOnce, setSubmittedOnce] = useState(false);
  const [faucetBusy, setFaucetBusy] = useState(false);
  const [txError, setTxError] = useState<string | null>(null);
  const [politeErrorAnnouncement, setPoliteErrorAnnouncement] = useState("");
  const [confirmed, setConfirmed] = useState<{
    amountUsdt: number;
    txHash?: string;
  } | null>(null);

  useDialogLightDismiss(dialogRef, open, !faucetBusy);

  useEffect(() => {
    return () => {
      if (announceTimerRef.current !== null) {
        window.clearTimeout(announceTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (confirmed) {
      doneBtnRef.current?.focus();
    }
  }, [confirmed]);

  const scheduleErrorAnnouncement = (msg: string | null) => {
    if (announceTimerRef.current !== null) {
      window.clearTimeout(announceTimerRef.current);
    }
    setPoliteErrorAnnouncement("");
    if (!msg) return;
    const fieldLabel = isZh ? "领取金额" : "Amount";
    // Delay briefly so screen readers finish announcing the newly focused control first.
    announceTimerRef.current = window.setTimeout(() => {
      setPoliteErrorAnnouncement(`${fieldLabel}: ${msg}`);
    }, 500);
  };

  const resetModalState = () => {
    scheduleErrorAnnouncement(null);
    setAmountText("1000");
    setAmountTouched(false);
    setSubmittedOnce(false);
    setTxError(null);
    setConfirmed(null);
  };

  if (!open || !wallet.address) return null;

  const getAmountError = (rawText: string): string | null => {
    const trimmed = rawText.trim();
    if (!trimmed) {
      return isZh
        ? "请输入 $1 至 $100,000 之间的领取金额。"
        : "Enter an amount between $1 and $100,000.";
    }
    const num = Number(trimmed);
    if (!Number.isInteger(num) || num < 1) {
      return isZh
        ? "领取金额须为不小于 $1 的整数。"
        : "Amount must be a whole number of at least $1.";
    }
    if (num > MAX_MINT_AMOUNT) {
      return isZh
        ? "单次最多可领取 $100,000 tUSDT。"
        : "Maximum single mint is $100,000 tUSDT.";
    }
    return null;
  };

  const trimmedAmount = amountText.trim();
  const parsedAmount = trimmedAmount ? Number(trimmedAmount) : Number.NaN;
  const explorerBase = getExplorerBaseUrl(wallet.chainId || BSC_TESTNET.chainId);

  const amountErrorText = getAmountError(amountText);

  const isValidAmount = amountErrorText === null;
  const showAmountError = Boolean(
    amountErrorText && (amountTouched || submittedOnce)
  );
  const projectedBalance = isValidAmount
    ? wallet.usdtBalance + parsedAmount
    : wallet.usdtBalance;

  const formattedCurrentBalance = wallet.usdtBalance.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const formattedProjectedBalance = projectedBalance.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  const handleMintFaucet = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (faucetBusy) return;
    setSubmittedOnce(true);
    setTxError(null);

    if (amountErrorText || !isValidAmount) {
      amountInputRef.current?.focus();
      return;
    }

    setFaucetBusy(true);
    try {
      const txHash = await onClaimFaucet(parsedAmount);
      setConfirmed({
        amountUsdt: parsedAmount,
        txHash: typeof txHash === "string" ? txHash : undefined,
      });
    } catch (err: unknown) {
      setTxError(
        extractWalletErrorMessage(
          err,
          isZh ? "领水失败，请重试" : "Faucet claim failed. Please try again."
        )
      );
    } finally {
      setFaucetBusy(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      {...({ closedby: faucetBusy ? "none" : "any" } as Record<string, unknown>)}
      onCancel={(e) => {
        if (faucetBusy) e.preventDefault();
      }}
      onClose={() => {
        if (dialogRef.current) dialogRef.current.returnValue = "";
        resetModalState();
        onClose();
      }}
      className="payoff-sheet md:!w-[min(92vw,420px)] md:!max-w-[420px]"
    >
      <div className="flex max-h-[90dvh] flex-col md:max-h-[86dvh]">
        <div aria-hidden="true" className="payoff-sheet-handle" />

        <div className="overflow-y-auto px-5 pt-3 pb-6 sm:px-6 safe-pb space-y-4">
          {/* Header */}
          <div className="flex items-center justify-between gap-3">
            <h1
              id={titleId}
              className="text-[19px] font-bold tracking-[-0.02em] text-white"
            >
              {isZh ? "测试网领水" : "Testnet Faucet"}
            </h1>
            <button
              type="button"
              disabled={faucetBusy}
              aria-label={isZh ? "关闭" : "Close"}
              onClick={() => dialogRef.current?.close()}
              className="rounded-full p-1.5 text-[#7e8690] hover:bg-[#24282f] hover:text-white disabled:opacity-40 transition cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>

          {confirmed ? (
            <div className="space-y-4 pt-1">
              <div
                role="status"
                aria-live="polite"
                className="rounded-2xl bg-[#2EC26B]/12 border border-[#2EC26B]/25 p-4 space-y-2.5"
              >
                <div className="flex items-center gap-2 text-sm font-bold text-[#2EC26B]">
                  <CheckCircle2
                    className="h-4.5 w-4.5 shrink-0"
                    aria-hidden="true"
                  />
                  <span>
                    {isZh ? "测试网 tUSDT 已到账" : "Testnet tUSDT minted"}
                  </span>
                </div>

                <div className="text-2xl font-bold text-white tabular-nums">
                  +${confirmed.amountUsdt.toLocaleString("en-US")}{" "}
                  <span className="text-xs font-semibold text-[#b8bec6]">
                    tUSDT
                  </span>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[#b8bec6] tabular-nums">
                  <span>
                    {isZh ? "当前可用余额" : "New balance"}{" "}
                    <strong className="font-semibold text-white">
                      ${formattedCurrentBalance}
                    </strong>
                  </span>
                  {explorerBase && confirmed.txHash && (
                    <a
                      href={`${explorerBase}/tx/${confirmed.txHash}`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 font-semibold text-[#2EC26B] underline underline-offset-2 hover:text-[#2EC26B]/90"
                    >
                      <span>
                        {isZh ? "在 BscScan 查看" : "View on BscScan"}
                      </span>
                      <ExternalLink className="h-3 w-3" aria-hidden="true" />
                    </a>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setConfirmed(null);
                    setTxError(null);
                    setSubmittedOnce(false);
                    setAmountTouched(false);
                  }}
                  className="flex-1 min-h-[44px] rounded-full bg-[#24282f] px-4 py-2.5 text-xs font-bold text-white hover:bg-[#2f343d] transition cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
                >
                  {isZh ? "继续领水" : "Mint more"}
                </button>
                <button
                  ref={doneBtnRef}
                  type="button"
                  autoFocus
                  onClick={() => dialogRef.current?.close()}
                  className="flex-1 min-h-[44px] rounded-full bg-white px-4 py-2.5 text-xs font-bold text-black hover:bg-white/90 transition cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
                >
                  {isZh ? "完成" : "Done"}
                </button>
              </div>
            </div>
          ) : (
            <form
              noValidate
              aria-labelledby={titleId}
              onSubmit={(e) => void handleMintFaucet(e)}
              className="space-y-4"
            >
              {/* Recessed Amount Card (aligned with OrderTicketPanel & WithdrawModal) */}
              <div className="space-y-1.5">
                <div
                  className={`rounded-2xl border bg-[#0b0c0e] px-4 py-3.5 space-y-3 transition-colors ${
                    showAmountError
                      ? "border-[#E85D4A]"
                      : "border-[#262a31] focus-within:border-white/35"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <label
                      htmlFor={faucetInputId}
                      className="font-semibold text-[#7e8690]"
                    >
                      {isZh ? "领取金额" : "Amount"}
                    </label>
                    <span
                      id={amountHintId}
                      className="text-[#7e8690] tabular-nums"
                    >
                      {isZh ? "可用" : "Available"}{" "}
                      <strong className="font-semibold text-[#d0d6de]">
                        ${formattedCurrentBalance}
                      </strong>
                    </span>
                  </div>

                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 flex-1 items-baseline">
                      <span
                        aria-hidden="true"
                        className="mr-1 text-xl font-bold text-[#7e8690]"
                      >
                        $
                      </span>
                      <input
                        ref={amountInputRef}
                        id={faucetInputId}
                        name="faucetAmount"
                        type="text"
                        inputMode="numeric"
                        enterKeyHint="done"
                        autoComplete="off"
                        autoCorrect="off"
                        autoCapitalize="none"
                        spellCheck={false}
                        required
                        pattern="^[1-9][0-9]{0,5}$"
                        placeholder="0"
                        disabled={faucetBusy}
                        value={amountText}
                        aria-invalid={showAmountError ? "true" : "false"}
                        aria-describedby={
                          showAmountError
                            ? `${amountHintId} ${amountErrorId}`
                            : amountHintId
                        }
                        onChange={(e) => {
                          const next = e.target.value
                            .replace(/[^\d]/g, "")
                            .slice(0, 6);
                          setAmountText(next);
                          setTxError(null);
                          if (!getAmountError(next)) {
                            scheduleErrorAnnouncement(null);
                          }
                        }}
                        onBlur={() => {
                          if (amountText !== "1000") {
                            setAmountTouched(true);
                            scheduleErrorAnnouncement(getAmountError(amountText));
                          }
                        }}
                        className="w-full min-w-[60px] bg-transparent text-[26px] leading-tight font-bold tracking-[-0.025em] text-white placeholder:text-[#3a3f47] tabular-nums outline-none disabled:opacity-50"
                      />
                    </div>
                    <span className="shrink-0 rounded-full bg-[#15171b] border border-[#262a31] px-2.5 py-1 text-xs font-semibold text-[#b8bec6]">
                      tUSDT
                    </span>
                  </div>

                  {/* 3 Equal-Width Quick Amount Presets */}
                  <div
                    role="group"
                    aria-label={isZh ? "快捷金额档位" : "Quick amount presets"}
                    className="grid grid-cols-3 gap-1.5 border-t border-[#1d2025] pt-3"
                  >
                    {MINT_PRESET_AMOUNTS.map((amt) => {
                      const active = isValidAmount && parsedAmount === amt;
                      return (
                        <button
                          key={amt}
                          type="button"
                          disabled={faucetBusy}
                          aria-pressed={active}
                          onClick={() => {
                            setAmountText(String(amt));
                            setAmountTouched(false);
                            setTxError(null);
                            scheduleErrorAnnouncement(null);
                          }}
                          className={`min-h-[34px] [@media(pointer:coarse)]:min-h-[42px] rounded-full text-xs font-semibold tabular-nums transition cursor-pointer disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/75 ${
                            active
                              ? "bg-[#262b33] border border-white/25 text-white font-bold"
                              : "bg-[#15171b] border border-transparent text-[#b8bec6] hover:bg-[#1f2329] hover:text-white"
                          }`}
                        >
                          ${amt.toLocaleString("en-US")}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {showAmountError && amountErrorText && (
                  <p
                    id={amountErrorId}
                    className="flex items-start gap-1.5 text-xs text-[#E85D4A]"
                  >
                    <AlertCircle
                      className="h-3.5 w-3.5 mt-0.5 shrink-0"
                      aria-hidden="true"
                    />
                    <span>{amountErrorText}</span>
                  </p>
                )}
              </div>

              {/* Balance Preview & Network Summary */}
              <div className="rounded-xl bg-[#0b0c0e] border border-[#1d2025] px-3.5 py-2.5 space-y-1.5 text-xs">
                <div className="flex items-center justify-between gap-2 tabular-nums">
                  <span className="text-[#7e8690]">
                    {isZh ? "到账后余额" : "New balance"}
                  </span>
                  {isValidAmount ? (
                    <span className="font-semibold">
                      <span className="font-normal text-[#7e8690]">
                        ${formattedCurrentBalance} →{" "}
                      </span>
                      <span className="text-[#2EC26B]">
                        ${formattedProjectedBalance}
                      </span>
                    </span>
                  ) : (
                    <span className="font-semibold text-[#d0d6de]">
                      ${formattedCurrentBalance}
                    </span>
                  )}
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[#7e8690]">
                    {isZh ? "网络与费用" : "Network"}
                  </span>
                  <span className="font-medium text-[#d0d6de]">
                    BSC Testnet ·{" "}
                    <span className="font-semibold text-[#2EC26B]">
                      {isZh ? "免 Gas" : "Gas Free"}
                    </span>
                  </span>
                </div>
              </div>

              {txError && (
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded-xl bg-[#E85D4A]/13 px-3.5 py-2.5 text-xs font-medium text-[#E85D4A]"
                >
                  <AlertCircle
                    className="h-4 w-4 shrink-0 mt-0.5"
                    aria-hidden="true"
                  />
                  <span>{txError}</span>
                </div>
              )}

              {/* Full-Width Primary CTA (aligned with WithdrawModal) */}
              <button
                type="submit"
                autoFocus
                disabled={faucetBusy}
                className="flex w-full min-h-[46px] items-center justify-center gap-2 rounded-full bg-white py-2.5 text-sm font-bold text-black hover:bg-white/90 disabled:opacity-45 transition cursor-pointer tabular-nums focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
              >
                {faucetBusy ? (
                  <>
                    <Loader2
                      className="h-4 w-4 animate-spin"
                      aria-hidden="true"
                    />
                    <span>{isZh ? "领取中..." : "Minting..."}</span>
                  </>
                ) : (
                  <>
                    <Droplets className="h-4 w-4" aria-hidden="true" />
                    <span>
                      {isValidAmount
                        ? isZh
                          ? `领取 $${parsedAmount.toLocaleString("en-US")} tUSDT`
                          : `Mint $${parsedAmount.toLocaleString("en-US")} tUSDT`
                        : isZh
                          ? "领取测试网 tUSDT"
                          : "Mint tUSDT"}
                    </span>
                  </>
                )}
              </button>

              <p className="text-center text-[11px] leading-relaxed text-[#7e8690]">
                {isZh
                  ? "测试网 tUSDT 仅用于 BNB Smart Chain Testnet 体验，无真实资产价值。"
                  : "Testnet funds on BNB Smart Chain Testnet only — no real asset value."}
              </p>

              {/* Single polite live region for delayed post-blur error announcements */}
              <div aria-live="polite" className="payoff-visually-hidden">
                {politeErrorAnnouncement}
              </div>
            </form>
          )}
        </div>
      </div>
    </dialog>
  );
}

export interface DepositModalProps {
  open: boolean;
  locale: Locale;
  wallet: ConnectedWallet;
  onClose: () => void;
  onOpenMint?: () => void;
}

export function DepositModal({
  open,
  locale,
  wallet,
  onClose,
  onOpenMint,
}: DepositModalProps) {
  const isZh = locale === "zh";
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);

  useDialogLightDismiss(dialogRef, open, true);

  if (!open || !wallet.address) return null;

  const explorerBase = getExplorerBaseUrl(wallet.chainId || BSC_TESTNET.chainId);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      {...({ closedby: "any" } as Record<string, unknown>)}
      onClose={() => {
        if (dialogRef.current) dialogRef.current.returnValue = "";
        onClose();
      }}
      className="payoff-sheet md:!w-[min(92vw,450px)] md:!max-w-[450px]"
    >
      <div className="flex max-h-[90dvh] flex-col md:max-h-[86dvh]">
        <div aria-hidden="true" className="payoff-sheet-handle" />

        <div className="overflow-y-auto px-5 pt-3 pb-6 sm:px-6 safe-pb space-y-4">
          {/* Header */}
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <h1
                id={titleId}
                className="text-[19px] font-bold tracking-[-0.02em] text-white"
              >
                {isZh ? "充值 tUSDT" : "Deposit tUSDT"}
              </h1>
              <span className="inline-flex shrink-0 items-center rounded-full bg-[#15171b] border border-[#262a31] px-2 py-0.5 text-[10.5px] font-semibold text-[#b8bec6]">
                BEP-20
              </span>
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

          {/* Receive via BNB Chain Address + QR */}
          <section className="rounded-2xl bg-[#0b0c0e] border border-[#1d2025] p-4 space-y-3.5">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="font-semibold text-white">
                {isZh ? "钱包收款地址" : "Receive on BNB Chain"}
              </span>
              <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-[#b8bec6]">
                <span className="h-1.5 w-1.5 rounded-full bg-[#2EC26B]" aria-hidden="true" />
                BNB Smart Chain Testnet
              </span>
            </div>

            <div className="flex flex-col sm:flex-row items-center sm:items-start gap-4">
              <AddressQrSvg address={wallet.address} />

              <div className="min-w-0 flex-1 space-y-2.5 text-center sm:text-left">
                <div className="rounded-xl bg-[#121417] border border-[#1d2025] px-3 py-2 font-mono text-[11.5px] leading-relaxed text-[#d0d6de] break-all select-all">
                  {wallet.address}
                </div>

                <div className="flex flex-wrap items-center justify-center sm:justify-start gap-2">
                  <CopyAddressButton
                    value={wallet.address}
                    label={isZh ? "复制地址" : "Copy address"}
                    copiedLabel={isZh ? "已复制" : "Copied"}
                    failedLabel={isZh ? "复制失败" : "Copy failed"}
                  />
                  {explorerBase && (
                    <a
                      href={`${explorerBase}/address/${wallet.address}`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex min-h-7 items-center gap-1 rounded-full bg-[#15171b] px-3 py-1 text-xs font-semibold text-[#b8bec6] hover:text-white transition"
                    >
                      <span>BscScan</span>
                      <ExternalLink className="h-3 w-3" aria-hidden="true" />
                    </a>
                  )}
                </div>
              </div>
            </div>

            <p className="text-[11px] leading-relaxed text-[#7e8690]">
              {isZh
                ? "请仅向此地址转入 BNB Smart Chain Testnet (BEP-20) 的 tUSDT，其他网络资产将无法到账。"
                : "Send only BNB Smart Chain Testnet (BEP-20) tUSDT to this address. Assets on other networks cannot be recovered."}
            </p>
          </section>

          {onOpenMint && (
            <div className="flex items-center justify-between gap-2 rounded-2xl bg-[#15171b] border border-[#1d2025] px-4 py-3 text-xs">
              <span className="text-[#7e8690]">
                {isZh ? "需要测试网 tUSDT？" : "Need testnet tUSDT?"}
              </span>
              <button
                type="button"
                onClick={() => {
                  dialogRef.current?.close();
                  onOpenMint();
                }}
                className="inline-flex items-center gap-1 font-semibold text-white hover:text-white/85 transition cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white rounded"
              >
                <span>{isZh ? "去领水 Mint" : "Mint from faucet"}</span>
                <ArrowRight className="h-3 w-3" aria-hidden="true" />
              </button>
            </div>
          )}
        </div>
      </div>
    </dialog>
  );
}

export interface WithdrawModalProps {
  open: boolean;
  locale: Locale;
  wallet: ConnectedWallet;
  onClose: () => void;
  onWithdraw: (to: `0x${string}`, amountUsdt: number) => Promise<`0x${string}`>;
}

export function WithdrawModal({
  open,
  locale,
  wallet,
  onClose,
  onWithdraw,
}: WithdrawModalProps) {
  const isZh = locale === "zh";
  const titleId = useId();
  const toInputId = useId();
  const toHintId = useId();
  const toErrorId = useId();
  const amtInputId = useId();
  const amtHintId = useId();
  const amtErrorId = useId();

  const dialogRef = useRef<HTMLDialogElement>(null);
  const toInputRef = useRef<HTMLInputElement>(null);
  const amtInputRef = useRef<HTMLInputElement>(null);

  const [recipient, setRecipient] = useState("");
  const [amountStr, setAmountStr] = useState("");
  const [toTouched, setToTouched] = useState(false);
  const [amtTouched, setAmtTouched] = useState(false);
  const [submittedOnce, setSubmittedOnce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [txError, setTxError] = useState<string | null>(null);
  const [politeErrorAnnouncement, setPoliteErrorAnnouncement] = useState("");
  const announceTimerRef = useRef<number | null>(null);
  const [confirmed, setConfirmed] = useState<{
    txHash: `0x${string}`;
    to: `0x${string}`;
    amountUsdt: number;
  } | null>(null);

  useDialogLightDismiss(dialogRef, open, !busy);

  useEffect(() => {
    return () => {
      if (announceTimerRef.current !== null) {
        window.clearTimeout(announceTimerRef.current);
      }
    };
  }, []);

  const scheduleErrorAnnouncement = (fieldLabel: string, msg: string | null) => {
    if (announceTimerRef.current !== null) {
      window.clearTimeout(announceTimerRef.current);
    }
    setPoliteErrorAnnouncement("");
    if (!msg) return;
    // Delay briefly so screen readers finish announcing the newly focused control first.
    announceTimerRef.current = window.setTimeout(() => {
      setPoliteErrorAnnouncement(`${fieldLabel}: ${msg}`);
    }, 500);
  };

  const resetForm = () => {
    setRecipient("");
    setAmountStr("");
    setToTouched(false);
    setAmtTouched(false);
    setSubmittedOnce(false);
    setTxError(null);
    setPoliteErrorAnnouncement("");
    setConfirmed(null);
  };

  if (!open || !wallet.address) return null;

  const trimmedTo = recipient.trim();
  const parsedAmount = Number(amountStr);
  const explorerBase = getExplorerBaseUrl(wallet.chainId || BSC_TESTNET.chainId);

  const toErrorText = (() => {
    if (!trimmedTo) {
      return isZh
        ? "请输入以 0x 开头的 42 位 BNB Chain 地址。"
        : "Enter a 42-character BNB Chain address starting with 0x.";
    }
    if (!isAddress(trimmedTo)) {
      return isZh
        ? "地址格式无效，请检查是否完整复制了 0x 开头的 42 位地址。"
        : "Invalid address format. Enter a valid 0x address (42 characters).";
    }
    if (trimmedTo.toLowerCase() === wallet.address.toLowerCase()) {
      return isZh
        ? "提币目标地址不能与当前钱包地址相同。"
        : "Recipient address cannot be the same as your current wallet.";
    }
    return null;
  })();

  const amtErrorText = (() => {
    if (!amountStr.trim()) {
      return isZh ? "请输入提币金额。" : "Enter an amount to withdraw.";
    }
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      return isZh ? "提币金额必须大于 0。" : "Amount must be greater than 0.";
    }
    if (parsedAmount > wallet.usdtBalance + 1e-6) {
      return isZh
        ? `超出可用余额（最多可提 $${wallet.usdtBalance.toFixed(2)}）。`
        : `Exceeds available balance ($${wallet.usdtBalance.toFixed(2)} max).`;
    }
    return null;
  })();

  // Validate only after blur or submit attempt (never flash errors while typing fresh input)
  const showToError = Boolean(toErrorText && (toTouched || submittedOnce));
  const showAmtError = Boolean(amtErrorText && (amtTouched || submittedOnce));

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSubmittedOnce(true);
    setTxError(null);

    if (toErrorText) {
      toInputRef.current?.focus();
      return;
    }
    if (amtErrorText) {
      amtInputRef.current?.focus();
      return;
    }

    setBusy(true);
    try {
      const toAddr = trimmedTo as `0x${string}`;
      const hash = await onWithdraw(toAddr, parsedAmount);
      setConfirmed({ txHash: hash, to: toAddr, amountUsdt: parsedAmount });
    } catch (err: unknown) {
      setTxError(
        extractWalletErrorMessage(
          err,
          isZh ? "链上提币失败，请重试" : "Withdrawal failed. Please try again."
        )
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      {...({ closedby: busy ? "none" : "any" } as Record<string, unknown>)}
      onCancel={(e) => {
        if (busy) e.preventDefault();
      }}
      onClose={() => {
        if (dialogRef.current) dialogRef.current.returnValue = "";
        resetForm();
        onClose();
      }}
      className="payoff-sheet md:!w-[min(92vw,450px)] md:!max-w-[450px]"
    >
      <div className="flex max-h-[90dvh] flex-col md:max-h-[86dvh]">
        <div aria-hidden="true" className="payoff-sheet-handle" />

        <div className="overflow-y-auto px-5 pt-3 pb-6 sm:px-6 safe-pb space-y-4">
          {/* Header */}
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <h1
                id={titleId}
                className="text-[19px] font-bold tracking-[-0.02em] text-white"
              >
                {isZh ? "提币 tUSDT" : "Withdraw tUSDT"}
              </h1>
              <span className="inline-flex shrink-0 items-center rounded-full bg-[#15171b] border border-[#262a31] px-2 py-0.5 text-[10.5px] font-semibold text-[#b8bec6]">
                BEP-20
              </span>
            </div>
            <button
              type="button"
              disabled={busy}
              aria-label={isZh ? "关闭" : "Close"}
              onClick={() => dialogRef.current?.close()}
              className="rounded-full p-1.5 text-[#7e8690] hover:bg-[#24282f] hover:text-white disabled:opacity-40 transition cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>

          {confirmed ? (
            <div className="space-y-4 pt-1">
              <div
                role="status"
                aria-live="polite"
                className="rounded-2xl bg-[#2EC26B]/12 border border-[#2EC26B]/25 p-4 space-y-2.5"
              >
                <div className="flex items-center gap-2 text-sm font-bold text-[#2EC26B]">
                  <CheckCircle2 className="h-4.5 w-4.5 shrink-0" aria-hidden="true" />
                  <span>
                    {isZh ? "链上提币已确认" : "Withdrawal confirmed"}
                  </span>
                </div>
                <div className="text-2xl font-bold text-white tabular-nums">
                  ${confirmed.amountUsdt.toFixed(2)}{" "}
                  <span className="text-xs font-semibold text-[#b8bec6]">tUSDT</span>
                </div>
                <div className="text-xs text-[#b8bec6] break-all font-mono">
                  → {confirmed.to}
                </div>
                {explorerBase && (
                  <a
                    href={`${explorerBase}/tx/${confirmed.txHash}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs font-semibold text-[#2EC26B] underline underline-offset-2 hover:text-[#2EC26B]/90"
                  >
                    <span>{isZh ? "在 BscScan 查看交易" : "View tx on BscScan"}</span>
                    <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  </a>
                )}
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={resetForm}
                  className="flex-1 min-h-[44px] rounded-full bg-[#24282f] px-4 py-2.5 text-xs font-bold text-white hover:bg-[#2f343d] transition cursor-pointer"
                >
                  {isZh ? "再转一笔" : "Send another"}
                </button>
                <button
                  type="button"
                  autoFocus
                  onClick={() => dialogRef.current?.close()}
                  className="flex-1 min-h-[44px] rounded-full bg-white px-4 py-2.5 text-xs font-bold text-black hover:bg-white/90 transition cursor-pointer"
                >
                  {isZh ? "完成" : "Done"}
                </button>
              </div>
            </div>
          ) : (
            <form noValidate onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
              {/* Recipient Address */}
              <div className="space-y-1.5">
                <label
                  htmlFor={toInputId}
                  className="block text-xs font-semibold text-white"
                >
                  {isZh ? "接收地址" : "Recipient address"}
                </label>
                {/* Format hint placed above input so autocomplete/mobile keyboards never cover it */}
                <p id={toHintId} className="text-[11px] text-[#7e8690]">
                  {isZh
                    ? "BNB Smart Chain Testnet (BEP-20) 0x 地址"
                    : "BNB Smart Chain Testnet (BEP-20) 0x address"}
                </p>
                <input
                  ref={toInputRef}
                  id={toInputId}
                  type="text"
                  autoFocus
                  required
                  pattern="^0x[0-9a-fA-F]{40}$"
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="0x..."
                  value={recipient}
                  disabled={busy}
                  aria-invalid={showToError ? "true" : "false"}
                  aria-describedby={showToError ? `${toHintId} ${toErrorId}` : toHintId}
                  onChange={(e) => {
                    setRecipient(e.target.value);
                    setTxError(null);
                  }}
                  onBlur={() => {
                    if (recipient.length > 0) {
                      setToTouched(true);
                      scheduleErrorAnnouncement(
                        isZh ? "接收地址" : "Recipient address",
                        toErrorText
                      );
                    }
                  }}
                  className="payoff-field-input w-full rounded-xl border border-[#262a31] bg-[#0b0c0e] px-3.5 py-2.5 font-mono text-xs text-white placeholder:text-[#555c66] focus:border-white/40 focus:outline-none disabled:opacity-50"
                />
                {showToError && toErrorText && (
                  <p
                    id={toErrorId}
                    className="flex items-start gap-1.5 text-xs text-[#E85D4A]"
                  >
                    <AlertCircle
                      className="h-3.5 w-3.5 mt-0.5 shrink-0"
                      aria-hidden="true"
                    />
                    <span>{toErrorText}</span>
                  </p>
                )}
              </div>

              {/* Amount */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <label
                    htmlFor={amtInputId}
                    className="text-xs font-semibold text-white"
                  >
                    {isZh ? "提币金额 (tUSDT)" : "Amount (tUSDT)"}
                  </label>
                  <span id={amtHintId} className="text-[11px] text-[#7e8690] tabular-nums">
                    {isZh ? "可用" : "Available"}{" "}
                    <strong className="font-semibold text-[#d0d6de]">
                      ${wallet.usdtBalance.toLocaleString("en-US", {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                    </strong>
                  </span>
                </div>

                <div className="relative flex items-center">
                  <input
                    ref={amtInputRef}
                    id={amtInputId}
                    type="number"
                    inputMode="decimal"
                    required
                    min="0.01"
                    max={wallet.usdtBalance > 0 ? wallet.usdtBalance : undefined}
                    step="any"
                    placeholder="0.00"
                    value={amountStr}
                    disabled={busy}
                    aria-invalid={showAmtError ? "true" : "false"}
                    aria-describedby={
                      showAmtError ? `${amtHintId} ${amtErrorId}` : amtHintId
                    }
                    onChange={(e) => {
                      setAmountStr(e.target.value);
                      setTxError(null);
                    }}
                    onBlur={() => {
                      if (amountStr.length > 0) {
                        setAmtTouched(true);
                        scheduleErrorAnnouncement(
                          isZh ? "提币金额" : "Amount",
                          amtErrorText
                        );
                      }
                    }}
                    className="payoff-field-input w-full rounded-xl border border-[#262a31] bg-[#0b0c0e] px-3.5 py-2.5 pr-16 text-sm font-semibold text-white placeholder:text-[#555c66] tabular-nums focus:border-white/40 focus:outline-none disabled:opacity-50"
                  />
                  <button
                    type="button"
                    disabled={busy || wallet.usdtBalance <= 0}
                    onClick={() => {
                      setAmountStr(
                        wallet.usdtBalance > 0
                          ? String(Math.floor(wallet.usdtBalance * 100) / 100)
                          : ""
                      );
                      setAmtTouched(true);
                      setTxError(null);
                    }}
                    className="absolute right-2 rounded-full bg-[#24282f] px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-[#2f343d] disabled:opacity-40 transition cursor-pointer"
                  >
                    {isZh ? "最大" : "Max"}
                  </button>
                </div>

                {showAmtError && amtErrorText && (
                  <p
                    id={amtErrorId}
                    className="flex items-start gap-1.5 text-xs text-[#E85D4A]"
                  >
                    <AlertCircle
                      className="h-3.5 w-3.5 mt-0.5 shrink-0"
                      aria-hidden="true"
                    />
                    <span>{amtErrorText}</span>
                  </p>
                )}
              </div>

              {/* Fee Summary */}
              <div className="rounded-xl bg-[#0b0c0e] border border-[#1d2025] px-3.5 py-2.5 space-y-1.5 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-[#7e8690]">
                    {isZh ? "网络" : "Network"}
                  </span>
                  <span className="font-medium text-[#d0d6de]">
                    BNB Smart Chain Testnet (BEP-20)
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[#7e8690]">
                    {isZh ? "手续费" : "Fee"}
                  </span>
                  <span className="font-semibold text-[#2EC26B]">
                    {isZh ? "$0" : "$0"}
                  </span>
                </div>
              </div>

              {txError && (
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded-xl bg-[#E85D4A]/13 px-3.5 py-2.5 text-xs font-medium text-[#E85D4A]"
                >
                  <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
                  <span>{txError}</span>
                </div>
              )}

              <button
                type="submit"
                disabled={busy || wallet.usdtBalance <= 0}
                className="flex w-full min-h-[46px] items-center justify-center gap-2 rounded-full bg-white py-2.5 text-sm font-bold text-black hover:bg-white/90 disabled:opacity-45 transition cursor-pointer tabular-nums"
              >
                {busy ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    <span>{isZh ? "发送中..." : "Sending..."}</span>
                  </>
                ) : (
                  <>
                    <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
                    <span>
                      {Number.isFinite(parsedAmount) && parsedAmount > 0
                        ? isZh
                          ? `确认提币 $${parsedAmount.toFixed(2)} tUSDT`
                          : `Withdraw $${parsedAmount.toFixed(2)} tUSDT`
                        : isZh
                          ? "确认提币"
                          : "Withdraw"}
                    </span>
                  </>
                )}
              </button>

              {/* Single polite live region for delayed post-blur error announcements */}
              <div
                aria-live="polite"
                className="payoff-visually-hidden"
              >
                {politeErrorAnnouncement}
              </div>
            </form>
          )}
        </div>
      </div>
    </dialog>
  );
}

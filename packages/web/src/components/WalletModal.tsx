import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Droplets,
  ExternalLink,
  Globe,
  History,
  KeyRound,
  Loader2,
  LogOut,
  Mail,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import {
  ASSET_SPECS,
  BSC_TESTNET,
  computeRemainingStakeUsdt,
  type PositionView,
  type UnderlyingSymbol,
} from "@payoff/shared";
import type { HealthResponse } from "../lib/api";
import { formatExpiryDateTime } from "../lib/format";
import { getCopy, SUPPORTED_LOCALES, type Locale } from "../lib/i18n";
import {
  executeClaimTestUsdtTx,
  extractWalletErrorMessage,
  getExplorerBaseUrl,
  type ConnectedWallet,
} from "../lib/wallet";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export interface WalletModalProps {
  open: boolean;
  locale: Locale;
  wallet: ConnectedWallet;
  positions?: PositionView[];
  health?: HealthResponse;
  onClose: () => void;
  onLogin: () => void;
  onExportWallet: () => void;
  onDisconnect: () => void;
  onClaimFaucet?: (amountUsdt?: number) => Promise<void> | void;
  onBatchClaim?: (seriesIds: `0x${string}`[]) => Promise<void> | void;
  onClaimPosition?: (position: PositionView) => Promise<void> | void;
  onSelectPositionMarket?: (
    underlying: UnderlyingSymbol,
    expiry: number
  ) => void;
  onOpenMarketPicker?: () => void;
  onOpenHistory?: () => void;
  onOpenRules?: () => void;
  onSelectLocale?: (locale: Locale) => void;
  onToggleLang?: () => void;
  onRefresh?: () => void;
}

function formatExpiryGroupTitle(expirySec: number, locale: Locale): string {
  return formatExpiryDateTime(expirySec, locale);
}

function formatRemainingShort(expirySec: number, isZh: boolean): string {
  const diff = Math.max(0, expirySec - Math.floor(Date.now() / 1000));
  if (diff === 0) return isZh ? "已到期" : "Expired";
  const days = Math.floor(diff / 86400);
  const hours = Math.floor((diff % 86400) / 3600);
  const mins = Math.floor((diff % 3600) / 60);
  if (days >= 1) return isZh ? `还剩 ${days} 天` : `${days}d left`;
  if (hours >= 1) return isZh ? `还剩 ${hours} 小时` : `${hours}h left`;
  return isZh ? `还剩 ${Math.max(1, mins)} 分钟` : `${Math.max(1, mins)}m left`;
}

function formatSignedUsd(v: number): string {
  const sign = v >= 0 ? "+" : "−";
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

export function WalletModal({
  open,
  locale,
  wallet,
  positions = [],
  health,
  onClose,
  onLogin,
  onExportWallet,
  onDisconnect,
  onClaimFaucet,
  onBatchClaim,
  onClaimPosition,
  onSelectPositionMarket,
  onOpenMarketPicker,
  onOpenHistory,
  onOpenRules,
  onSelectLocale,
  onToggleLang,
  onRefresh,
}: WalletModalProps) {
  const isZh = locale === "zh";
  const t = getCopy(locale);
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);

  const [copied, setCopied] = useState(false);
  const [addressExpanded, setAddressExpanded] = useState(false);
  const [faucetBusy, setFaucetBusy] = useState(false);
  const [faucetMsg, setFaucetMsg] = useState<{
    kind: "ok" | "err";
    text: string;
  } | null>(null);
  const [claimingId, setClaimingId] = useState<string | null>(null);

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

  const {
    claimablePositions,
    claimableSeriesIds,
    claimableTotalUsdt,
    activeGroups,
    activePortfolioValue,
    activeUnrealizedPnl,
    historyCount,
    historyNetPnl,
  } = useMemo(() => {
    const claimable = positions
      .filter((p) => p.status === "SETTLED_CLAIMABLE" && p.claimableUsdt > 0)
      .sort((a, b) => a.expiry - b.expiry);

    const uniqueSeries = Array.from(
      new Set(claimable.map((p) => p.seriesId))
    ) as `0x${string}`[];
    const claimableSum = claimable.reduce((s, p) => s + p.claimableUsdt, 0);

    const active = positions
      .filter((p) => p.status === "ACTIVE")
      .sort((a, b) => a.expiry - b.expiry);

    const groupMap = new Map<
      string,
      {
        key: string;
        underlying: UnderlyingSymbol;
        expiry: number;
        items: PositionView[];
        totalStake: number;
        totalValue: number;
        totalPnl: number;
        bullCount: number;
        bearCount: number;
      }
    >();

    for (const p of active) {
      const key = `${p.underlying}:${p.expiry}`;
      const remainingStake = computeRemainingStakeUsdt(p);
      const existing = groupMap.get(key);
      if (existing) {
        existing.items.push(p);
        existing.totalStake += remainingStake;
        existing.totalValue += p.indicativeExitUsdt;
        existing.totalPnl += p.unrealizedPnlUsdt;
        if (p.isUp) existing.bullCount += 1;
        else existing.bearCount += 1;
      } else {
        groupMap.set(key, {
          key,
          underlying: p.underlying,
          expiry: p.expiry,
          items: [p],
          totalStake: remainingStake,
          totalValue: p.indicativeExitUsdt,
          totalPnl: p.unrealizedPnlUsdt,
          bullCount: p.isUp ? 1 : 0,
          bearCount: p.isUp ? 0 : 1,
        });
      }
    }

    const groups = Array.from(groupMap.values()).sort(
      (a, b) => a.expiry - b.expiry
    );

    const portfolioVal =
      active.reduce((s, p) => s + p.indicativeExitUsdt, 0) + claimableSum;
    const portfolioPnl =
      active.reduce((s, p) => s + p.unrealizedPnlUsdt, 0) +
      claimable.reduce(
        (s, p) => s + (p.claimableUsdt - computeRemainingStakeUsdt(p)),
        0
      );

    const finished = positions.filter(
      (p) =>
        p.status === "CLOSED_EARLY" ||
        p.status === "SETTLED_CLAIMED" ||
        p.status === "SETTLED_CLAIMABLE"
    );
    const histPnl = finished.reduce((sum, p) => {
      const payout =
        p.earlyCloseProceedsUsdt +
        p.redeemedUsdt +
        (p.status === "SETTLED_CLAIMABLE" ? p.claimableUsdt : 0);
      return sum + (payout - p.totalStakeUsdt);
    }, 0);

    return {
      claimablePositions: claimable,
      claimableSeriesIds: uniqueSeries,
      claimableTotalUsdt: claimableSum,
      activeGroups: groups,
      activePortfolioValue: portfolioVal,
      activeUnrealizedPnl: portfolioPnl,
      historyCount: finished.length,
      historyNetPnl: histPnl,
    };
  }, [positions]);

  if (!open) return null;

  const isConnected = wallet.kind !== "NONE" && Boolean(wallet.address);
  const explorerBase = getExplorerBaseUrl(wallet.chainId);

  const handleCopy = () => {
    if (!wallet.address) return;
    void navigator.clipboard.writeText(wallet.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const handleFaucet = async () => {
    if (faucetBusy || !isConnected) return;
    setFaucetBusy(true);
    setFaucetMsg(null);
    try {
      if (onClaimFaucet) {
        await onClaimFaucet(1000);
      } else {
        const rpcUrl = health?.rpcUrl || BSC_TESTNET.rpcUrl;
        const usdtAddress =
          health?.usdtAddress && health.usdtAddress !== ZERO_ADDRESS
            ? health.usdtAddress
            : BSC_TESTNET.usdtAddress;
        if (!usdtAddress || usdtAddress === ZERO_ADDRESS) {
          throw new Error(
            isZh
              ? "测试网 tUSDT 合约未就绪"
              : "Testnet tUSDT contract unavailable"
          );
        }
        await executeClaimTestUsdtTx({
          wallet,
          rpcUrl,
          usdtAddress,
          amountUsdt: 1000,
        });
        onRefresh?.();
      }
      setFaucetMsg({
        kind: "ok",
        text: isZh
          ? "已免 Gas 领取 1,000 tUSDT"
          : "Claimed 1,000 tUSDT gas-free",
      });
    } catch (err: unknown) {
      setFaucetMsg({
        kind: "err",
        text: extractWalletErrorMessage(
          err,
          isZh ? "领水失败，请重试" : "Faucet claim failed"
        ),
      });
    } finally {
      setFaucetBusy(false);
    }
  };

  const handleClaimSingle = async (pos: PositionView) => {
    if (claimingId) return;
    setClaimingId(pos.seriesId);
    try {
      if (onClaimPosition) {
        await onClaimPosition(pos);
      } else if (onBatchClaim) {
        await onBatchClaim([pos.seriesId]);
      }
    } finally {
      setClaimingId(null);
    }
  };

  const handleClaimAll = async () => {
    if (claimingId || claimableSeriesIds.length === 0) return;
    setClaimingId("ALL");
    try {
      if (onBatchClaim) {
        await onBatchClaim(claimableSeriesIds);
      } else if (onClaimPosition && claimablePositions[0]) {
        await onClaimPosition(claimablePositions[0]);
      }
    } finally {
      setClaimingId(null);
    }
  };

  const shortAddr = wallet.address
    ? `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}`
    : "";

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      {...({ closedby: "any" } as Record<string, unknown>)}
      onClose={() => {
        if (dialogRef.current) dialogRef.current.returnValue = "";
        setFaucetMsg(null);
        onClose();
      }}
      className="payoff-sheet md:!w-[min(92vw,460px)] md:!max-w-[460px]"
    >
      <div className="flex max-h-[90dvh] flex-col md:max-h-[86dvh]">
        <div aria-hidden="true" className="payoff-sheet-handle" />

        <div className="overflow-y-auto px-5 pt-3 pb-6 sm:px-6 safe-pb space-y-4">
          {isConnected && wallet.address ? (
            <>
              {/* Header: Email + Gas Free pill + Logout + Close */}
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <h1
                    id={titleId}
                    className="text-[15px] font-bold text-white truncate"
                  >
                    {wallet.email ||
                      wallet.walletName ||
                      (isZh ? "邮箱账户" : "Email account")}
                  </h1>
                  <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[#2EC26B]/13 px-2 py-0.5 text-[10.5px] font-bold text-[#2EC26B]">
                    <Sparkles className="h-2.5 w-2.5" aria-hidden="true" />
                    {isZh ? "免 Gas" : "Gas Free"}
                  </span>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => {
                      dialogRef.current?.close();
                      onDisconnect();
                    }}
                    className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold text-[#7e8690] hover:bg-[#24282f] hover:text-white transition cursor-pointer"
                  >
                    <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>{isZh ? "退出" : "Sign out"}</span>
                  </button>
                  <button
                    type="button"
                    autoFocus
                    aria-label={t.cancel}
                    onClick={() => dialogRef.current?.close()}
                    className="rounded-full p-1.5 text-[#7e8690] hover:bg-[#24282f] hover:text-white transition cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
                  >
                    <X className="h-4.5 w-4.5" aria-hidden="true" />
                  </button>
                </div>
              </div>

              {/* Portfolio Summary */}
              <div className="border-b border-[#1d2025] pb-4 space-y-2.5">
                <div className="flex items-end justify-between gap-3">
                  <div>
                    <div className="text-[11.5px] font-semibold text-[#7e8690]">
                      {isZh ? "全部持仓现值" : "Active portfolio value"}
                    </div>
                    <div className="mt-0.5 text-[28px] font-bold leading-tight tracking-[-0.03em] text-white tabular-nums">
                      $
                      {activePortfolioValue.toLocaleString("en-US", {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs font-semibold tabular-nums">
                      {activePortfolioValue > 0 && (
                        <>
                          <span
                            className={
                              activeUnrealizedPnl >= 0
                                ? "text-[#2EC26B]"
                                : "text-[#E85D4A]"
                            }
                          >
                            {formatSignedUsd(activeUnrealizedPnl)}
                          </span>
                          <span className="text-[#7e8690]">·</span>
                        </>
                      )}
                      <span className="font-medium text-[#7e8690]">
                        {isZh ? "可用" : "Available"}{" "}
                        <span className="text-[#b8bec6] font-semibold">
                          $
                          {wallet.usdtBalance.toLocaleString("en-US", {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })}
                        </span>
                      </span>
                    </div>
                  </div>

                  <button
                    type="button"
                    disabled={faucetBusy}
                    onClick={() => void handleFaucet()}
                    className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-[#24282f] px-3.5 text-xs font-bold text-white hover:bg-[#2f343d] disabled:opacity-50 transition cursor-pointer"
                  >
                    {faucetBusy ? (
                      <Loader2
                        className="h-3.5 w-3.5 animate-spin"
                        aria-hidden="true"
                      />
                    ) : (
                      <Droplets className="h-3.5 w-3.5" aria-hidden="true" />
                    )}
                    <span>
                      {faucetBusy
                        ? isZh
                          ? "领取中..."
                          : "Minting..."
                        : isZh
                          ? "免 Gas 领水"
                          : "Faucet +1k"}
                    </span>
                  </button>
                </div>

                {faucetMsg && (
                  <div
                    role={faucetMsg.kind === "err" ? "alert" : "status"}
                    className={`rounded-xl px-3 py-2 text-xs font-medium ${
                      faucetMsg.kind === "ok"
                        ? "bg-[#2EC26B]/13 text-[#2EC26B]"
                        : "bg-[#E85D4A]/13 text-[#E85D4A]"
                    }`}
                  >
                    {faucetMsg.text}
                  </div>
                )}
              </div>

              {/* Claimable Positions First */}
              {claimablePositions.length > 0 && (
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-[11.5px] font-bold tracking-[0.02em] text-[#7e8690]">
                      {isZh ? "待领取" : "Claimable"}
                    </span>
                    {claimableSeriesIds.length > 1 && onBatchClaim && (
                      <button
                        type="button"
                        disabled={Boolean(claimingId)}
                        onClick={() => void handleClaimAll()}
                        className="inline-flex h-7 items-center gap-1 rounded-full bg-white px-3 text-[11.5px] font-bold text-black hover:bg-white/90 disabled:opacity-50 transition cursor-pointer tabular-nums"
                      >
                        {claimingId === "ALL" && (
                          <Loader2
                            className="h-3 w-3 animate-spin"
                            aria-hidden="true"
                          />
                        )}
                        <span>
                          {isZh
                            ? `一键领取 $${claimableTotalUsdt.toFixed(2)}`
                            : `Claim all $${claimableTotalUsdt.toFixed(2)}`}
                        </span>
                      </button>
                    )}
                  </div>

                  <div className="divide-y divide-[#1d2025]">
                    {claimablePositions.map((pos) => {
                      const spec = ASSET_SPECS[pos.underlying];
                      const mult =
                        pos.totalStakeUsdt > 0
                          ? pos.initialMaxPayoutUsdt / pos.totalStakeUsdt
                          : 0;
                      const isThisClaiming =
                        claimingId === pos.seriesId || claimingId === "ALL";
                      return (
                        <div
                          key={`${pos.seriesId}:${pos.isUp ? "UP" : "DOWN"}`}
                          className="flex items-center justify-between gap-3 py-2.5"
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="text-[14px] font-bold text-white tabular-nums">
                                {spec.displaySymbol}{" "}
                                {pos.isUp ? t.bull : t.bear}
                                {mult > 0 ? ` ${mult.toFixed(2)}x` : ""}
                              </span>
                              <span className="rounded-full bg-[#E6BA5C]/12 px-2 py-0.5 text-[10px] font-bold text-[#E6BA5C]">
                                {isZh ? "已结算" : "Settled"}
                              </span>
                            </div>
                            <div className="mt-0.5 text-xs text-[#7e8690] tabular-nums">
                              {isZh
                                ? `投入 $${computeRemainingStakeUsdt(pos).toFixed(2)} · 拿回 $${pos.claimableUsdt.toFixed(2)}`
                                : `Stake $${computeRemainingStakeUsdt(pos).toFixed(2)} · Payout $${pos.claimableUsdt.toFixed(2)}`}
                            </div>
                          </div>

                          <button
                            type="button"
                            disabled={Boolean(claimingId)}
                            onClick={() => void handleClaimSingle(pos)}
                            className="inline-flex h-8 shrink-0 items-center gap-1 rounded-full bg-white px-3.5 text-xs font-bold text-black hover:bg-white/90 disabled:opacity-50 transition cursor-pointer tabular-nums"
                          >
                            {isThisClaiming && (
                              <Loader2
                                className="h-3 w-3 animate-spin"
                                aria-hidden="true"
                              />
                            )}
                            <span>
                              {isZh
                                ? `领取 $${pos.claimableUsdt.toFixed(2)}`
                                : `Claim $${pos.claimableUsdt.toFixed(2)}`}
                            </span>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Active Positions Grouped by Underlying + Expiry */}
              {activeGroups.length > 0 && (
                <div className="space-y-1">
                  <div className="text-[11.5px] font-bold tracking-[0.02em] text-[#7e8690]">
                    {isZh ? "持仓中（按到期从近到远）" : "Active positions"}
                  </div>
                  <div className="divide-y divide-[#1d2025]">
                    {activeGroups.map((group) => {
                      const spec = ASSET_SPECS[group.underlying];
                      const single =
                        group.items.length === 1 ? group.items[0] : null;
                      const singleMult =
                        single && single.totalStakeUsdt > 0
                          ? single.initialMaxPayoutUsdt / single.totalStakeUsdt
                          : 0;
                      const expiryTitle = formatExpiryGroupTitle(
                        group.expiry,
                        locale
                      );
                      const titleText = single
                        ? `${spec.displaySymbol} ${single.isUp ? t.bull : t.bear}${singleMult > 0 ? ` ${singleMult.toFixed(2)}x` : ""}`
                        : isZh
                          ? `${spec.displaySymbol} · ${group.items.length} 笔`
                          : `${spec.displaySymbol} · ${group.items.length} tickets`;

                      const metaText = single
                        ? `${expiryTitle} · ${formatRemainingShort(group.expiry, isZh)} · ${isZh ? "投入" : "Stake"} $${group.totalStake.toFixed(0)}`
                        : `${expiryTitle} · ${
                            group.bullCount > 0
                              ? `${group.bullCount} ${t.bull}`
                              : ""
                          }${
                            group.bullCount > 0 && group.bearCount > 0
                              ? " · "
                              : ""
                          }${
                            group.bearCount > 0
                              ? `${group.bearCount} ${t.bear}`
                              : ""
                          } · ${isZh ? "投入" : "Stake"} $${group.totalStake.toFixed(0)}`;

                      const hasTwap = group.items.some((i) => i.inTwapWindow);

                      return (
                        <button
                          key={group.key}
                          type="button"
                          onClick={() => {
                            dialogRef.current?.close();
                            onSelectPositionMarket?.(
                              group.underlying,
                              group.expiry
                            );
                          }}
                          className="flex w-full items-center justify-between gap-3 py-2.5 text-left hover:bg-[#15171b] -mx-2 px-2 rounded-xl transition cursor-pointer"
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="text-[14.5px] font-bold text-white tabular-nums">
                                {titleText}
                              </span>
                              {hasTwap && (
                                <span className="rounded-full bg-[#E6BA5C] px-1.5 py-0.5 text-[10px] font-bold text-black">
                                  {isZh ? "锁定期" : "TWAP"}
                                </span>
                              )}
                            </div>
                            <div className="mt-0.5 text-xs text-[#7e8690] tabular-nums truncate">
                              {metaText}
                            </div>
                          </div>

                          <div className="flex items-center gap-1.5 shrink-0">
                            <div className="text-right tabular-nums">
                              <div className="text-[15px] font-bold text-white tracking-[-0.02em]">
                                ${group.totalValue.toFixed(2)}
                              </div>
                              <div
                                className={`text-xs font-semibold ${
                                  group.totalPnl >= 0
                                    ? "text-[#2EC26B]"
                                    : "text-[#E85D4A]"
                                }`}
                              >
                                {formatSignedUsd(group.totalPnl)}
                              </div>
                            </div>
                            <ChevronRight
                              className="h-4 w-4 text-[#7e8690]"
                              aria-hidden="true"
                            />
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Footer Actions */}
              <div className="border-t border-[#1d2025] divide-y divide-[#1d2025] pt-1">
                {onOpenHistory && (
                  <button
                    type="button"
                    onClick={() => {
                      dialogRef.current?.close();
                      onOpenHistory();
                    }}
                    className="flex w-full items-center justify-between gap-2 py-3 text-left text-[13.5px] font-semibold text-white hover:text-white/90 cursor-pointer"
                  >
                    <span className="inline-flex items-center gap-2">
                      <History
                        className="h-4 w-4 text-[#7e8690]"
                        aria-hidden="true"
                      />
                      <span>{isZh ? "历史与战绩" : "History & Stats"}</span>
                    </span>
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-[#7e8690] tabular-nums">
                      {historyCount > 0 ? (
                        <>
                          <span>
                            {isZh ? `${historyCount} 笔` : `${historyCount}`} ·{" "}
                            <span
                              className={
                                historyNetPnl >= 0
                                  ? "text-[#2EC26B]"
                                  : "text-[#E85D4A]"
                              }
                            >
                              {formatSignedUsd(historyNetPnl)}
                            </span>
                          </span>
                        </>
                      ) : (
                        <span>{isZh ? "暂无记录" : "Empty"}</span>
                      )}
                      <ChevronRight className="h-4 w-4" aria-hidden="true" />
                    </span>
                  </button>
                )}

                {onOpenMarketPicker && (
                  <button
                    type="button"
                    onClick={() => {
                      dialogRef.current?.close();
                      onOpenMarketPicker();
                    }}
                    className="flex w-full items-center justify-between gap-2 py-3 text-left text-[13.5px] font-semibold text-white hover:text-white/90 cursor-pointer"
                  >
                    <span>
                      {isZh
                        ? "切换市场 · BTC / ETH / NVDA"
                        : "Switch market · BTC / ETH / NVDA"}
                    </span>
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-[#7e8690]">
                      <span>{isZh ? "3 个市场" : "3 markets"}</span>
                      <ChevronRight className="h-4 w-4" aria-hidden="true" />
                    </span>
                  </button>
                )}

                {onOpenRules && (
                  <button
                    type="button"
                    onClick={() => {
                      dialogRef.current?.close();
                      onOpenRules();
                    }}
                    className="flex w-full items-center justify-between gap-2 py-3 text-left text-[13.5px] font-semibold text-white hover:text-white/90 cursor-pointer"
                  >
                    <span className="inline-flex items-center gap-2">
                      <ShieldCheck
                        className="h-4 w-4 text-[#7e8690]"
                        aria-hidden="true"
                      />
                      <span>
                        {isZh ? "规则与预言机安全" : "Rules & Security"}
                      </span>
                    </span>
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-[#7e8690]">
                      <span>Atlas TWAP</span>
                      <ChevronRight className="h-4 w-4" aria-hidden="true" />
                    </span>
                  </button>
                )}

                {(onSelectLocale || onToggleLang) && (
                  <div className="flex w-full items-center justify-between gap-2 py-2.5">
                    <span className="inline-flex items-center gap-2 text-[13.5px] font-semibold text-white">
                      <Globe
                        className="h-4 w-4 text-[#7e8690]"
                        aria-hidden="true"
                      />
                      <span>{isZh ? "语言" : "Language"}</span>
                    </span>
                    <div
                      role="group"
                      aria-label={isZh ? "选择语言" : "Select language"}
                      className="inline-flex items-center gap-0.5 rounded-full bg-[#15171b] p-0.5"
                    >
                      {SUPPORTED_LOCALES.map((opt) => {
                        const active = opt.code === locale;
                        return (
                          <button
                            key={opt.code}
                            type="button"
                            lang={opt.htmlLang}
                            aria-pressed={active}
                            onClick={() => {
                              if (active) return;
                              if (onSelectLocale) {
                                onSelectLocale(opt.code);
                              } else {
                                onToggleLang?.();
                              }
                            }}
                            className={`rounded-full px-2.5 py-1 text-xs font-semibold transition cursor-pointer focus-visible:outline-2 focus-visible:outline-white/75 ${
                              active
                                ? "bg-[#24282f] text-white"
                                : "text-[#7e8690] hover:text-[#b8bec6]"
                            }`}
                          >
                            {opt.nativeName}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Collapsible On-chain Address & Export Private Key */}
                <div className="pt-1">
                  <button
                    type="button"
                    aria-expanded={addressExpanded}
                    onClick={() => setAddressExpanded((v) => !v)}
                    className="flex w-full items-center justify-between gap-2 py-2.5 text-left text-[13.5px] font-semibold text-white hover:text-white/90 cursor-pointer"
                  >
                    <span className="inline-flex items-center gap-2">
                      <KeyRound
                        className="h-4 w-4 text-[#7e8690]"
                        aria-hidden="true"
                      />
                      <span>
                        {isZh ? "链上地址与导出私钥" : "On-chain Address & Key"}
                      </span>
                    </span>
                    <span className="inline-flex items-center gap-1 font-mono text-xs font-medium text-[#7e8690]">
                      <span>{shortAddr}</span>
                      <ChevronDown
                        className={`h-4 w-4 transition-transform ${
                          addressExpanded ? "rotate-180 text-white" : ""
                        }`}
                        aria-hidden="true"
                      />
                    </span>
                  </button>

                  {addressExpanded && (
                    <div className="mt-1.5 rounded-2xl bg-[#15171b] border border-[#1d2025] p-3.5 space-y-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-xs text-[#b8bec6] break-all">
                          {wallet.address}
                        </span>
                        <button
                          type="button"
                          onClick={handleCopy}
                          aria-label={isZh ? "复制地址" : "Copy address"}
                          className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[#24282f] px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-[#2f343d] cursor-pointer"
                        >
                          {copied ? (
                            <>
                              <Check
                                className="h-3 w-3 text-[#2EC26B]"
                                aria-hidden="true"
                              />
                              <span>{isZh ? "已复制" : "Copied"}</span>
                            </>
                          ) : (
                            <>
                              <Copy className="h-3 w-3" aria-hidden="true" />
                              <span>{isZh ? "复制" : "Copy"}</span>
                            </>
                          )}
                        </button>
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#1d2025] pt-2.5">
                        {explorerBase ? (
                          <a
                            href={`${explorerBase}/address/${wallet.address}`}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-xs font-semibold text-[#b8bec6] hover:text-white transition"
                          >
                            <span>{t.viewOnBscScan}</span>
                            <ExternalLink
                              className="h-3 w-3"
                              aria-hidden="true"
                            />
                          </a>
                        ) : (
                          <span className="text-[11px] text-[#7e8690]">
                            BNB Chain Testnet
                          </span>
                        )}

                        <button
                          type="button"
                          onClick={() => {
                            // Close native top-layer <dialog> first so Privy's export modal is never occluded.
                            dialogRef.current?.close();
                            onExportWallet();
                          }}
                          className="inline-flex items-center gap-1.5 rounded-full bg-[#24282f] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#2f343d] transition cursor-pointer"
                        >
                          <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>{t.exportPrivateKey}</span>
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </>
          ) : (
            /* Disconnected Sign-In State */
            <div className="space-y-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h1
                    id={titleId}
                    className="text-[19px] font-bold tracking-[-0.02em] text-white"
                  >
                    {t.connectWallet}
                  </h1>
                  <p className="mt-1 text-xs text-[#7e8690]">
                    {isZh
                      ? "邮箱一键登录，自动生成免 Gas BNB 账户并空投 1,000 tUSDT"
                      : "Sign in with email for a gasless BNB account + 1,000 free tUSDT"}
                  </p>
                </div>
                <button
                  type="button"
                  aria-label={t.cancel}
                  onClick={() => dialogRef.current?.close()}
                  className="rounded-full p-1.5 text-[#7e8690] hover:bg-[#24282f] hover:text-white transition cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
                >
                  <X className="h-5 w-5" aria-hidden="true" />
                </button>
              </div>

              <div className="rounded-2xl bg-[#2EC26B]/13 p-3.5 text-xs leading-relaxed text-[#cbead7]">
                {isZh ? (
                  <>
                    自动创建<strong className="text-white">免 Gas 嵌入式账户</strong>
                    并空投 <strong className="text-white">1,000 测试 USDT</strong>
                    。无需钱包插件，无需助记词，随时可导出私钥。
                  </>
                ) : (
                  <>
                    Creates a{" "}
                    <strong className="text-white">gasless embedded account</strong>{" "}
                    with <strong className="text-white">1,000 free tUSDT</strong>.
                    No wallet extension or seed phrase needed.
                  </>
                )}
              </div>

              <button
                type="button"
                autoFocus
                onClick={() => {
                  dialogRef.current?.close();
                  onLogin();
                }}
                className="flex w-full min-h-[50px] items-center justify-center gap-2 rounded-full bg-white py-3 text-[15px] font-bold text-black hover:bg-white/90 transition cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
              >
                <Mail className="h-4 w-4" aria-hidden="true" />
                <span>
                  {isZh
                    ? "邮箱登录 · 领 1,000 tUSDT"
                    : "Sign in with email · Get 1,000 tUSDT"}
                </span>
              </button>
            </div>
          )}
        </div>
      </div>
    </dialog>
  );
}

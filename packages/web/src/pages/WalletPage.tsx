import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AlertCircle,
  AlertTriangle,
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  Award,
  CheckCircle2,
  ChevronDown,
  Droplets,
  ExternalLink,
  Loader2,
  Lock,
  Mail,
  ShieldCheck,
} from "lucide-react";
import {
  ASSET_SPECS,
  BSC_TESTNET,
  computeRealizedHistoryEntry,
  computeRemainingStakeUsdt,
  type CloseRfqResponse,
  type PositionView,
  type UnderlyingSymbol,
} from "@payoff/shared";
import { api, type HealthResponse } from "../lib/api";
import { formatExpiryDateTime, formatStrikePrice } from "../lib/format";
import { getCopy, type Locale } from "../lib/i18n";
import {
  executeBatchRedeemTx,
  executeCloseTicketTx,
  executeRedeemTx,
  executeSettleWithAtlasTwapTx,
  extractWalletErrorMessage,
  getExplorerBaseUrl,
  type ConnectedWallet,
} from "../lib/wallet";
import {
  appendWalletTransfer,
  loadWalletTransfers,
  type WalletTransferRecord,
} from "../lib/walletActivity";
import {
  EarlyCloseModal,
  type CloseSlippagePauseState,
  type EarlyCloseStage,
} from "../components/EarlyCloseModal";
import { PayoffRangeRuler } from "../components/PayoffRangeRuler";
import { DepositModal, WithdrawModal } from "../components/WalletActionModals";

export interface WalletPageProps {
  locale: Locale;
  wallet: ConnectedWallet;
  health?: HealthResponse;
  positions: PositionView[];
  transferRevision?: number;
  onLogin: () => void;
  onGoToTrade: () => void;
  onRefresh: () => void;
  onOpenMint?: () => void;
  onWithdrawUsdt: (to: `0x${string}`, amountUsdt: number) => Promise<`0x${string}`>;
  onBatchClaim?: (seriesIds: `0x${string}`[]) => Promise<void>;
  onClaimPosition?: (position: PositionView) => Promise<void>;
  onManualSettle?: (
    underlying: UnderlyingSymbol,
    expiry: number
  ) => Promise<{
    status: "SETTLED" | "ALREADY_SETTLED";
    twapPriceUsd?: number;
  }>;
  onSelectPositionMarket?: (
    underlying: UnderlyingSymbol,
    expiry: number
  ) => void;
}

type WalletTabId = "active" | "history";
type HistoryFilter = "all" | "trades" | "transfers";

type PositionWithOptionalTx = PositionView & {
  closeTxHash?: string;
  redeemTxHash?: string;
};

const SLIPPAGE_TOLERANCE_RATIO = 0.985;

function positionKey(pos: PositionView): string {
  return `${pos.seriesId}:${pos.isUp ? "UP" : "DOWN"}:${pos.tokenId}`;
}

function formatSignedUsd(v: number): string {
  const sign = v >= 0 ? "+" : "−";
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

function formatShortDate(unixSec: number): string {
  if (!unixSec) return "--";
  const d = new Date(unixSec * 1000);
  if (Number.isNaN(d.getTime())) return "--";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}/${dd} ${hh}:${mi}`;
}

function formatCountdownShort(
  expirySec: number,
  nowSec: number,
  isZh: boolean
): string {
  const diff = expirySec - nowSec;
  if (diff <= 0) return isZh ? "已到期" : "Expired";
  const days = Math.floor(diff / 86400);
  const hours = Math.floor((diff % 86400) / 3600);
  const mins = Math.floor((diff % 3600) / 60);
  if (days >= 1) return `${days}d ${hours}h`;
  if (hours >= 1) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  return `${Math.max(1, mins)}m`;
}

export function WalletPage({
  locale,
  wallet,
  health,
  positions,
  transferRevision = 0,
  onLogin,
  onGoToTrade,
  onRefresh,
  onOpenMint,
  onWithdrawUsdt,
  onBatchClaim,
  onClaimPosition,
  onManualSettle,
  onSelectPositionMarket,
}: WalletPageProps) {
  const isZh = locale === "zh";
  const t = getCopy(locale);

  const activeTabId = useId();
  const historyTabId = useId();
  const activeTabBtnRef = useRef<HTMLButtonElement>(null);
  const historyTabBtnRef = useRef<HTMLButtonElement>(null);
  const activePanelRef = useRef<HTMLDivElement>(null);
  const historyPanelRef = useRef<HTMLDivElement>(null);

  const [selectedTab, setSelectedTab] = useState<WalletTabId>("active");
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>("all");
  const [expandedActiveKey, setExpandedActiveKey] = useState<string | null>(
    null
  );
  const [expandedHistoryKey, setExpandedHistoryKey] = useState<string | null>(
    null
  );
  const [nowSec, setNowSec] = useState<number>(() =>
    Math.floor(Date.now() / 1000)
  );

  useEffect(() => {
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(id);
  }, []);

  const [depositOpen, setDepositOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);

  const [transfers, setTransfers] = useState<WalletTransferRecord[]>([]);

  const [closingPos, setClosingPos] = useState<PositionView | null>(null);
  const [closeStage, setCloseStage] = useState<EarlyCloseStage>("IDLE");
  const [closeSlippagePause, setCloseSlippagePause] = useState<
    CloseSlippagePauseState | undefined
  >();
  const [closeErr, setCloseErr] = useState<string | undefined>();
  const [redeemingSeriesId, setRedeemingSeriesId] = useState<string | null>(
    null
  );
  const [batchClaiming, setBatchClaiming] = useState(false);
  const [settlingKey, setSettlingKey] = useState<string | null>(null);
  const [toastMsg, setToastMsg] = useState<string | undefined>();
  const [actionErr, setActionErr] = useState<string | undefined>();

  useEffect(() => {
    setTransfers(loadWalletTransfers(wallet.address));
  }, [wallet.address, transferRevision]);

  // Apply hidden="until-found" on inactive tab panel and sync via beforematch for Find-in-Page
  const hasConnectedWallet = wallet.kind !== "NONE" && Boolean(wallet.address);

  useLayoutEffect(() => {
    const activePanel = activePanelRef.current;
    const historyPanel = historyPanelRef.current;
    if (activePanel) {
      if (selectedTab === "active") {
        activePanel.removeAttribute("hidden");
      } else {
        activePanel.setAttribute("hidden", "until-found");
      }
    }
    if (historyPanel) {
      if (selectedTab === "history") {
        historyPanel.removeAttribute("hidden");
      } else {
        historyPanel.setAttribute("hidden", "until-found");
      }
    }
  }, [selectedTab, hasConnectedWallet]);

  useEffect(() => {
    const activePanel = activePanelRef.current;
    const historyPanel = historyPanelRef.current;
    const onMatchActive = () => setSelectedTab("active");
    const onMatchHistory = () => setSelectedTab("history");
    activePanel?.addEventListener("beforematch", onMatchActive);
    historyPanel?.addEventListener("beforematch", onMatchHistory);
    return () => {
      activePanel?.removeEventListener("beforematch", onMatchActive);
      historyPanel?.removeEventListener("beforematch", onMatchHistory);
    };
  }, [hasConnectedWallet]);

  const explorerBase = getExplorerBaseUrl(
    health?.chainId ?? wallet.chainId ?? BSC_TESTNET.chainId
  );

  // Keep EarlyCloseModal live-synced as WS ticks update positions
  const activeClosingPos = closingPos
    ? positions.find((p) => positionKey(p) === positionKey(closingPos)) ??
      closingPos
    : null;

  const {
    activePositions,
    claimablePositions,
    claimableSeriesIds,
    claimableTotalUsdt,
    claimableNetPnl,
    claimableIsPartial,
    activePositionsValue,
    activeUnrealizedPnl,
    activeTotalStake,
    historyTrades,
    cumulativeNetPnl,
    cumulativeRoiPct,
    totalCompletedTrades,
    directionRightCount,
    partialRefundCount,
  } = useMemo(() => {
    const claimable = positions
      .filter((p) => p.status === "SETTLED_CLAIMABLE" && p.claimableUsdt > 0)
      .sort((a, b) => a.expiry - b.expiry);
    const active = positions
      .filter((p) => p.status === "ACTIVE")
      .sort((a, b) => a.expiry - b.expiry);

    const uniqueClaimableIds = Array.from(
      new Set(claimable.map((p) => p.seriesId))
    ) as `0x${string}`[];
    const claimableSum = claimable.reduce((s, p) => s + p.claimableUsdt, 0);
    const claimableStakeSum = claimable.reduce(
      (s, p) => s + computeRemainingStakeUsdt(p),
      0
    );

    const activeVal = active.reduce((s, p) => s + p.indicativeExitUsdt, 0);
    const activeStake =
      active.reduce((s, p) => s + computeRemainingStakeUsdt(p), 0) +
      claimableStakeSum;
    const unrealizedPnl =
      active.reduce((s, p) => s + p.unrealizedPnlUsdt, 0) +
      claimable.reduce(
        (s, p) => s + (p.claimableUsdt - computeRemainingStakeUsdt(p)),
        0
      );

    const finished = positions
      .flatMap((p) => {
        const metrics = computeRealizedHistoryEntry(p);
        if (!metrics) return [];
        const posExt = p as PositionWithOptionalTx;
        const timestampSec = metrics.isClosedEarly
          ? p.updatedAt || p.createdAt
          : p.expiry || p.updatedAt || p.createdAt;
        return [
          {
            pos: posExt,
            timestampSec,
            realizedStakeUsdt: metrics.realizedStakeUsdt,
            totalPayout: metrics.totalPayoutUsdt,
            netPnl: metrics.netPnlUsdt,
            mult: metrics.mult,
            soldSharePct: metrics.soldSharePct,
            isPartialActiveClose: metrics.isPartialActiveClose,
            isClosedEarly: metrics.isClosedEarly,
            isDirectionRight: metrics.isDirectionRight,
            isPartialRefund: metrics.isPartialRefund,
            isBufferNotZero: metrics.isBufferNotZero,
          },
        ];
      })
      .sort((a, b) => b.timestampSec - a.timestampSec);

    const cumPnl = finished.reduce((s, x) => s + x.netPnl, 0);
    const cumCost = finished.reduce((s, x) => s + x.realizedStakeUsdt, 0);
    const cumRoi = cumCost > 0 ? (cumPnl / cumCost) * 100 : 0;

    return {
      activePositions: active,
      claimablePositions: claimable,
      claimableSeriesIds: uniqueClaimableIds,
      claimableTotalUsdt: claimableSum,
      claimableNetPnl: claimableSum - claimableStakeSum,
      claimableIsPartial: claimableSum > 0 && claimableSum < claimableStakeSum,
      activePositionsValue: activeVal,
      activeUnrealizedPnl: unrealizedPnl,
      activeTotalStake: activeStake,
      historyTrades: finished,
      cumulativeNetPnl: cumPnl,
      cumulativeRoiPct: cumRoi,
      totalCompletedTrades: finished.length,
      directionRightCount: finished.filter((x) => x.isDirectionRight).length,
      partialRefundCount: finished.filter((x) => x.isPartialRefund).length,
    };
  }, [positions]);

  const combinedHistory = useMemo(() => {
    type TimelineItem =
      | { kind: "TRADE"; timestampSec: number; trade: (typeof historyTrades)[number] }
      | { kind: "TRANSFER"; timestampSec: number; transfer: WalletTransferRecord };

    const items: TimelineItem[] = [];
    if (historyFilter === "all" || historyFilter === "trades") {
      for (const trade of historyTrades) {
        items.push({ kind: "TRADE", timestampSec: trade.timestampSec, trade });
      }
    }
    if (historyFilter === "all" || historyFilter === "transfers") {
      for (const transfer of transfers) {
        items.push({
          kind: "TRANSFER",
          timestampSec: transfer.timestampSec,
          transfer,
        });
      }
    }
    return items.sort((a, b) => b.timestampSec - a.timestampSec);
  }, [historyTrades, transfers, historyFilter]);

  const formatPositionError = (err: any, fallback: string): string => {
    const errName = String(
      err?.cause?.data?.errorName || err?.data?.errorName || ""
    );
    const extracted = extractWalletErrorMessage(err, fallback);
    const full = `${errName} ${extracted} ${err?.shortMessage || ""} ${err?.message || ""}`;
    if (
      full.includes("自成交") ||
      full.includes("SelfTradeNotAllowed") ||
      full.toLowerCase().includes("self-trade") ||
      full.includes("taker 与 maker")
    ) {
      return t.selfTradeError;
    }
    if (full.includes("QuoteExpired") || full.includes("0x8727a7f9")) {
      return t.quoteExpiredError;
    }
    return extracted;
  };

  const handleWithdrawFromModal = async (
    to: `0x${string}`,
    amountUsdt: number
  ) => {
    const hash = await onWithdrawUsdt(to, amountUsdt);
    const next = appendWalletTransfer(wallet.address, {
      kind: "WITHDRAW",
      amountUsdt,
      toAddress: to,
      txHash: hash,
      chainId: wallet.chainId || BSC_TESTNET.chainId,
    });
    setTransfers(next);
    return hash;
  };

  const handleOpenEarlyClose = (pos: PositionView) => {
    setClosingPos(pos);
    setCloseStage("IDLE");
    setCloseSlippagePause(undefined);
    setCloseErr(undefined);
  };

  const fillCloseRfqOnChain = async (rfq: CloseRfqResponse) => {
    if (rfq.quote.validUntil <= Math.floor(Date.now() / 1000)) {
      throw new Error("QuoteExpired");
    }
    setCloseStage("EXECUTING");
    setCloseErr(undefined);
    setActionErr(undefined);
    const hash = await executeCloseTicketTx({
      wallet,
      rpcUrl: health?.rpcUrl || BSC_TESTNET.rpcUrl,
      rfq,
    });
    await api.ingestTx(hash).catch(() => api.syncChain());
    setClosingPos(null);
    setCloseSlippagePause(undefined);
    setCloseStage("IDLE");
    setToastMsg(
      isZh
        ? `已提前卖出落袋 $${rfq.netProceedsUsdt.toFixed(2)}`
        : `Sold early for $${rfq.netProceedsUsdt.toFixed(2)}`
    );
    onRefresh();
  };

  const handleInstantSell = async (pos: PositionView, ratio: number) => {
    if (!wallet.address) return;
    setCloseStage("QUOTING");
    setCloseErr(undefined);
    setCloseSlippagePause(undefined);

    const estimatedUsdt = pos.indicativeExitUsdt * ratio;
    const closeAmountUsdt =
      ratio >= 0.995 ? undefined : pos.remainingBalanceUsdt * ratio;

    try {
      const rfq = await api.requestCloseRfq({
        taker: wallet.address,
        seriesId: pos.seriesId,
        isUp: pos.isUp,
        closeAmountUsdt,
      });

      if (
        estimatedUsdt > 0 &&
        rfq.netProceedsUsdt < estimatedUsdt * SLIPPAGE_TOLERANCE_RATIO
      ) {
        const dropPct =
          ((estimatedUsdt - rfq.netProceedsUsdt) / estimatedUsdt) * 100;
        setCloseSlippagePause({
          rfq,
          estimatedUsdt,
          firmUsdt: rfq.netProceedsUsdt,
          dropPct,
        });
        setCloseStage("SLIPPAGE_CONFIRM");
        return;
      }

      await fillCloseRfqOnChain(rfq);
    } catch (err: any) {
      setCloseStage("IDLE");
      setCloseErr(formatPositionError(err, "Close failed"));
    }
  };

  const handleConfirmSlippageClose = async () => {
    if (!closeSlippagePause) return;
    try {
      await fillCloseRfqOnChain(closeSlippagePause.rfq);
    } catch (err: any) {
      setCloseStage("SLIPPAGE_CONFIRM");
      setCloseErr(formatPositionError(err, "Close failed"));
    }
  };

  const handleBatchClaimAll = async () => {
    if (batchClaiming || claimableSeriesIds.length === 0) return;
    setBatchClaiming(true);
    setToastMsg(undefined);
    setActionErr(undefined);
    try {
      if (onBatchClaim) {
        await onBatchClaim(claimableSeriesIds);
      } else {
        if (!health?.vaultAddress) {
          throw new Error("Vault contract address unavailable");
        }
        const hash = await executeBatchRedeemTx({
          wallet,
          rpcUrl: health.rpcUrl,
          vaultAddress: health.vaultAddress,
          seriesIds: claimableSeriesIds,
        });
        await api.ingestTx(hash).catch(() => api.syncChain());
        onRefresh();
      }
      setToastMsg(t.outcomeClaimedSuccess(claimableTotalUsdt.toFixed(2)));
    } catch (err: any) {
      setActionErr(formatPositionError(err, "Batch claim failed"));
    } finally {
      setBatchClaiming(false);
    }
  };

  const handleRedeem = async (pos: PositionView) => {
    const sidLower = pos.seriesId.toLowerCase();
    setRedeemingSeriesId(sidLower);
    setToastMsg(undefined);
    setActionErr(undefined);
    try {
      if (onClaimPosition) {
        await onClaimPosition(pos);
      } else {
        if (!health?.vaultAddress) return;
        const hash = await executeRedeemTx({
          wallet,
          rpcUrl: health.rpcUrl,
          vaultAddress: health.vaultAddress,
          seriesId: pos.seriesId,
        });
        await api.ingestTx(hash).catch(() => api.syncChain());
        onRefresh();
      }
      setToastMsg(t.outcomeClaimedSuccess(pos.claimableUsdt.toFixed(2)));
    } catch (err: any) {
      setActionErr(formatPositionError(err, "Claim failed"));
    } finally {
      setRedeemingSeriesId(null);
    }
  };

  const handlePermissionlessSettle = async (pos: PositionView) => {
    const settleId = `${pos.underlying}:${pos.expiry}`;
    setSettlingKey(settleId);
    setToastMsg(undefined);
    setActionErr(undefined);
    try {
      if (onManualSettle) {
        const res = await onManualSettle(pos.underlying, pos.expiry);
        if (res.status === "ALREADY_SETTLED") {
          setToastMsg(t.settleAlreadyDone);
        } else {
          setToastMsg(
            t.settleTwapSuccess(
              ASSET_SPECS[pos.underlying].displaySymbol,
              res.twapPriceUsd
                ? formatStrikePrice(res.twapPriceUsd, pos.underlying)
                : "--"
            )
          );
        }
        return;
      }

      const bundle = await api.getSettlementProof(pos.underlying, pos.expiry);
      if (bundle.status === "ALREADY_SETTLED") {
        setToastMsg(t.settleAlreadyDone);
        onRefresh();
        return;
      }
      if (bundle.status === "DISPUTED_PAUSED") {
        setActionErr(t.disputedExpiryNotice);
        onRefresh();
        return;
      }
      if (bundle.status === "WAITING_DELAY") {
        setActionErr(t.settleWaitingDelay);
        return;
      }
      if (!bundle.proofs || bundle.proofs.length === 0) {
        throw new Error("Missing signed Atlas TWAP proofs");
      }
      const hash = await executeSettleWithAtlasTwapTx({
        wallet,
        rpcUrl: health?.rpcUrl || BSC_TESTNET.rpcUrl,
        oracleAddress: bundle.oracleAddress,
        assetId: bundle.assetId,
        expiry: bundle.expiry,
        proofs: bundle.proofs,
      });
      await api.ingestTx(hash).catch(() => api.syncChain());
      setToastMsg(
        t.settleTwapSuccess(
          ASSET_SPECS[pos.underlying].displaySymbol,
          bundle.twapPriceUsd
            ? formatStrikePrice(bundle.twapPriceUsd, pos.underlying)
            : "--"
        )
      );
      onRefresh();
    } catch (err: any) {
      const rawMsg = String(err?.shortMessage || err?.message || "");
      if (rawMsg.includes("AlreadySettled")) {
        setToastMsg(t.settleAlreadyDone);
        onRefresh();
      } else {
        setActionErr(formatPositionError(err, "Settlement failed"));
      }
    } finally {
      setSettlingKey(null);
    }
  };

  const handleTabKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (
      e.key !== "ArrowRight" &&
      e.key !== "ArrowLeft" &&
      e.key !== "Home" &&
      e.key !== "End"
    ) {
      return;
    }
    e.preventDefault();
    const next: WalletTabId =
      e.key === "Home"
        ? "active"
        : e.key === "End"
          ? "history"
          : selectedTab === "active"
            ? "history"
            : "active";
    setSelectedTab(next);
    (next === "active" ? activeTabBtnRef : historyTabBtnRef).current?.focus();
  };

  // Disconnected Sign-In State
  if (wallet.kind === "NONE" || !wallet.address) {
    return (
      <main className="mx-auto max-w-[860px] bg-black px-4 pt-12 pb-20 sm:px-6">
        <div className="mx-auto max-w-md rounded-3xl bg-[#121417] border border-[#1d2025] p-7 sm:p-8 text-center space-y-5">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[#24282f] text-white">
            <Mail className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="space-y-1.5">
            <h1 className="text-xl font-bold tracking-[-0.02em] text-white">
              {isZh ? "登录查看你的资产" : "Sign in to view your Portfolio"}
            </h1>
            <p className="text-xs leading-relaxed text-[#7e8690]">
              {isZh
                ? "邮箱一键登录，自动生成链上钱包并赠送 1,000 测试 tUSDT，随时可充值、提币、查看持仓与战绩。"
                : "Sign in with email for an instant BNB Chain wallet with 1,000 free tUSDT — deposit, withdraw, track positions, and review history."}
            </p>
          </div>
          <div className="rounded-2xl bg-[#2EC26B]/12 px-4 py-3 text-xs leading-relaxed text-[#cbead7]">
            {isZh ? (
              <>
                支持<strong className="text-white">链上提币</strong>与
                <strong className="text-white">随时导出私钥</strong>，Payoff 不托管您的资产。
              </>
            ) : (
              <>
                Non-custodial wallet with{" "}
                <strong className="text-white">on-chain transfers</strong> and{" "}
                <strong className="text-white">private key export</strong> anytime.
              </>
            )}
          </div>
          <button
            type="button"
            onClick={onLogin}
            className="flex w-full min-h-[48px] items-center justify-center gap-2 rounded-full bg-white py-3 text-sm font-bold text-black hover:bg-white/90 transition cursor-pointer"
          >
            <Mail className="h-4 w-4" aria-hidden="true" />
            <span>
              {isZh
                ? "邮箱登录 · 领 1,000 tUSDT"
                : "Sign in with email · Get 1,000 tUSDT"}
            </span>
          </button>
        </div>
      </main>
    );
  }

  const totalPositionsEquity = activePositionsValue + claimableTotalUsdt;
  const totalBalance = wallet.usdtBalance + totalPositionsEquity;
  const activeAndClaimableCount =
    activePositions.length + claimablePositions.length;
  const historyTotalCount = historyTrades.length + transfers.length;

  const availableSharePct =
    totalBalance > 0 ? (wallet.usdtBalance / totalBalance) * 100 : 0;
  const activePosSharePct =
    totalBalance > 0 ? (activePositionsValue / totalBalance) * 100 : 0;
  const claimableSharePct =
    totalBalance > 0 ? (claimableTotalUsdt / totalBalance) * 100 : 0;

  return (
    <main className="mx-auto max-w-[860px] bg-black px-4 pt-6 pb-20 sm:px-6">
      <div className="min-w-0 space-y-6">
        {/* Balance Hero + Inline Allocation Strip (Option A) */}
        <section className="space-y-5 border-b border-[#1d2025] pb-6">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="min-w-0">
              <div className="text-xs font-medium text-[#7e8690]">
                {isZh ? "总资产" : "Total balance"}
              </div>
              <h1 className="mt-1.5 text-[38px] sm:text-[42px] font-bold leading-none tracking-[-0.03em] text-white tabular-nums">
                $
                {totalBalance.toLocaleString("en-US", {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </h1>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs font-medium tabular-nums text-[#7e8690]">
                {activeTotalStake > 0 || totalCompletedTrades > 0 ? (
                  <>
                    {activeTotalStake > 0 && (
                      <span>
                        {isZh ? "持仓 " : "Open "}
                        <strong
                          className={`font-semibold ${
                            activeUnrealizedPnl >= 0
                              ? "text-[#2EC26B]"
                              : "text-[#E85D4A]"
                          }`}
                        >
                          {formatSignedUsd(activeUnrealizedPnl)}
                        </strong>
                      </span>
                    )}
                    {activeTotalStake > 0 && totalCompletedTrades > 0 && (
                      <span className="text-[#3a3f47]">·</span>
                    )}
                    {totalCompletedTrades > 0 && (
                      <span>
                        {isZh ? "已落袋 " : "Realized "}
                        <strong
                          className={`font-semibold ${
                            cumulativeNetPnl >= 0
                              ? "text-[#2EC26B]"
                              : "text-[#E85D4A]"
                          }`}
                        >
                          {formatSignedUsd(cumulativeNetPnl)}
                        </strong>
                      </span>
                    )}
                  </>
                ) : (
                  <span className="inline-flex items-center gap-1.5 font-medium text-[#7e8690]">
                    <span
                      className="h-1.5 w-1.5 rounded-full bg-[#2EC26B]"
                      aria-hidden="true"
                    />
                    <span>BNB Smart Chain Testnet</span>
                  </span>
                )}
              </div>
            </div>

            {/* Primary Wallet Actions: Deposit & Withdraw */}
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setDepositOpen(true)}
                className="inline-flex min-h-[40px] [@media(pointer:coarse)]:min-h-[44px] items-center gap-1.5 rounded-full bg-white px-5 py-2 text-xs font-bold text-black hover:bg-white/90 transition cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
              >
                <ArrowDownLeft className="h-3.5 w-3.5" aria-hidden="true" />
                <span>{isZh ? "充值" : "Deposit"}</span>
              </button>

              <button
                type="button"
                onClick={() => setWithdrawOpen(true)}
                className="inline-flex min-h-[40px] [@media(pointer:coarse)]:min-h-[44px] items-center gap-1.5 rounded-full bg-[#24282f] px-5 py-2 text-xs font-bold text-white hover:bg-[#2f343d] transition cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
              >
                <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                <span>{isZh ? "提币" : "Withdraw"}</span>
              </button>

              {onOpenMint && (
                <button
                  type="button"
                  onClick={onOpenMint}
                  className="inline-flex sm:hidden min-h-[40px] [@media(pointer:coarse)]:min-h-[44px] items-center gap-1.5 rounded-full bg-[#15171b] border border-[#262a31] px-4 py-2 text-xs font-semibold text-[#d0d6de] hover:bg-[#24282f] hover:text-white transition cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
                >
                  <Droplets className="h-3.5 w-3.5 text-[#9aa2ad]" aria-hidden="true" />
                  <span>{isZh ? "领水" : "Mint"}</span>
                </button>
              )}
            </div>
          </div>

          {/* Inline Balance Allocation Bar + Semantic Breakdown */}
          <div className="space-y-2.5">
            <div
              aria-hidden="true"
              className="flex h-1 w-full gap-[2px] overflow-hidden rounded-full bg-[#1a1e24]"
            >
              {wallet.usdtBalance > 0 && (
                <div
                  className="h-full min-w-[4px] bg-[#f6f7f5] transition-[width] duration-300"
                  style={{ width: `${availableSharePct.toFixed(2)}%` }}
                />
              )}
              {activePositionsValue > 0 && (
                <div
                  className="h-full min-w-[4px] bg-[#6b7280] transition-[width] duration-300"
                  style={{ width: `${activePosSharePct.toFixed(2)}%` }}
                />
              )}
              {claimableTotalUsdt > 0 && (
                <div
                  className="h-full min-w-[4px] bg-[#2EC26B] transition-[width] duration-300"
                  style={{ width: `${claimableSharePct.toFixed(2)}%` }}
                />
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
              <dl className="flex flex-wrap items-center gap-x-6 gap-y-1.5 text-xs tabular-nums">
                <div className="inline-flex items-center gap-1.5">
                  <span
                    className="h-1.5 w-1.5 rounded-full bg-[#f6f7f5] shrink-0"
                    aria-hidden="true"
                  />
                  <dt className="font-medium text-[#7e8690]">
                    {isZh ? "可用余额" : "Available"}
                  </dt>
                  <dd className="font-semibold text-white">
                    $
                    {wallet.usdtBalance.toLocaleString("en-US", {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </dd>
                </div>

                <div className="inline-flex items-center gap-1.5">
                  <span
                    className="h-1.5 w-1.5 rounded-full bg-[#6b7280] shrink-0"
                    aria-hidden="true"
                  />
                  <dt className="font-medium text-[#7e8690]">
                    {isZh ? "持仓" : "Positions"}
                  </dt>
                  <dd className="font-semibold text-white">
                    $
                    {activePositionsValue.toLocaleString("en-US", {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </dd>
                </div>

                {claimableTotalUsdt > 0 && (
                  <div className="inline-flex items-center gap-1.5">
                    <span
                      className="h-1.5 w-1.5 rounded-full bg-[#2EC26B] shrink-0"
                      aria-hidden="true"
                    />
                    <dt className="font-medium text-[#7e8690]">
                      {isZh ? "待领取" : "Claimable"}
                    </dt>
                    <dd className="font-semibold text-[#2EC26B]">
                      $
                      {claimableTotalUsdt.toLocaleString("en-US", {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                    </dd>
                  </div>
                )}
              </dl>

              {claimablePositions.length > 0 && selectedTab === "history" && (
                <button
                  type="button"
                  onClick={() => setSelectedTab("active")}
                  className="inline-flex items-center gap-1 rounded-full bg-[#2EC26B]/14 px-3 py-1 text-xs font-semibold text-[#2EC26B] hover:bg-[#2EC26B]/22 transition cursor-pointer tabular-nums focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
                >
                  <span>
                    {isZh
                      ? `去领取 $${claimableTotalUsdt.toFixed(2)}`
                      : `Claim $${claimableTotalUsdt.toFixed(2)}`}
                  </span>
                  <ArrowRight className="h-3 w-3" aria-hidden="true" />
                </button>
              )}
            </div>
          </div>
        </section>

          {toastMsg && (
            <div
              role="status"
              aria-live="polite"
              className="flex items-center justify-between gap-2 rounded-2xl border border-[#2EC26B]/25 bg-[#121417] px-4 py-3 text-xs font-semibold text-[#2EC26B]"
            >
              <span className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>{toastMsg}</span>
              </span>
            </div>
          )}

          {actionErr && (
            <div
              role="alert"
              className="flex items-center gap-2 rounded-2xl border border-[#E85D4A]/30 bg-[#121417] px-4 py-3 text-xs font-semibold text-[#E85D4A]"
            >
              <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{actionErr}</span>
            </div>
          )}

          {/* Wallet Tabs: Active & Claim | History & Stats */}
          <div>
            <div
              role="tablist"
              {...({ focusgroup: "tablist nomemory" } as Record<string, unknown>)}
              aria-label={isZh ? "资产视图" : "Portfolio views"}
              onKeyDown={handleTabKeyDown}
              className="flex items-center gap-6 border-b border-[#1d2025]"
            >
              <button
                ref={activeTabBtnRef}
                id={activeTabId}
                type="button"
                role="tab"
                aria-selected={selectedTab === "active"}
                tabIndex={selectedTab === "active" ? 0 : -1}
                {...(selectedTab === "active"
                  ? ({ focusgroupstart: "" } as Record<string, unknown>)
                  : {})}
                onClick={() => setSelectedTab("active")}
                className={`payoff-tab-btn inline-flex items-center gap-2 pb-3 text-sm font-semibold transition cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white ${
                  selectedTab === "active"
                    ? "text-white"
                    : "text-[#7e8690] hover:text-[#d0d6de]"
                }`}
              >
                <span>{isZh ? "持仓" : "Active"}</span>
                {activeAndClaimableCount > 0 && (
                  <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-[#1a1e24] px-1.5 text-[11px] font-semibold text-[#d0d6de] tabular-nums">
                    {activeAndClaimableCount}
                  </span>
                )}
              </button>

              <button
                ref={historyTabBtnRef}
                id={historyTabId}
                type="button"
                role="tab"
                aria-selected={selectedTab === "history"}
                tabIndex={selectedTab === "history" ? 0 : -1}
                {...(selectedTab === "history"
                  ? ({ focusgroupstart: "" } as Record<string, unknown>)
                  : {})}
                onClick={() => setSelectedTab("history")}
                className={`payoff-tab-btn inline-flex items-center gap-2 pb-3 text-sm font-semibold transition cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white ${
                  selectedTab === "history"
                    ? "text-white"
                    : "text-[#7e8690] hover:text-[#d0d6de]"
                }`}
              >
                <span>{isZh ? "历史" : "History"}</span>
                {historyTotalCount > 0 && (
                  <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-[#1a1e24] px-1.5 text-[11px] font-semibold text-[#d0d6de] tabular-nums">
                    {historyTotalCount}
                  </span>
                )}
              </button>
            </div>

            {/* Sequential block flow: hidden="until-found" collapses to 0px height and never overlays sibling panels */}
            <div>
              {/* TAB PANEL 1: Active & Claimable Positions */}
              <div
                ref={activePanelRef}
                role="tabpanel"
                aria-labelledby={activeTabId}
              >
                <div className="pt-5 space-y-5">
                  {/* Batch Claim Banner */}
                  {claimablePositions.length > 0 && (
                    <section className="rounded-2xl bg-[#121417] border border-[#2EC26B]/25 p-5">
                      <div className="flex flex-wrap items-center justify-between gap-4">
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <span
                              className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold ${
                                claimableIsPartial
                                  ? "bg-[#E6BA5C]/18 text-[#E6BA5C]"
                                  : "bg-[#2EC26B]/15 text-[#2EC26B]"
                              }`}
                            >
                              {claimableIsPartial
                                ? t.outcomePartialBadge
                                : t.outcomeWinBadge}
                            </span>
                            <span className="text-xs text-[#7e8690]">
                              {t.outcomeTotalClaimable}
                            </span>
                          </div>
                          <div className="flex items-baseline gap-2 tabular-nums">
                            <span
                              className={`text-2xl font-bold ${
                                claimableIsPartial
                                  ? "text-[#E6BA5C]"
                                  : "text-[#2EC26B]"
                              }`}
                            >
                              ${claimableTotalUsdt.toFixed(2)}
                            </span>
                            <span
                              className={`text-xs font-semibold ${
                                claimableNetPnl >= 0
                                  ? "text-[#2EC26B]"
                                  : "text-[#E85D4A]"
                              }`}
                            >
                              ({formatSignedUsd(claimableNetPnl)})
                            </span>
                          </div>
                        </div>

                        <button
                          type="button"
                          disabled={batchClaiming}
                          onClick={() => void handleBatchClaimAll()}
                          className="inline-flex min-h-[42px] items-center justify-center gap-2 rounded-full bg-white px-5 py-2 text-xs font-bold text-black hover:bg-white/90 disabled:opacity-50 transition cursor-pointer tabular-nums"
                        >
                          {batchClaiming ? (
                            <Loader2
                              className="h-3.5 w-3.5 animate-spin"
                              aria-hidden="true"
                            />
                          ) : (
                            <Award className="h-3.5 w-3.5" aria-hidden="true" />
                          )}
                          <span>
                            {batchClaiming
                              ? t.outcomeClaiming
                              : t.outcomeBatchClaimCta(
                                  claimableTotalUsdt.toFixed(2),
                                  claimablePositions.length
                                )}
                          </span>
                        </button>
                      </div>
                    </section>
                  )}

                  {/* Active + Claimable List */}
                  {activeAndClaimableCount === 0 ? (
                    <div className="rounded-2xl bg-[#121417] border border-[#1d2025] px-6 py-12 text-center space-y-3.5">
                      <div className="text-sm font-bold text-white">
                        {t.noPositions}
                      </div>
                      <p className="mx-auto max-w-sm text-xs leading-relaxed text-[#7e8690]">
                        {t.noPositionsDesc}
                      </p>
                      <button
                        type="button"
                        onClick={onGoToTrade}
                        className="inline-flex items-center gap-1.5 rounded-full bg-white px-5 py-2.5 text-xs font-bold text-black hover:bg-white/90 transition cursor-pointer"
                      >
                        <span>{t.goTrade}</span>
                        <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    </div>
                  ) : (
                    <ul
                      role="list"
                      className="divide-y divide-[#1d2025] border-b border-[#1d2025]"
                    >
                      {[...claimablePositions, ...activePositions].map((pos) => {
                        const key = positionKey(pos);
                        const isExpanded = expandedActiveKey === key;
                        const spec = ASSET_SPECS[pos.underlying];
                        const isBull = pos.isUp;
                        const remainingStake = computeRemainingStakeUsdt(pos);
                        const isPartialOutcome =
                          pos.status === "SETTLED_CLAIMABLE" &&
                          pos.claimableUsdt > 0 &&
                          pos.claimableUsdt < remainingStake;
                        const hasPartialSold =
                          pos.earlyCloseProceedsUsdt > 0.005 ||
                          pos.closedBalanceUsdt > 0.005;
                        const maxTotal = Math.max(
                          pos.initialMaxPayoutUsdt,
                          pos.remainingBalanceUsdt + pos.closedBalanceUsdt
                        );
                        const leftPct =
                          hasPartialSold && maxTotal > 0
                            ? Math.max(
                                1,
                                Math.min(
                                  99,
                                  Math.round(
                                    (pos.remainingBalanceUsdt / maxTotal) * 100
                                  )
                                )
                              )
                            : 100;
                        const soldPct = Math.max(0, 100 - leftPct);
                        const soldCost = Math.max(
                          0,
                          pos.totalStakeUsdt - remainingStake
                        );
                        const soldPnl = pos.earlyCloseProceedsUsdt - soldCost;
                        const combinedPnl =
                          pos.earlyCloseProceedsUsdt +
                          (pos.status === "SETTLED_CLAIMABLE"
                            ? pos.claimableUsdt
                            : pos.indicativeExitUsdt) -
                          pos.totalStakeUsdt;
                        const combinedPct =
                          pos.totalStakeUsdt > 0
                            ? (combinedPnl / pos.totalStakeUsdt) * 100
                            : 0;

                        const statusPill =
                          pos.status === "ACTIVE" && pos.awaitingSettlement
                            ? pos.expiryPaused
                              ? {
                                  label: t.statusDisputed,
                                  cls: "bg-[#E85D4A]/15 text-[#E85D4A]",
                                }
                              : {
                                  label: t.statusAwaitingSettle,
                                  cls: "bg-[#E6BA5C]/15 text-[#E6BA5C]",
                                }
                            : pos.status === "ACTIVE" && pos.inTwapWindow
                              ? {
                                  label: t.statusTwapWindow,
                                  cls: "bg-[#E6BA5C]/15 text-[#E6BA5C]",
                                }
                              : pos.status === "ACTIVE"
                                ? null
                                : isPartialOutcome
                                  ? {
                                      label: t.outcomePartialBadge,
                                      cls: "bg-[#E6BA5C]/18 text-[#E6BA5C]",
                                    }
                                  : {
                                      label: t.statusClaimable,
                                      cls: "bg-[#2EC26B]/15 text-[#2EC26B]",
                                    };

                        const claimPnl = pos.claimableUsdt - remainingStake;
                        const countdownStr = formatCountdownShort(
                          pos.expiry,
                          nowSec,
                          isZh
                        );

                        // Placement 1: ultra-clean collapsed subtext with explicit partial-payout cue
                        const flatIsPartial =
                          pos.flatPayoutUsdt > 0.005 &&
                          remainingStake > 0 &&
                          pos.flatPayoutUsdt < remainingStake - 0.005;
                        const flatIsProfit =
                          pos.flatPayoutUsdt > 0.005 && !flatIsPartial;
                        const atSpotLabel =
                          pos.flatPayoutUsdt <= 0.005
                            ? isZh
                              ? "现价到期 $0"
                              : "At spot $0"
                            : flatIsPartial
                              ? isZh
                                ? `部分赔付 $${pos.flatPayoutUsdt.toFixed(2)}`
                                : `Partial $${pos.flatPayoutUsdt.toFixed(2)}`
                              : isZh
                                ? `现价到期 $${pos.flatPayoutUsdt.toFixed(2)}`
                                : `At spot $${pos.flatPayoutUsdt.toFixed(2)}`;
                        const atSpotColor = flatIsPartial
                          ? "#E6BA5C"
                          : flatIsProfit
                            ? "#2EC26B"
                            : "#7e8690";

                        return (
                          <li key={key} className="py-3">
                            <button
                              type="button"
                              aria-expanded={isExpanded}
                              onClick={() =>
                                setExpandedActiveKey(isExpanded ? null : key)
                              }
                              className="flex w-full items-center justify-between gap-3 rounded-xl px-2 py-1 -mx-2 text-left hover:bg-[#101216] transition-colors duration-150 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
                            >
                              {/* Left: Minimal 2-line scan (Title + Range; At-spot payout + Countdown) */}
                              <div className="min-w-0 flex-1 space-y-0.5">
                                <div className="flex flex-wrap items-center gap-1.5 tabular-nums">
                                  <span
                                    className={`h-1.5 w-1.5 rounded-full shrink-0 ${
                                      isBull ? "bg-[#2EC26B]" : "bg-[#E85D4A]"
                                    }`}
                                    aria-hidden="true"
                                  />
                                  <span className="text-[14px] font-bold text-white">
                                    {spec.displaySymbol}{" "}
                                    <span
                                      className={
                                        isBull
                                          ? "text-[#2EC26B]"
                                          : "text-[#E85D4A]"
                                      }
                                    >
                                      {isBull ? t.bull : t.bear}
                                    </span>
                                  </span>
                                  <span className="text-xs font-medium text-[#b8bec6]">
                                    {formatStrikePrice(
                                      pos.startPrice,
                                      pos.underlying
                                    )}{" "}
                                    →{" "}
                                    {formatStrikePrice(
                                      pos.capPrice,
                                      pos.underlying
                                    )}
                                  </span>
                                  {hasPartialSold && (
                                    <span className="text-xs font-medium text-[#7e8690]">
                                      ·{" "}
                                      {isZh
                                        ? `剩 ${leftPct}%`
                                        : `${leftPct}% left`}
                                    </span>
                                  )}
                                  {statusPill && (
                                    <span
                                      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${statusPill.cls}`}
                                    >
                                      {statusPill.label}
                                    </span>
                                  )}
                                </div>

                                <div className="text-xs text-[#7e8690] tabular-nums">
                                  {pos.status === "SETTLED_CLAIMABLE" ? (
                                    <span
                                      className={
                                        isPartialOutcome
                                          ? "text-[#E6BA5C]"
                                          : "text-[#2EC26B]"
                                      }
                                    >
                                      {isPartialOutcome
                                        ? isZh
                                          ? "部分赔付 · 可领取"
                                          : "Partial refund · Ready to claim"
                                        : isZh
                                          ? "已结算 · 可领取"
                                          : "Settled · Ready to claim"}
                                    </span>
                                  ) : pos.awaitingSettlement ? (
                                    <span className="text-[#E6BA5C]">
                                      {pos.expiryPaused
                                        ? t.disputedShortLabel
                                        : t.awaitingTwapShortLabel}
                                    </span>
                                  ) : pos.inTwapWindow ? (
                                    <span className="text-[#E6BA5C]">
                                      {t.statusTwapWindow} · {countdownStr}
                                    </span>
                                  ) : (
                                    <>
                                      <span style={{ color: atSpotColor }}>
                                        {atSpotLabel}
                                      </span>
                                      <span> · {countdownStr}</span>
                                    </>
                                  )}
                                </div>
                              </div>

                              {/* Right: Clean Value + PnL + Chevron (No per-row Sell button clutter) */}
                              <div className="flex shrink-0 items-center gap-2">
                                {pos.status === "ACTIVE" &&
                                pos.awaitingSettlement ? (
                                  <div className="text-right">
                                    <div className="text-xs font-semibold text-[#E6BA5C]">
                                      {pos.expiryPaused
                                        ? t.statusDisputed
                                        : t.statusAwaitingSettle}
                                    </div>
                                  </div>
                                ) : pos.status === "ACTIVE" ? (
                                  <div className="text-right tabular-nums">
                                    <div className="text-[15px] font-bold text-white">
                                      ${pos.indicativeExitUsdt.toFixed(2)}
                                    </div>
                                    <div
                                      className={`text-xs font-semibold ${
                                        pos.unrealizedPnlUsdt >= 0
                                          ? "text-[#2EC26B]"
                                          : "text-[#E85D4A]"
                                      }`}
                                    >
                                      {formatSignedUsd(pos.unrealizedPnlUsdt)} (
                                      {pos.unrealizedPnlPct >= 0 ? "+" : ""}
                                      {pos.unrealizedPnlPct.toFixed(1)}%)
                                    </div>
                                  </div>
                                ) : (
                                  <div className="text-right tabular-nums">
                                    <div
                                      className={`text-[15px] font-bold ${
                                        isPartialOutcome
                                          ? "text-[#E6BA5C]"
                                          : "text-[#2EC26B]"
                                      }`}
                                    >
                                      ${pos.claimableUsdt.toFixed(2)}
                                    </div>
                                    <div
                                      className={`text-xs font-semibold ${
                                        claimPnl >= 0
                                          ? "text-[#2EC26B]"
                                          : "text-[#E85D4A]"
                                      }`}
                                    >
                                      {formatSignedUsd(claimPnl)}
                                    </div>
                                  </div>
                                )}

                                <ChevronDown
                                  aria-hidden="true"
                                  className={`h-4 w-4 text-[#5a616c] transition-transform ${
                                    isExpanded ? "rotate-180 text-[#b8bec6]" : ""
                                  }`}
                                />
                              </div>
                            </button>

                            {/* Placement 1 Expanded Card: Labeled Start/BE/Cap Ruler + Metrics + Single Primary CTA */}
                            {isExpanded && (
                              <div className="mt-2.5 rounded-xl bg-[#121417] border border-[#1d2025] px-4 py-3.5 space-y-3 text-xs">
                                <PayoffRangeRuler pos={pos} locale={locale} />

                                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 tabular-nums">
                                  <div>
                                    <div className="text-[#7e8690]">
                                      {hasPartialSold
                                        ? isZh
                                          ? "剩余成本"
                                          : "Open cost"
                                        : isZh
                                          ? "成本"
                                          : "Cost"}
                                    </div>
                                    <div className="mt-0.5 font-semibold text-white">
                                      ${remainingStake.toFixed(2)}
                                    </div>
                                  </div>

                                  <div>
                                    <div className="text-[#7e8690]">
                                      {isZh ? "最高赔付" : "Max payout"}
                                    </div>
                                    <div className="mt-0.5 font-semibold text-white">
                                      ${pos.remainingBalanceUsdt.toFixed(2)}
                                    </div>
                                  </div>

                                  {hasPartialSold ? (
                                    <>
                                      <div>
                                        <div className="text-[#7e8690]">
                                          {isZh
                                            ? `已卖 ${soldPct}%`
                                            : `Sold ${soldPct}%`}
                                        </div>
                                        <div
                                          className={`mt-0.5 font-semibold ${
                                            soldPnl >= 0
                                              ? "text-[#2EC26B]"
                                              : "text-[#E85D4A]"
                                          }`}
                                        >
                                          ${pos.earlyCloseProceedsUsdt.toFixed(2)}{" "}
                                          ({formatSignedUsd(soldPnl)})
                                        </div>
                                      </div>

                                      <div>
                                        <div className="text-[#7e8690]">
                                          {isZh ? "整笔总盈亏" : "Total PnL"}
                                        </div>
                                        <div
                                          className={`mt-0.5 font-semibold ${
                                            combinedPnl >= 0
                                              ? "text-[#2EC26B]"
                                              : "text-[#E85D4A]"
                                          }`}
                                        >
                                          {formatSignedUsd(combinedPnl)} (
                                          {combinedPct >= 0 ? "+" : ""}
                                          {combinedPct.toFixed(0)}%)
                                        </div>
                                      </div>
                                    </>
                                  ) : (
                                    <>
                                      <div>
                                        <div className="text-[#7e8690]">
                                          {pos.status === "SETTLED_CLAIMABLE"
                                            ? isZh
                                              ? "可领取"
                                              : "Claimable"
                                            : isZh
                                              ? "现价到期"
                                              : "At spot"}
                                        </div>
                                        <div
                                          className="mt-0.5 font-semibold"
                                          style={{
                                            color:
                                              pos.status === "SETTLED_CLAIMABLE"
                                                ? isPartialOutcome
                                                  ? "#E6BA5C"
                                                  : "#2EC26B"
                                                : atSpotColor,
                                          }}
                                        >
                                          $
                                          {(pos.status === "SETTLED_CLAIMABLE"
                                            ? pos.claimableUsdt
                                            : pos.flatPayoutUsdt
                                          ).toFixed(2)}
                                        </div>
                                      </div>

                                      <div>
                                        <div className="text-[#7e8690]">
                                          {isZh ? "到期时间" : "Expires"}
                                        </div>
                                        <div className="mt-0.5 font-semibold text-white">
                                          {formatExpiryDateTime(
                                            pos.expiry,
                                            locale
                                          )}
                                        </div>
                                      </div>
                                    </>
                                  )}
                                </div>

                                {hasPartialSold && (
                                  <div className="text-[#7e8690] tabular-nums">
                                    {isZh
                                      ? `原始成本 $${pos.totalStakeUsdt.toFixed(2)} · 已提前卖出 ${soldPct}%，剩余 ${leftPct}% 持仓中`
                                      : `Original cost $${pos.totalStakeUsdt.toFixed(2)} · ${soldPct}% sold early, ${leftPct}% still open`}
                                  </div>
                                )}

                                <div className="flex flex-wrap items-center justify-between gap-2.5 border-t border-[#1d2025] pt-2.5">
                                  <div className="flex flex-wrap items-center gap-3 text-[#7e8690]">
                                    {onSelectPositionMarket && (
                                      <button
                                        type="button"
                                        onClick={() =>
                                          onSelectPositionMarket(
                                            pos.underlying,
                                            pos.expiry
                                          )
                                        }
                                        className="hover:text-white transition cursor-pointer"
                                      >
                                        {isZh ? "查看图表" : "View chart"}
                                      </button>
                                    )}
                                    {explorerBase && pos.openTxHash && (
                                      <a
                                        href={`${explorerBase}/tx/${pos.openTxHash}`}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="inline-flex items-center gap-1 hover:text-white transition"
                                      >
                                        <span>
                                          {isZh ? "开仓 tx" : "Open tx"}
                                        </span>
                                        <ExternalLink
                                          className="h-3 w-3"
                                          aria-hidden="true"
                                        />
                                      </a>
                                    )}
                                    {explorerBase && pos.closeTxHash && (
                                      <a
                                        href={`${explorerBase}/tx/${pos.closeTxHash}`}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="inline-flex items-center gap-1 hover:text-white transition"
                                      >
                                        <span>
                                          {isZh ? "平仓 tx" : "Close tx"}
                                        </span>
                                        <ExternalLink
                                          className="h-3 w-3"
                                          aria-hidden="true"
                                        />
                                      </a>
                                    )}
                                  </div>

                                  {pos.status === "ACTIVE" &&
                                    pos.remainingBalanceUsdt > 0 &&
                                    (pos.awaitingSettlement ? (
                                      pos.expiryPaused ? (
                                        <span className="inline-flex min-h-[34px] items-center gap-1 rounded-full bg-[#E85D4A]/15 px-3 py-1 text-[11px] font-semibold text-[#E85D4A]">
                                          <AlertTriangle
                                            className="h-3 w-3 shrink-0"
                                            aria-hidden="true"
                                          />
                                          {t.statusDisputed}
                                        </span>
                                      ) : (
                                        <button
                                          type="button"
                                          disabled={
                                            !pos.canPermissionlessSettle ||
                                            settlingKey ===
                                              `${pos.underlying}:${pos.expiry}`
                                          }
                                          onClick={() =>
                                            void handlePermissionlessSettle(pos)
                                          }
                                          className="inline-flex min-h-[34px] [@media(pointer:coarse)]:min-h-[40px] items-center gap-1.5 rounded-full bg-white px-4 py-1.5 text-xs font-bold text-black hover:bg-white/90 disabled:opacity-45 transition cursor-pointer"
                                        >
                                          {settlingKey ===
                                          `${pos.underlying}:${pos.expiry}` ? (
                                            <Loader2
                                              className="h-3.5 w-3.5 animate-spin"
                                              aria-hidden="true"
                                            />
                                          ) : (
                                            <ShieldCheck
                                              className="h-3.5 w-3.5"
                                              aria-hidden="true"
                                            />
                                          )}
                                          <span>
                                            {pos.canPermissionlessSettle
                                              ? t.manualSettleCta
                                              : t.settleWaitingDelayShort}
                                          </span>
                                        </button>
                                      )
                                    ) : pos.inTwapWindow ? (
                                      <span className="inline-flex min-h-[34px] items-center gap-1 rounded-full bg-[#E6BA5C]/12 px-3 py-1 text-[11px] font-semibold text-[#E6BA5C]">
                                        <Lock
                                          className="h-3 w-3 shrink-0"
                                          aria-hidden="true"
                                        />
                                        <span>{t.statusTwapWindow}</span>
                                      </span>
                                    ) : (
                                      <button
                                        type="button"
                                        onClick={() =>
                                          handleOpenEarlyClose(pos)
                                        }
                                        className="min-h-[34px] [@media(pointer:coarse)]:min-h-[40px] rounded-full bg-white px-4 py-1.5 text-xs font-bold text-black hover:bg-white/90 active:scale-[0.98] transition cursor-pointer tabular-nums"
                                      >
                                        {hasPartialSold
                                          ? isZh
                                            ? `卖出剩余 · ~$${pos.indicativeExitUsdt.toFixed(2)}`
                                            : `Sell remaining · ~$${pos.indicativeExitUsdt.toFixed(2)}`
                                          : isZh
                                            ? `卖出 · ~$${pos.indicativeExitUsdt.toFixed(2)}`
                                            : `Sell · ~$${pos.indicativeExitUsdt.toFixed(2)}`}
                                      </button>
                                    ))}

                                  {pos.status === "SETTLED_CLAIMABLE" &&
                                    pos.claimableUsdt > 0 && (
                                      <button
                                        type="button"
                                        disabled={
                                          batchClaiming ||
                                          redeemingSeriesId ===
                                            pos.seriesId.toLowerCase()
                                        }
                                        onClick={() => void handleRedeem(pos)}
                                        className="inline-flex min-h-[34px] [@media(pointer:coarse)]:min-h-[40px] items-center gap-1.5 rounded-full bg-white px-4 py-1.5 text-xs font-bold text-black hover:bg-white/90 disabled:opacity-50 transition cursor-pointer tabular-nums"
                                      >
                                        {redeemingSeriesId ===
                                        pos.seriesId.toLowerCase() ? (
                                          <Loader2
                                            className="h-3.5 w-3.5 animate-spin"
                                            aria-hidden="true"
                                          />
                                        ) : (
                                          <Award
                                            className="h-3.5 w-3.5"
                                            aria-hidden="true"
                                          />
                                        )}
                                        <span>
                                          {isZh
                                            ? `领取 $${pos.claimableUsdt.toFixed(2)}`
                                            : `Claim $${pos.claimableUsdt.toFixed(2)}`}
                                        </span>
                                      </button>
                                    )}
                                </div>
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </div>

              {/* TAB PANEL 2: History & Stats (Trades + Wallet Transfers, Zero Nested Modals) */}
              <div
                ref={historyPanelRef}
                role="tabpanel"
                aria-labelledby={historyTabId}
              >
                <div className="pt-4 space-y-4">
                  {/* Minimal Hairline Realized Stats Strip */}
                  <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-[#1d2025] pb-3.5 tabular-nums">
                    <div className="flex items-baseline gap-2">
                      <span className="text-xs font-medium text-[#7e8690]">
                        {isZh ? "已实现" : "Realized"}
                      </span>
                      <span
                        className={`text-xl font-bold tracking-[-0.025em] ${
                          totalCompletedTrades === 0
                            ? "text-white"
                            : cumulativeNetPnl >= 0
                              ? "text-[#2EC26B]"
                              : "text-[#E85D4A]"
                        }`}
                      >
                        {totalCompletedTrades === 0
                          ? "$0.00"
                          : formatSignedUsd(cumulativeNetPnl)}
                      </span>
                      {totalCompletedTrades > 0 && (
                        <span
                          className={`text-xs font-semibold ${
                            cumulativeNetPnl >= 0
                              ? "text-[#2EC26B]"
                              : "text-[#E85D4A]"
                          }`}
                        >
                          ({cumulativeRoiPct >= 0 ? "+" : ""}
                          {cumulativeRoiPct.toFixed(1)}%)
                        </span>
                      )}
                    </div>
                    <span className="text-xs text-[#7e8690]">
                      {totalCompletedTrades === 0
                        ? isZh
                          ? "0 笔"
                          : "0 trades"
                        : isZh
                          ? `${totalCompletedTrades} 笔 · 胜率 ${Math.round((directionRightCount / totalCompletedTrades) * 100)}%`
                          : `${totalCompletedTrades} ${totalCompletedTrades === 1 ? "trade" : "trades"} · ${Math.round((directionRightCount / totalCompletedTrades) * 100)}% win`}
                    </span>
                  </div>

                  {/* Partial Refund Callout */}
                  {directionRightCount > 0 && partialRefundCount > 0 && (
                    <div className="rounded-2xl bg-[#2EC26B]/12 border border-[#2EC26B]/20 px-4 py-3 text-xs leading-relaxed text-[#cbead7]">
                      {isZh ? (
                        <>
                          方向猜对的{" "}
                          <strong className="text-white">{directionRightCount}</strong>{" "}
                          笔里，有{" "}
                          <strong className="text-white">{partialRefundCount}</strong>{" "}
                          笔未到封顶也拿回了一部分。
                        </>
                      ) : (
                        <>
                          Out of{" "}
                          <strong className="text-white">{directionRightCount}</strong>{" "}
                          right calls,{" "}
                          <strong className="text-white">{partialRefundCount}</strong>{" "}
                          still paid back without reaching the cap.
                        </>
                      )}
                    </div>
                  )}

                  {/* Activity Filter Pills */}
                  <div className="flex items-center justify-between gap-2">
                    <div
                      role="group"
                      aria-label={isZh ? "筛选历史类型" : "Filter history type"}
                      className="inline-flex items-center gap-1 rounded-full bg-[#15171b] p-0.5"
                    >
                      {(
                        [
                          { id: "all", label: isZh ? "全部" : "All" },
                          { id: "trades", label: isZh ? "交易记录" : "Trades" },
                          { id: "transfers", label: isZh ? "充提记录" : "Transfers" },
                        ] as const
                      ).map((f) => {
                        const active = historyFilter === f.id;
                        return (
                          <button
                            key={f.id}
                            type="button"
                            aria-pressed={active}
                            onClick={() => setHistoryFilter(f.id)}
                            className={`rounded-full px-3 py-1 text-xs font-semibold transition cursor-pointer ${
                              active
                                ? "bg-[#24282f] text-white"
                                : "text-[#7e8690] hover:text-[#d0d6de]"
                            }`}
                          >
                            {f.label}
                          </button>
                        );
                      })}
                    </div>
                    <span className="text-xs text-[#7e8690] tabular-nums">
                      {isZh
                        ? `共 ${combinedHistory.length} 条`
                        : `${combinedHistory.length} records`}
                    </span>
                  </div>

                  {/* Unified Records List */}
                  {combinedHistory.length === 0 ? (
                    <div className="rounded-2xl bg-[#121417] border border-[#1d2025] px-6 py-12 text-center space-y-2">
                      <div className="text-sm font-bold text-white">
                        {historyFilter === "transfers"
                          ? isZh
                            ? "暂无充提或领水记录"
                            : "No deposit or withdrawal records yet"
                          : isZh
                            ? "暂无已结算或已平仓记录"
                            : "No settled or closed trades yet"}
                      </div>
                      <p className="mx-auto max-w-sm text-xs leading-relaxed text-[#7e8690]">
                        {historyFilter === "transfers"
                          ? isZh
                            ? "在资产页完成领水或链上提币后，交易记录与 BscScan 凭证会自动展示在这里。"
                            : "Your faucet mints and on-chain withdrawals with BscScan links will appear here."
                          : isZh
                            ? "完成一笔提前卖出、到期结算或充提后，这里会自动统计你的战绩与链上凭证。"
                            : "Your cumulative PnL, right-direction stats, and BscScan tx proofs will appear here."}
                      </p>
                    </div>
                  ) : (
                    <ul
                      role="list"
                      className="divide-y divide-[#1d2025] border-t border-b border-[#1d2025]"
                    >
                      {combinedHistory.map((item) => {
                        if (item.kind === "TRANSFER") {
                          const tr = item.transfer;
                          const isWithdraw = tr.kind === "WITHDRAW";
                          const shortTo = tr.toAddress
                            ? `${tr.toAddress.slice(0, 6)}…${tr.toAddress.slice(-4)}`
                            : "";
                          return (
                            <li
                              key={`tr:${tr.id}`}
                              className="flex items-center justify-between gap-3 py-3.5"
                            >
                              <div className="flex items-center gap-3 min-w-0">
                                <span
                                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                                    isWithdraw
                                      ? "bg-[#24282f] text-white"
                                      : "bg-[#2EC26B]/13 text-[#2EC26B]"
                                  }`}
                                  aria-hidden="true"
                                >
                                  {isWithdraw ? (
                                    <ArrowUpRight className="h-4 w-4" />
                                  ) : (
                                    <Droplets className="h-4 w-4" />
                                  )}
                                </span>
                                <div className="min-w-0">
                                  <div className="flex flex-wrap items-center gap-1.5 text-[14px] font-bold text-white">
                                    <span>
                                      {isWithdraw
                                        ? isZh
                                          ? "提币 tUSDT"
                                          : "Withdraw tUSDT"
                                        : isZh
                                          ? "测试网领水"
                                          : "Testnet Faucet"}
                                    </span>
                                    {shortTo && (
                                      <span className="font-mono text-xs font-medium text-[#7e8690]">
                                        → {shortTo}
                                      </span>
                                    )}
                                  </div>
                                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-[#7e8690] tabular-nums">
                                    <span>{formatShortDate(tr.timestampSec)}</span>
                                    <span>·</span>
                                    <span>{isZh ? "已确认" : "Confirmed"}</span>
                                    {explorerBase && tr.txHash && (
                                      <>
                                        <span>·</span>
                                        <a
                                          href={`${explorerBase}/tx/${tr.txHash}`}
                                          target="_blank"
                                          rel="noreferrer"
                                          className="inline-flex items-center gap-0.5 text-[#b8bec6] hover:text-white transition"
                                        >
                                          BscScan
                                          <ExternalLink
                                            className="h-2.5 w-2.5"
                                            aria-hidden="true"
                                          />
                                        </a>
                                      </>
                                    )}
                                  </div>
                                </div>
                              </div>

                              <div className="text-right tabular-nums shrink-0">
                                <div
                                  className={`text-[15px] font-bold tracking-[-0.02em] ${
                                    isWithdraw ? "text-white" : "text-[#2EC26B]"
                                  }`}
                                >
                                  {isWithdraw ? "−" : "+"}${tr.amountUsdt.toFixed(2)}
                                </div>
                                <div className="text-[11px] font-medium text-[#7e8690]">
                                  tUSDT
                                </div>
                              </div>
                            </li>
                          );
                        }

                        const entry = item.trade;
                        const {
                          pos,
                          timestampSec,
                          realizedStakeUsdt,
                          totalPayout,
                          netPnl,
                          soldSharePct,
                          isPartialActiveClose,
                          isClosedEarly,
                          isBufferNotZero,
                        } = entry;
                        const rowKey = positionKey(pos);
                        const isExpanded = expandedHistoryKey === rowKey;
                        const spec = ASSET_SPECS[pos.underlying];
                        const dirText = pos.isUp ? t.bull : t.bear;
                        const roiPct =
                          realizedStakeUsdt > 0
                            ? (netPnl / realizedStakeUsdt) * 100
                            : 0;
                        const openPct = Math.max(1, 100 - soldSharePct);
                        const combinedPnl =
                          pos.earlyCloseProceedsUsdt +
                          pos.indicativeExitUsdt -
                          pos.totalStakeUsdt;
                        const combinedPct =
                          pos.totalStakeUsdt > 0
                            ? (combinedPnl / pos.totalStakeUsdt) * 100
                            : 0;

                        const statusLabel = isPartialActiveClose
                          ? isZh
                            ? `部分卖出 ${soldSharePct}%`
                            : `Sold ${soldSharePct}%`
                          : isClosedEarly
                            ? isZh
                              ? "提前卖出"
                              : "Sold early"
                            : pos.status === "SETTLED_CLAIMABLE"
                              ? isZh
                                ? "待领取"
                                : "Claimable"
                              : totalPayout <= 0.005
                                ? isZh
                                  ? "未入区"
                                  : "Expired $0"
                                : isZh
                                  ? "已领取"
                                  : "Claimed";

                        const metaParts = [
                          statusLabel,
                          formatShortDate(timestampSec),
                        ];
                        if (!isClosedEarly && pos.settlementPrice !== undefined) {
                          metaParts.push(
                            isZh
                              ? `结算价 ${formatStrikePrice(pos.settlementPrice, pos.underlying)}`
                              : `Settled ${formatStrikePrice(pos.settlementPrice, pos.underlying)}`
                          );
                        }

                        const txLinks: Array<{ label: string; hash: string }> = [];
                        if (pos.openTxHash) {
                          txLinks.push({
                            label: isZh ? "开仓 tx" : "Open tx",
                            hash: pos.openTxHash,
                          });
                        }
                        if (pos.closeTxHash) {
                          txLinks.push({
                            label: isZh ? "平仓 tx" : "Close tx",
                            hash: pos.closeTxHash,
                          });
                        }
                        if (pos.redeemTxHash) {
                          txLinks.push({
                            label: isZh ? "领取 tx" : "Claim tx",
                            hash: pos.redeemTxHash,
                          });
                        }

                        return (
                          <li key={`pos:${rowKey}`} className="py-3">
                            <button
                              type="button"
                              aria-expanded={isExpanded}
                              onClick={() =>
                                setExpandedHistoryKey(isExpanded ? null : rowKey)
                              }
                              className="flex w-full items-center justify-between gap-3 rounded-xl px-2 py-1 -mx-2 text-left hover:bg-[#101216] transition cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
                            >
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-1.5 tabular-nums">
                                  <span
                                    className={`h-1.5 w-1.5 rounded-full shrink-0 ${
                                      pos.isUp ? "bg-[#2EC26B]" : "bg-[#E85D4A]"
                                    }`}
                                    aria-hidden="true"
                                  />
                                  <span className="text-[14px] font-bold text-white tracking-[-0.01em]">
                                    {spec.displaySymbol}{" "}
                                    <span
                                      className={
                                        pos.isUp
                                          ? "text-[#2EC26B]"
                                          : "text-[#E85D4A]"
                                      }
                                    >
                                      {dirText}
                                    </span>
                                  </span>
                                  <span className="text-xs font-medium text-[#b8bec6]">
                                    {formatStrikePrice(
                                      pos.startPrice,
                                      pos.underlying
                                    )}{" "}
                                    →{" "}
                                    {formatStrikePrice(
                                      pos.capPrice,
                                      pos.underlying
                                    )}
                                  </span>
                                  {isBufferNotZero && (
                                    <span className="rounded-full bg-[#E6BA5C]/12 px-2 py-0.5 text-[10px] font-bold text-[#E6BA5C]">
                                      {isZh ? "部分回本" : "Partial"}
                                    </span>
                                  )}
                                  {pos.status === "SETTLED_CLAIMABLE" && (
                                    <span className="rounded-full bg-[#2EC26B]/14 px-2 py-0.5 text-[10px] font-bold text-[#2EC26B]">
                                      {isZh ? "待领取" : "Claimable"}
                                    </span>
                                  )}
                                </div>
                                <div className="mt-0.5 text-xs text-[#7e8690] tabular-nums">
                                  {metaParts.join(" · ")}
                                </div>
                              </div>

                              <div className="flex items-center gap-2 shrink-0">
                                <div className="text-right tabular-nums">
                                  <div className="text-[15px] font-bold text-white tracking-[-0.02em]">
                                    ${totalPayout.toFixed(2)}
                                  </div>
                                  <div
                                    className={`text-xs font-semibold ${
                                      netPnl > 0.005
                                        ? "text-[#2EC26B]"
                                        : netPnl < -0.005
                                          ? "text-[#E85D4A]"
                                          : "text-[#7e8690]"
                                    }`}
                                  >
                                    {formatSignedUsd(netPnl)} (
                                    {roiPct >= 0 ? "+" : ""}
                                    {roiPct.toFixed(1)}%)
                                  </div>
                                </div>
                                <ChevronDown
                                  aria-hidden="true"
                                  className={`h-4 w-4 text-[#5a616c] transition-transform ${
                                    isExpanded ? "rotate-180 text-[#b8bec6]" : ""
                                  }`}
                                />
                              </div>
                            </button>

                            {isExpanded && (
                              <div className="mt-2.5 rounded-xl bg-[#121417] border border-[#1d2025] px-4 py-3.5 space-y-3 text-xs">
                                {!isClosedEarly &&
                                  pos.settlementPrice !== undefined && (
                                    <PayoffRangeRuler pos={pos} locale={locale} />
                                  )}

                                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 tabular-nums">
                                  <div>
                                    <span className="text-[#7e8690]">
                                      {isPartialActiveClose
                                        ? isZh
                                          ? "平仓成本"
                                          : "Sold cost"
                                        : isZh
                                          ? "成本"
                                          : "Cost"}
                                    </span>
                                    <div className="mt-0.5 font-semibold text-white">
                                      ${realizedStakeUsdt.toFixed(2)}
                                    </div>
                                  </div>

                                  <div>
                                    <span className="text-[#7e8690]">
                                      {isClosedEarly
                                        ? isZh
                                          ? "卖出收回"
                                          : "Proceeds"
                                        : isZh
                                          ? "到期赔付"
                                          : "Payout"}
                                    </span>
                                    <div className="mt-0.5 font-semibold text-white">
                                      ${totalPayout.toFixed(2)}
                                    </div>
                                  </div>

                                  {isPartialActiveClose ? (
                                    <>
                                      <div>
                                        <span className="text-[#7e8690]">
                                          {isZh
                                            ? `剩余 (${openPct}%)`
                                            : `Open (${openPct}%)`}
                                        </span>
                                        <div
                                          className={`mt-0.5 font-semibold ${
                                            pos.unrealizedPnlUsdt >= 0
                                              ? "text-[#2EC26B]"
                                              : "text-[#E85D4A]"
                                          }`}
                                        >
                                          ${pos.indicativeExitUsdt.toFixed(2)} (
                                          {formatSignedUsd(pos.unrealizedPnlUsdt)})
                                        </div>
                                      </div>

                                      <div>
                                        <span className="text-[#7e8690]">
                                          {isZh ? "整笔总盈亏" : "Total PnL"}
                                        </span>
                                        <div
                                          className={`mt-0.5 font-semibold ${
                                            combinedPnl >= 0
                                              ? "text-[#2EC26B]"
                                              : "text-[#E85D4A]"
                                          }`}
                                        >
                                          {formatSignedUsd(combinedPnl)} (
                                          {combinedPct >= 0 ? "+" : ""}
                                          {combinedPct.toFixed(0)}%)
                                        </div>
                                      </div>
                                    </>
                                  ) : (
                                    <>
                                      <div>
                                        <span className="text-[#7e8690]">
                                          {isZh ? "协议费" : "Fee"}
                                        </span>
                                        <div className="mt-0.5 font-semibold text-white">
                                          ${pos.protocolFeeUsdt.toFixed(2)}
                                        </div>
                                      </div>

                                      <div>
                                        <span className="text-[#7e8690]">
                                          {isClosedEarly
                                            ? isZh
                                              ? "平仓时间"
                                              : "Closed"
                                            : isZh
                                              ? "结算价"
                                              : "Settled"}
                                        </span>
                                        <div className="mt-0.5 font-semibold text-white">
                                          {isClosedEarly
                                            ? formatShortDate(timestampSec)
                                            : pos.settlementPrice !== undefined
                                              ? formatStrikePrice(
                                                  pos.settlementPrice,
                                                  pos.underlying
                                                )
                                              : "--"}
                                        </div>
                                      </div>
                                    </>
                                  )}
                                </div>

                                {(txLinks.length > 0 ||
                                  (isPartialActiveClose &&
                                    !pos.awaitingSettlement &&
                                    !pos.inTwapWindow) ||
                                  (pos.status === "SETTLED_CLAIMABLE" &&
                                    pos.claimableUsdt > 0)) && (
                                  <div className="flex flex-wrap items-center justify-between gap-2.5 border-t border-[#1d2025] pt-2.5">
                                    <div className="flex flex-wrap items-center gap-3 text-[#7e8690]">
                                      {explorerBase &&
                                        txLinks.map((lnk) => (
                                          <a
                                            key={`${lnk.label}-${lnk.hash}`}
                                            href={`${explorerBase}/tx/${lnk.hash}`}
                                            target="_blank"
                                            rel="noreferrer"
                                            className="inline-flex items-center gap-1 hover:text-white transition"
                                          >
                                            <span>{lnk.label}</span>
                                            <ExternalLink
                                              className="h-3 w-3"
                                              aria-hidden="true"
                                            />
                                          </a>
                                        ))}
                                    </div>

                                    {isPartialActiveClose &&
                                      !pos.awaitingSettlement &&
                                      !pos.inTwapWindow && (
                                        <button
                                          type="button"
                                          onClick={() =>
                                            handleOpenEarlyClose(pos)
                                          }
                                          className="rounded-full bg-[#24282f] px-3.5 py-1.5 text-xs font-bold text-white hover:bg-white hover:text-black transition cursor-pointer"
                                        >
                                          {isZh
                                            ? `卖出剩余 ${openPct}%`
                                            : `Sell remaining ${openPct}%`}
                                        </button>
                                      )}

                                    {pos.status === "SETTLED_CLAIMABLE" &&
                                      pos.claimableUsdt > 0 && (
                                        <button
                                          type="button"
                                          disabled={
                                            batchClaiming ||
                                            redeemingSeriesId ===
                                              pos.seriesId.toLowerCase()
                                          }
                                          onClick={() => void handleRedeem(pos)}
                                          className="rounded-full bg-white px-4 py-1.5 text-xs font-bold text-black hover:bg-white/90 disabled:opacity-50 transition cursor-pointer tabular-nums"
                                        >
                                          {isZh
                                            ? `领取 $${pos.claimableUsdt.toFixed(2)}`
                                            : `Claim $${pos.claimableUsdt.toFixed(2)}`}
                                        </button>
                                      )}
                                  </div>
                                )}
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </div>
            </div>
          </div>
      </div>

      {/* Deposit & Withdraw Modals */}
      <DepositModal
        open={depositOpen}
        locale={locale}
        wallet={wallet}
        onClose={() => setDepositOpen(false)}
        onOpenMint={onOpenMint}
      />

      <WithdrawModal
        open={withdrawOpen}
        locale={locale}
        wallet={wallet}
        onClose={() => setWithdrawOpen(false)}
        onWithdraw={handleWithdrawFromModal}
      />

      {/* Early Close Modal */}
      {activeClosingPos && (
        <EarlyCloseModal
          locale={locale}
          position={activeClosingPos}
          stage={closeStage}
          slippagePause={closeSlippagePause}
          errorMsg={closeErr}
          onInstantSell={(ratio) =>
            void handleInstantSell(activeClosingPos, ratio)
          }
          onConfirmSlippageClose={() => void handleConfirmSlippageClose()}
          onClearSlippagePause={() => {
            setCloseSlippagePause(undefined);
            setCloseStage("IDLE");
            setCloseErr(undefined);
          }}
          onCloseModal={() => {
            setClosingPos(null);
            setCloseSlippagePause(undefined);
            setCloseStage("IDLE");
            setCloseErr(undefined);
          }}
        />
      )}
    </main>
  );
}

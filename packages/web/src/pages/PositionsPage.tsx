import { useMemo, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  Award,
  CheckCircle2,
  Clock,
  Droplets,
  ExternalLink,
  Loader2,
  Lock,
  Mail,
  ShieldCheck,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import {
  ASSET_SPECS,
  BSC_TESTNET,
  formatSettlementLabel,
  type CloseRfqResponse,
  type PositionView,
  type UnderlyingSymbol,
} from "@payoff/shared";
import { api, type HealthResponse } from "../lib/api";
import { formatStrikePrice } from "../lib/format";
import { getCopy, type Locale } from "../lib/i18n";
import {
  executeBatchRedeemTx,
  executeClaimTestUsdtTx,
  executeCloseTicketTx,
  executeRedeemTx,
  executeSettleWithAtlasTwapTx,
  extractWalletErrorMessage,
  getExplorerBaseUrl,
  type ConnectedWallet,
} from "../lib/wallet";
import {
  EarlyCloseModal,
  type CloseSlippagePauseState,
  type EarlyCloseStage,
} from "../components/EarlyCloseModal";
import { UsdtIcon } from "../components/PayoffMark";

interface Props {
  locale: Locale;
  wallet: ConnectedWallet;
  health?: HealthResponse;
  positions: PositionView[];
  onOpenWallet: () => void;
  onGoToTrade: () => void;
  onRefresh: () => void;
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

const SLIPPAGE_TOLERANCE_RATIO = 0.985; // 1.5% adverse slippage circuit breaker
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function positionKey(pos: PositionView): string {
  return `${pos.seriesId}:${pos.isUp ? "UP" : "DOWN"}`;
}

function formatSignedUsd(v: number): string {
  const sign = v >= 0 ? "+" : "−";
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

export function PositionsPage({
  locale,
  wallet,
  health,
  positions,
  onOpenWallet,
  onGoToTrade,
  onRefresh,
  onBatchClaim,
  onClaimPosition,
  onManualSettle,
  onSelectPositionMarket,
}: Props) {
  const isZh = locale === "zh";
  const t = getCopy(locale);

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
  const [faucetAmount, setFaucetAmount] = useState<number>(1000);
  const [faucetBusy, setFaucetBusy] = useState(false);
  const [faucetErr, setFaucetErr] = useState<string | undefined>();

  const explorerBase = getExplorerBaseUrl(
    health?.chainId ?? BSC_TESTNET.chainId
  );

  // Keep modal's indicative exit value live-synced as WS ticks update positions
  const activeClosingPos = closingPos
    ? positions.find((p) => positionKey(p) === positionKey(closingPos)) ??
      closingPos
    : null;

  const claimableGroup = useMemo(() => {
    const items = positions.filter(
      (p) => p.status === "SETTLED_CLAIMABLE" && p.claimableUsdt > 0
    );
    const seriesIds = Array.from(
      new Set(items.map((p) => p.seriesId))
    ) as `0x${string}`[];
    const totalClaimable = items.reduce((s, p) => s + p.claimableUsdt, 0);
    const totalStake = items.reduce((s, p) => s + p.totalStakeUsdt, 0);
    return {
      items,
      seriesIds,
      totalClaimable,
      totalStake,
      netPnl: totalClaimable - totalStake,
      isPartial: totalClaimable > 0 && totalClaimable < totalStake,
    };
  }, [positions]);

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

  const handleClaimTestUsdt = async () => {
    setFaucetBusy(true);
    setFaucetErr(undefined);
    setToastMsg(undefined);
    setActionErr(undefined);
    try {
      const rpcUrl = health?.rpcUrl || BSC_TESTNET.rpcUrl;
      const usdtAddress =
        health?.usdtAddress && health.usdtAddress !== ZERO_ADDRESS
          ? health.usdtAddress
          : BSC_TESTNET.usdtAddress;
      if (!usdtAddress || usdtAddress === ZERO_ADDRESS) {
        throw new Error(
          isZh
            ? "未配置测试网 MockUSDT 合约地址，请检查服务端健康状态"
            : "MockUSDT contract address is not configured yet"
        );
      }
      const clampedAmount = Math.max(1, Math.min(100_000, faucetAmount));
      await executeClaimTestUsdtTx({
        wallet,
        rpcUrl,
        usdtAddress,
        amountUsdt: clampedAmount,
      });
      setToastMsg(t.faucetSuccess(clampedAmount));
      onRefresh();
    } catch (err: any) {
      setFaucetErr(extractWalletErrorMessage(err, "Claim failed"));
    } finally {
      setFaucetBusy(false);
    }
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
        ? `已提前平仓落袋 ${rfq.netProceedsUsdt.toFixed(2)} USDT`
        : `Closed early for ${rfq.netProceedsUsdt.toFixed(2)} USDT`
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
      ratio >= 1 ? undefined : pos.remainingBalanceUsdt * ratio;

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
    if (batchClaiming || claimableGroup.seriesIds.length === 0) return;
    setBatchClaiming(true);
    setToastMsg(undefined);
    setActionErr(undefined);
    try {
      if (onBatchClaim) {
        await onBatchClaim(claimableGroup.seriesIds);
      } else {
        if (!health?.vaultAddress) {
          throw new Error("Vault contract address unavailable");
        }
        const hash = await executeBatchRedeemTx({
          wallet,
          rpcUrl: health.rpcUrl,
          vaultAddress: health.vaultAddress,
          seriesIds: claimableGroup.seriesIds,
        });
        await api.ingestTx(hash).catch(() => api.syncChain());
        onRefresh();
      }
      setToastMsg(
        t.outcomeClaimedSuccess(claimableGroup.totalClaimable.toFixed(2))
      );
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
      const combinedClaimable = positions
        .filter(
          (p) =>
            p.seriesId.toLowerCase() === sidLower &&
            p.status === "SETTLED_CLAIMABLE"
        )
        .reduce((sum, p) => sum + p.claimableUsdt, 0);
      const displayClaimed =
        combinedClaimable > 0 ? combinedClaimable : pos.claimableUsdt;
      setToastMsg(t.outcomeClaimedSuccess(displayClaimed.toFixed(2)));
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

  if (wallet.kind === "NONE") {
    return (
      <main className="mx-auto max-w-md bg-black px-4 py-16 text-center">
        <div className="rounded-3xl bg-[#121417] p-8 space-y-4">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[#24282f] text-white">
            <Mail className="h-5 w-5" aria-hidden="true" />
          </div>
          <h1 className="text-lg font-bold text-white">
            {t.positionsConnectTitle}
          </h1>
          <p className="text-xs leading-relaxed text-[#7e8690]">
            {t.positionsConnectDesc}
          </p>
          <button
            type="button"
            onClick={onOpenWallet}
            className="w-full min-h-[48px] rounded-full bg-white py-3 text-sm font-bold text-black hover:bg-white/90 transition cursor-pointer"
          >
            {t.connectWallet}
          </button>
        </div>
      </main>
    );
  }

  const activeTotalExit = positions.reduce(
    (sum, p) =>
      sum +
      (p.status === "ACTIVE"
        ? p.indicativeExitUsdt
        : p.status === "SETTLED_CLAIMABLE"
          ? p.claimableUsdt
          : 0),
    0
  );
  const activeTotalStake = positions.reduce(
    (sum, p) =>
      sum +
      (p.status === "ACTIVE" || p.status === "SETTLED_CLAIMABLE"
        ? p.totalStakeUsdt
        : 0),
    0
  );
  const activePnl = positions.reduce(
    (sum, p) =>
      sum +
      (p.status === "ACTIVE" || p.status === "SETTLED_CLAIMABLE"
        ? p.unrealizedPnlUsdt
        : 0),
    0
  );
  const activePnlPct =
    activeTotalStake > 0 ? (activePnl / activeTotalStake) * 100 : 0;

  return (
    <main className="mx-auto max-w-4xl bg-black px-4 pt-4 pb-16 sm:px-6 space-y-6">
      {/* Portfolio Hero */}
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-[#1d2025] pb-5">
        <div>
          <h1 className="text-xs font-semibold text-[#7e8690]">
            {t.portfolioValue}
          </h1>
          <div className="mt-1 inline-flex items-baseline gap-2 text-[36px] font-bold leading-none tracking-[-0.03em] text-white tabular-nums">
            <UsdtIcon size={24} className="self-center" />
            <span>{activeTotalExit.toFixed(2)}</span>
            <span className="text-sm font-semibold text-[#7e8690]">USDT</span>
          </div>
          {activeTotalStake > 0 && (
            <div
              className={`mt-1.5 text-xs font-semibold tabular-nums ${
                activePnl >= 0 ? "text-[#2EC26B]" : "text-[#E85D4A]"
              }`}
            >
              {formatSignedUsd(activePnl)} ({activePnl >= 0 ? "+" : ""}
              {activePnlPct.toFixed(1)}%)
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          <div className="inline-flex items-center gap-1.5 rounded-full bg-[#15171b] px-3 py-1.5 text-[11px] font-medium text-[#b8bec6]">
            <span className="h-1.5 w-1.5 rounded-full bg-[#2EC26B] animate-pulse" />
            {t.liveUpdating}
          </div>
          <button
            type="button"
            onClick={onGoToTrade}
            className="inline-flex items-center gap-1 rounded-full bg-[#24282f] px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-[#2f343d] transition cursor-pointer"
          >
            <span>{t.goTrade}</span>
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>

      {toastMsg && (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center gap-2 rounded-2xl border border-[#2EC26B]/25 bg-[#121417] px-4 py-3 text-xs font-semibold text-[#2EC26B]"
        >
          <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{toastMsg}</span>
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

      {/* Batch Claim Dark Outcome Banner (batchRedeem) */}
      {claimableGroup.items.length > 0 && (
        <section className="rounded-2xl bg-[#121417] p-5 space-y-3.5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span
                  className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold ${
                    claimableGroup.isPartial
                      ? "bg-[#E6BA5C]/18 text-[#E6BA5C]"
                      : "bg-[#2EC26B]/15 text-[#2EC26B]"
                  }`}
                >
                  {claimableGroup.isPartial
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
                    claimableGroup.isPartial
                      ? "text-[#E6BA5C]"
                      : "text-[#2EC26B]"
                  }`}
                >
                  ${claimableGroup.totalClaimable.toFixed(2)}
                </span>
                <span className="text-xs font-semibold text-[#7e8690]">
                  ({formatSignedUsd(claimableGroup.netPnl)})
                </span>
              </div>
            </div>

            <button
              type="button"
              disabled={batchClaiming}
              onClick={() => void handleBatchClaimAll()}
              className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-full bg-white px-5 py-2.5 text-xs font-bold text-black hover:bg-white/90 disabled:opacity-50 transition cursor-pointer tabular-nums"
            >
              {batchClaiming ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Award className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              <span>
                {batchClaiming
                  ? t.outcomeClaiming
                  : t.outcomeBatchClaimCta(
                      claimableGroup.totalClaimable.toFixed(2),
                      claimableGroup.items.length
                    )}
              </span>
            </button>
          </div>
        </section>
      )}

      {/* Testnet tUSDT Gasless Faucet Card (Dark #121417) */}
      <section className="rounded-2xl bg-[#121417] p-5 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <UsdtIcon size={20} />
              <h2 className="text-sm font-bold text-white">{t.faucetTitle}</h2>
            </div>
            <p className="mt-1 text-xs text-[#7e8690]">{t.faucetDesc}</p>
          </div>
          <span className="inline-flex items-center gap-1 rounded-full bg-[#2EC26B]/13 px-2.5 py-1 text-[11px] font-bold text-[#2EC26B] shrink-0">
            <Sparkles className="h-3 w-3" aria-hidden="true" />
            {t.gasFreeBadge}
          </span>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-[#15171b] px-4 py-2.5">
          <span className="text-xs text-[#7e8690]">{t.faucetBalance}</span>
          <span className="inline-flex items-center gap-1.5 text-sm font-bold text-white tabular-nums">
            <UsdtIcon size={15} />
            {wallet.usdtBalance.toLocaleString("en-US", {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}{" "}
            tUSDT
          </span>
        </div>

        <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center">
          <div className="flex items-center gap-1.5">
            {[1000, 5000, 10000].map((amt) => (
              <button
                key={amt}
                type="button"
                aria-pressed={faucetAmount === amt}
                onClick={() => setFaucetAmount(amt)}
                className={`rounded-full px-3 py-1.5 text-xs font-semibold tabular-nums transition cursor-pointer ${
                  faucetAmount === amt
                    ? "bg-[#24282f] text-white border border-white/22"
                    : "bg-[#15171b] text-[#7e8690] hover:text-white border border-transparent"
                }`}
              >
                +{amt.toLocaleString()}
              </button>
            ))}
          </div>

          <div className="relative flex-1">
            <input
              type="number"
              min={1}
              max={100000}
              step={100}
              value={faucetAmount}
              onChange={(e) =>
                setFaucetAmount(
                  Math.max(1, Math.min(100_000, Number(e.target.value) || 1))
                )
              }
              aria-label={t.faucetAmountLabel}
              className="w-full rounded-full border border-[#262a31] bg-[#131519] px-4 py-2 pr-16 text-sm font-semibold text-white tabular-nums focus:border-white/35 focus:outline-none"
            />
            <span className="absolute right-4 top-1/2 -translate-y-1/2 text-xs font-semibold text-[#7e8690]">
              tUSDT
            </span>
          </div>

          <button
            type="button"
            disabled={faucetBusy}
            onClick={() => void handleClaimTestUsdt()}
            className="flex min-h-[40px] items-center justify-center gap-1.5 rounded-full bg-[#24282f] px-5 py-2 text-xs font-bold text-white hover:bg-[#2f343d] disabled:opacity-50 transition cursor-pointer shrink-0"
          >
            {faucetBusy ? (
              <>
                <Loader2
                  className="h-3.5 w-3.5 animate-spin"
                  aria-hidden="true"
                />
                {t.faucetClaiming}
              </>
            ) : (
              <>
                <Droplets className="h-3.5 w-3.5" aria-hidden="true" />
                {t.faucetClaimBtn(faucetAmount)}
              </>
            )}
          </button>
        </div>

        {faucetErr && (
          <div
            role="alert"
            className="rounded-xl bg-[#E85D4A]/12 px-3.5 py-2 text-xs font-medium text-[#E85D4A]"
          >
            {faucetErr}
          </div>
        )}
      </section>

      {/* Positions Hairline List */}
      {positions.length === 0 ? (
        <div className="rounded-2xl bg-[#121417] p-10 text-center space-y-4">
          <div className="text-sm font-bold text-white">{t.noPositions}</div>
          <p className="text-xs text-[#7e8690]">{t.noPositionsDesc}</p>
          <button
            type="button"
            onClick={onGoToTrade}
            className="rounded-full bg-white px-6 py-2.5 text-xs font-bold text-black hover:bg-white/90 transition cursor-pointer"
          >
            {t.goTrade}
          </button>
        </div>
      ) : (
        <div className="divide-y divide-[#1d2025] border-t border-b border-[#1d2025]">
          {positions.map((pos) => {
            const key = positionKey(pos);
            const isBull = pos.isUp;
            const isPartialOutcome =
              pos.status === "SETTLED_CLAIMABLE" &&
              pos.claimableUsdt > 0 &&
              pos.claimableUsdt < pos.totalStakeUsdt;

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
                    ? {
                        label: t.statusActive,
                        cls: "bg-[#2EC26B]/13 text-[#2EC26B]",
                      }
                    : pos.status === "CLOSED_EARLY"
                      ? {
                          label: t.statusClosed,
                          cls: "bg-[#24282f] text-[#b8bec6]",
                        }
                      : pos.status === "SETTLED_CLAIMABLE"
                        ? isPartialOutcome
                          ? {
                              label: t.outcomePartialBadge,
                              cls: "bg-[#E6BA5C]/18 text-[#E6BA5C]",
                            }
                          : {
                              label: t.statusClaimable,
                              cls: "bg-[#2EC26B]/15 text-[#2EC26B]",
                            }
                        : {
                            label: t.statusSettled,
                            cls: "bg-[#15171b] text-[#7e8690]",
                          };

            return (
              <div key={key} className="py-5 space-y-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          onSelectPositionMarket?.(pos.underlying, pos.expiry)
                        }
                        className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-bold transition cursor-pointer ${
                          isBull
                            ? "bg-[#2EC26B]/13 text-[#2EC26B]"
                            : "bg-[#E85D4A]/14 text-[#E85D4A]"
                        }`}
                      >
                        <span>{ASSET_SPECS[pos.underlying].displaySymbol}</span>
                        {ASSET_SPECS[pos.underlying].assetClass ===
                          "RWA_EQUITY" && (
                          <span className="rounded bg-white/15 px-1 text-[9px] font-bold uppercase tracking-wider text-white">
                            RWA
                          </span>
                        )}
                        <span>{isBull ? t.bull : t.bear}</span>
                      </button>

                      <span
                        className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${statusPill.cls}`}
                      >
                        {statusPill.label}
                      </span>

                      {explorerBase && pos.openTxHash && (
                        <a
                          href={`${explorerBase}/tx/${pos.openTxHash}`}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-[11px] font-medium text-[#7e8690] hover:text-white underline underline-offset-2"
                        >
                          BscScan
                          <ExternalLink
                            className="h-2.5 w-2.5"
                            aria-hidden="true"
                          />
                        </a>
                      )}
                    </div>

                    <h2 className="mt-2 text-lg font-bold text-white tabular-nums">
                      {formatStrikePrice(pos.startPrice, pos.underlying)} →{" "}
                      {formatStrikePrice(pos.capPrice, pos.underlying)}
                    </h2>
                  </div>

                  {pos.status === "ACTIVE" && pos.awaitingSettlement ? (
                    <div className="text-right">
                      <div className="text-[11px] font-semibold text-[#E6BA5C]">
                        {pos.expiryPaused
                          ? t.statusDisputed
                          : t.statusAwaitingSettle}
                      </div>
                      <div className="mt-1 text-xs font-medium text-[#b8bec6]">
                        {pos.expiryPaused
                          ? t.disputedShortLabel
                          : t.awaitingTwapShortLabel}
                      </div>
                    </div>
                  ) : pos.status === "ACTIVE" ? (
                    <div className="text-right tabular-nums">
                      <div className="text-[11px] font-medium text-[#7e8690]">
                        {pos.inTwapWindow
                          ? t.indicativeCloseLockedLabel
                          : t.canExitNow}
                      </div>
                      <div className="text-2xl font-bold text-white">
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
                  ) : pos.status === "SETTLED_CLAIMABLE" ? (
                    <div className="text-right tabular-nums">
                      <div
                        className={`text-[11px] font-semibold ${
                          isPartialOutcome
                            ? "text-[#E6BA5C]"
                            : pos.claimableUsdt > 0
                              ? "text-[#2EC26B]"
                              : "text-[#7e8690]"
                        }`}
                      >
                        {isPartialOutcome ? t.outcomePartialTitle : t.claimable}
                      </div>
                      <div
                        className={`text-2xl font-bold ${
                          isPartialOutcome
                            ? "text-[#E6BA5C]"
                            : pos.claimableUsdt > 0
                              ? "text-[#2EC26B]"
                              : "text-[#7e8690]"
                        }`}
                      >
                        ${pos.claimableUsdt.toFixed(2)}
                      </div>
                    </div>
                  ) : (
                    <div className="text-right tabular-nums">
                      <div className="text-[11px] text-[#7e8690]">
                        {t.realized}
                      </div>
                      <div className="text-xl font-bold text-white">
                        $
                        {(
                          pos.earlyCloseProceedsUsdt + pos.redeemedUsdt
                        ).toFixed(2)}
                      </div>
                    </div>
                  )}
                </div>

                {/* Compact Metric Strip */}
                <div className="grid grid-cols-2 gap-3 rounded-xl bg-[#121417] p-3.5 text-xs sm:grid-cols-4 tabular-nums">
                  <div>
                    <div className="text-[#7e8690]">{t.numStake}</div>
                    <div className="mt-0.5 font-semibold text-white">
                      ${pos.totalStakeUsdt.toFixed(2)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[#7e8690]">{t.numBreakeven}</div>
                    <div className="mt-0.5 font-semibold text-white">
                      {formatStrikePrice(pos.breakevenPrice, pos.underlying)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[#7e8690]">{t.numCapPayout}</div>
                    <div className="mt-0.5 font-semibold text-[#2EC26B]">
                      $
                      {(pos.status === "ACTIVE" ||
                      pos.status === "SETTLED_CLAIMABLE"
                        ? pos.remainingBalanceUsdt
                        : pos.initialMaxPayoutUsdt
                      ).toFixed(2)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[#7e8690]">{t.numExpiry}</div>
                    <div className="mt-0.5 flex items-center gap-1 font-medium text-[#b8bec6] leading-tight">
                      <Clock
                        className="h-3 w-3 shrink-0 text-[#7e8690]"
                        aria-hidden="true"
                      />
                      <span>{formatSettlementLabel(pos.expiry)}</span>
                    </div>
                  </div>
                </div>

                {/* Action Row */}
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="flex items-center gap-1.5 text-[11px] text-[#7e8690]">
                    <ShieldCheck
                      className="h-3.5 w-3.5 text-[#2EC26B]"
                      aria-hidden="true"
                    />
                    {t.holdNotice}
                  </span>

                  {pos.status === "ACTIVE" &&
                    pos.remainingBalanceUsdt > 0 &&
                    (pos.awaitingSettlement ? (
                      pos.expiryPaused ? (
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-[#E85D4A]/15 px-3 py-1.5 text-xs font-semibold text-[#E85D4A]">
                          <AlertTriangle
                            className="h-3.5 w-3.5 shrink-0"
                            aria-hidden="true"
                          />
                          {t.disputedExpiryNotice}
                        </span>
                      ) : (
                        <button
                          type="button"
                          disabled={
                            !pos.canPermissionlessSettle ||
                            settlingKey === `${pos.underlying}:${pos.expiry}`
                          }
                          onClick={() => void handlePermissionlessSettle(pos)}
                          className="flex min-h-[38px] items-center gap-1.5 rounded-full bg-white px-4 py-2 text-xs font-bold text-black hover:bg-white/90 disabled:opacity-45 transition cursor-pointer"
                        >
                          {settlingKey === `${pos.underlying}:${pos.expiry}` ? (
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
                          {pos.canPermissionlessSettle
                            ? t.settleWithAtlasTwapCta
                            : t.settleWaitingDelayShort}
                        </button>
                      )
                    ) : pos.inTwapWindow ? (
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-[#E6BA5C]/15 px-3 py-1.5 text-xs font-semibold text-[#E6BA5C]">
                        <Lock
                          className="h-3.5 w-3.5 shrink-0"
                          aria-hidden="true"
                        />
                        {t.twapWindowCloseLocked}
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => handleOpenEarlyClose(pos)}
                        className="flex min-h-[38px] items-center gap-1.5 rounded-full bg-white px-4 py-2 text-xs font-bold text-black hover:bg-white/90 transition cursor-pointer"
                      >
                        <TrendingUp className="h-3.5 w-3.5" aria-hidden="true" />
                        {t.earlyCloseCta}
                      </button>
                    ))}

                  {pos.status === "SETTLED_CLAIMABLE" &&
                    pos.claimableUsdt > 0 && (
                      <button
                        type="button"
                        disabled={
                          batchClaiming ||
                          redeemingSeriesId === pos.seriesId.toLowerCase()
                        }
                        onClick={() => void handleRedeem(pos)}
                        className="flex min-h-[38px] items-center gap-1.5 rounded-full bg-white px-4 py-2 text-xs font-bold text-black hover:bg-white/90 disabled:opacity-50 transition cursor-pointer tabular-nums"
                      >
                        {redeemingSeriesId === pos.seriesId.toLowerCase() ? (
                          <Loader2
                            className="h-3.5 w-3.5 animate-spin"
                            aria-hidden="true"
                          />
                        ) : (
                          <Award className="h-3.5 w-3.5" aria-hidden="true" />
                        )}
                        {t.claimCta(pos.claimableUsdt.toFixed(2))}
                      </button>
                    )}
                </div>
              </div>
            );
          })}
        </div>
      )}

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

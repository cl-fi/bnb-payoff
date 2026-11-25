import { useState } from "react";
import {
  AlertCircle,
  Award,
  CheckCircle2,
  Clock,
  Droplets,
  ExternalLink,
  Loader2,
  ShieldCheck,
  TrendingUp,
  Wallet,
} from "lucide-react";
import {
  BSC_TESTNET,
  type CloseRfqResponse,
  type PositionView,
} from "@payoff/shared";
import { api, type HealthResponse } from "../lib/api";
import { getCopy, type Locale } from "../lib/i18n";
import {
  executeClaimTestUsdtTx,
  executeCloseTicketTx,
  executeRedeemTx,
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
}

const SLIPPAGE_TOLERANCE_RATIO = 0.985; // 1.5% adverse slippage circuit breaker
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function positionKey(pos: PositionView): string {
  return `${pos.seriesId}:${pos.isUp ? "UP" : "DOWN"}`;
}

export function PositionsPage({
  locale,
  wallet,
  health,
  positions,
  onOpenWallet,
  onGoToTrade,
  onRefresh,
}: Props) {
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

  const formatPositionError = (err: any, fallback: string): string => {
    const errName = String(
      err?.cause?.data?.errorName || err?.data?.errorName || ""
    );
    const full = `${errName} ${err?.shortMessage || ""} ${err?.message || ""}`;
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
    if (errName) {
      return `${err?.shortMessage || fallback} (${errName})`;
    }
    return String(err?.shortMessage || err?.message || fallback);
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
          locale === "zh"
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
      setFaucetErr(err?.shortMessage || err?.message || "Claim failed");
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
      locale === "zh"
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

  const handleRedeem = async (pos: PositionView) => {
    if (!health?.vaultAddress) return;
    const sidLower = pos.seriesId.toLowerCase();
    setRedeemingSeriesId(sidLower);
    setToastMsg(undefined);
    setActionErr(undefined);
    try {
      const hash = await executeRedeemTx({
        wallet,
        rpcUrl: health.rpcUrl,
        vaultAddress: health.vaultAddress,
        seriesId: pos.seriesId,
      });
      await api.ingestTx(hash).catch(() => api.syncChain());
      const combinedClaimable = positions
        .filter(
          (p) =>
            p.seriesId.toLowerCase() === sidLower &&
            p.status === "SETTLED_CLAIMABLE"
        )
        .reduce((sum, p) => sum + p.claimableUsdt, 0);
      const displayClaimed =
        combinedClaimable > 0 ? combinedClaimable : pos.claimableUsdt;
      setToastMsg(
        locale === "zh"
          ? `已领取到期结算收益 ${displayClaimed.toFixed(2)} USDT`
          : `Claimed ${displayClaimed.toFixed(2)} USDT`
      );
      onRefresh();
    } catch (err: any) {
      setActionErr(formatPositionError(err, "Claim failed"));
    } finally {
      setRedeemingSeriesId(null);
    }
  };

  if (wallet.kind === "NONE") {
    return (
      <main className="mx-auto max-w-md px-4 py-16 text-center pb-28">
        <div className="rounded-2xl border border-[#e2e5e8] bg-white p-8 space-y-4 shadow-[0_1px_2px_rgba(20,32,42,0.06)]">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-[#eef0f2] text-[#14202a]">
            <Wallet className="h-5 w-5" aria-hidden="true" />
          </div>
          <h1 className="text-lg font-bold text-[#14202a]">
            {t.positionsConnectTitle}
          </h1>
          <p className="text-xs leading-relaxed text-[#667080]">
            {t.positionsConnectDesc}
          </p>
          <button
            type="button"
            onClick={onOpenWallet}
            className="w-full min-h-[44px] rounded-lg bg-[#14202a] py-3 text-sm font-semibold text-white hover:bg-[#000a12] cursor-pointer"
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
    <main className="mx-auto max-w-4xl px-4 pt-5 pb-28 md:pb-12 sm:px-6 space-y-6">
      {/* Portfolio Hero */}
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-[#e2e5e8] pb-5">
        <div>
          <h1 className="text-xs font-semibold text-[#667080]">
            {t.portfolioValue}
          </h1>
          <div className="mt-1 inline-flex items-baseline gap-2 text-4xl font-bold tracking-[-0.03em] text-[#14202a] tabular-nums">
            <UsdtIcon size={24} className="self-center" />
            {activeTotalExit.toFixed(2)}
            <span className="text-base font-semibold text-[#667080]">USDT</span>
          </div>
          {activeTotalStake > 0 && (
            <div
              className={`mt-1 text-xs font-semibold tabular-nums ${
                activePnl >= 0 ? "text-[#0e7c72]" : "text-[#b54134]"
              }`}
            >
              {activePnl >= 0 ? "+" : ""}
              {activePnl.toFixed(2)} USDT ({activePnl >= 0 ? "+" : ""}
              {activePnlPct.toFixed(1)}%)
            </div>
          )}
        </div>
        <div className="flex items-center gap-1.5 rounded-full border border-[#e2e5e8] bg-white px-3 py-1.5 text-[11px] font-medium text-[#3a4552]">
          <span className="h-2 w-2 rounded-full bg-[#0e7c72] animate-pulse" />
          {t.liveUpdating}
        </div>
      </div>

      {toastMsg && (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center gap-2 rounded-xl bg-[#e9f3f1] px-4 py-3 text-xs font-semibold text-[#0e7c72]"
        >
          <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{toastMsg}</span>
        </div>
      )}

      {actionErr && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-xl bg-[#fbeeea] px-4 py-3 text-xs font-semibold text-[#b54134]"
        >
          <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{actionErr}</span>
        </div>
      )}

      {/* Testnet tUSDT Faucet Card inside Portfolio */}
      <section className="rounded-2xl border border-[#e2e5e8] bg-white p-5 space-y-4 shadow-[0_1px_2px_rgba(20,32,42,0.06)]">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <UsdtIcon size={20} />
              <h2 className="text-base font-bold text-[#14202a]">
                {t.faucetTitle}
              </h2>
            </div>
            <p className="mt-1 text-xs text-[#667080]">{t.faucetDesc}</p>
          </div>
          <a
            href="https://www.bnbchain.org/en/testnet-faucet"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-lg border border-[#c8ccd1] bg-white px-3 py-1.5 text-xs font-semibold text-[#14202a] hover:bg-[#f7f8f9] transition"
          >
            {t.faucetBnbLink}
            <ExternalLink className="h-3 w-3" aria-hidden="true" />
          </a>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-[#f7f8f9] border border-[#eef0f2] px-4 py-3">
          <span className="text-xs text-[#667080]">{t.faucetBalance}</span>
          <span className="inline-flex items-center gap-1.5 text-sm font-bold text-[#14202a] tabular-nums">
            <UsdtIcon size={16} />
            {wallet.usdtBalance.toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}{" "}
            tUSDT
          </span>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="flex items-center gap-1.5">
            {[1000, 5000, 10000].map((amt) => (
              <button
                key={amt}
                type="button"
                aria-pressed={faucetAmount === amt}
                onClick={() => setFaucetAmount(amt)}
                className={`rounded-lg px-3 py-2 text-xs font-semibold tabular-nums transition cursor-pointer ${
                  faucetAmount === amt
                    ? "bg-[#14202a] text-white"
                    : "bg-[#eef0f2] text-[#3a4552] hover:bg-[#e2e5e8]"
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
              className="w-full rounded-lg border border-[#c8ccd1] bg-[#f7f8f9] px-3 py-2 pr-16 text-base sm:text-sm font-semibold text-[#14202a] tabular-nums focus:border-[#14202a] focus:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#14202a]"
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-[#667080]">
              tUSDT
            </span>
          </div>

          <button
            type="button"
            disabled={faucetBusy}
            onClick={() => void handleClaimTestUsdt()}
            className="flex items-center justify-center gap-1.5 rounded-lg bg-[#14202a] px-5 py-2.5 text-xs font-semibold text-white hover:bg-[#000a12] disabled:opacity-50 transition cursor-pointer shrink-0"
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
            className="rounded-lg bg-[#fbeeea] px-3.5 py-2 text-xs font-medium text-[#b54134]"
          >
            {faucetErr}
          </div>
        )}
      </section>

      {positions.length === 0 ? (
        <div className="rounded-2xl border border-[#e2e5e8] bg-white p-10 text-center space-y-4">
          <div className="text-sm font-semibold text-[#14202a]">
            {t.noPositions}
          </div>
          <p className="text-xs text-[#667080]">{t.noPositionsDesc}</p>
          <button
            type="button"
            onClick={onGoToTrade}
            className="rounded-lg bg-[#14202a] px-6 py-2.5 text-xs font-semibold text-white hover:bg-[#000a12] cursor-pointer"
          >
            {t.goTrade}
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {positions.map((pos) => {
            const key = positionKey(pos);
            const isBull = pos.isUp;
            const statusPill =
              pos.status === "ACTIVE"
                ? { label: t.statusActive, cls: "bg-[#e9f3f1] text-[#0e7c72]" }
                : pos.status === "CLOSED_EARLY"
                  ? {
                      label: t.statusClosed,
                      cls: "bg-[#eef0f2] text-[#3a4552]",
                    }
                  : pos.status === "SETTLED_CLAIMABLE"
                    ? {
                        label: t.statusClaimable,
                        cls: "bg-[#fbf3dd] text-[#8a6410]",
                      }
                    : {
                        label: t.statusSettled,
                        cls: "bg-[#eef0f2] text-[#667080]",
                      };

            return (
              <div
                key={key}
                className="rounded-2xl border border-[#e2e5e8] bg-white p-5 space-y-4 shadow-[0_1px_2px_rgba(20,32,42,0.06)]"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`rounded px-2 py-0.5 text-[11px] font-semibold ${
                          isBull
                            ? "bg-[#e9f3f1] text-[#0e7c72]"
                            : "bg-[#fbeeea] text-[#b54134]"
                        }`}
                      >
                        {pos.underlying} {isBull ? t.bull : t.bear}
                      </span>
                      <span
                        className={`rounded px-2 py-0.5 text-[11px] font-medium ${statusPill.cls}`}
                      >
                        {statusPill.label}
                      </span>
                      {explorerBase && pos.openTxHash && (
                        <a
                          href={`${explorerBase}/tx/${pos.openTxHash}`}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-[11px] font-medium text-[#667080] hover:text-[#14202a] underline underline-offset-2"
                        >
                          BscScan
                          <ExternalLink className="h-2.5 w-2.5" aria-hidden="true" />
                        </a>
                      )}
                    </div>
                    <h2 className="mt-2 text-lg font-bold text-[#14202a] tabular-nums">
                      ${pos.startPrice.toLocaleString()} → $
                      {pos.capPrice.toLocaleString()}
                    </h2>
                  </div>

                  {pos.status === "ACTIVE" ? (
                    <div className="text-right">
                      <div className="text-[11px] font-medium text-[#667080]">
                        {t.canExitNow}
                      </div>
                      <div className="text-2xl font-bold text-[#14202a] tabular-nums">
                        {pos.indicativeExitUsdt.toFixed(2)}{" "}
                        <span className="text-xs font-semibold text-[#667080]">
                          USDT
                        </span>
                      </div>
                      <div
                        className={`text-xs font-semibold tabular-nums ${
                          pos.unrealizedPnlUsdt >= 0
                            ? "text-[#0e7c72]"
                            : "text-[#b54134]"
                        }`}
                      >
                        {pos.unrealizedPnlUsdt >= 0 ? "+" : ""}
                        {pos.unrealizedPnlUsdt.toFixed(2)} USDT (
                        {pos.unrealizedPnlPct >= 0 ? "+" : ""}
                        {pos.unrealizedPnlPct.toFixed(1)}%)
                      </div>
                    </div>
                  ) : pos.status === "SETTLED_CLAIMABLE" ? (
                    <div className="text-right">
                      <div className="text-[11px] text-[#8a6410] font-medium">
                        {t.claimable}
                      </div>
                      <div className="text-2xl font-bold text-[#0e7c72] tabular-nums">
                        {pos.claimableUsdt.toFixed(2)} USDT
                      </div>
                    </div>
                  ) : (
                    <div className="text-right">
                      <div className="text-[11px] text-[#667080]">
                        {t.realized}
                      </div>
                      <div className="text-xl font-bold text-[#14202a] tabular-nums">
                        {(
                          pos.earlyCloseProceedsUsdt + pos.redeemedUsdt
                        ).toFixed(2)}{" "}
                        USDT
                      </div>
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-3 rounded-xl bg-[#f7f8f9] border border-[#eef0f2] p-3.5 text-xs sm:grid-cols-4">
                  <div>
                    <div className="text-[#667080]">{t.numStake}</div>
                    <div className="mt-0.5 font-semibold text-[#14202a] tabular-nums">
                      {pos.totalStakeUsdt.toFixed(2)} USDT
                    </div>
                  </div>
                  <div>
                    <div className="text-[#667080]">{t.numBreakeven}</div>
                    <div className="mt-0.5 font-semibold text-[#14202a] tabular-nums">
                      ${pos.breakevenPrice.toLocaleString()}
                    </div>
                  </div>
                  <div>
                    <div className="text-[#667080]">{t.numCapPayout}</div>
                    <div className="mt-0.5 font-semibold text-[#0e7c72] tabular-nums">
                      {(pos.status === "ACTIVE" ||
                      pos.status === "SETTLED_CLAIMABLE"
                        ? pos.remainingBalanceUsdt
                        : pos.initialMaxPayoutUsdt
                      ).toFixed(2)}{" "}
                      USDT
                    </div>
                  </div>
                  <div>
                    <div className="text-[#667080]">{t.numExpiry}</div>
                    <div className="mt-0.5 flex items-center gap-1 font-medium text-[#3a4552] tabular-nums">
                      <Clock
                        className="h-3 w-3 text-[#667080]"
                        aria-hidden="true"
                      />
                      {pos.expiryIso.slice(5, 16).replace("T", " ")} UTC
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                  <span className="flex items-center gap-1.5 text-[11px] text-[#667080]">
                    <ShieldCheck
                      className="h-3.5 w-3.5 text-[#0e7c72]"
                      aria-hidden="true"
                    />
                    {t.holdNotice}
                  </span>

                  {pos.status === "ACTIVE" && pos.remainingBalanceUsdt > 0 && (
                    <button
                      type="button"
                      onClick={() => handleOpenEarlyClose(pos)}
                      className="flex items-center gap-1.5 rounded-lg bg-[#14202a] px-4 py-2 text-xs font-semibold text-white hover:bg-[#000a12] transition cursor-pointer"
                    >
                      <TrendingUp className="h-3.5 w-3.5" aria-hidden="true" />
                      {t.earlyCloseCta}
                    </button>
                  )}

                  {pos.status === "SETTLED_CLAIMABLE" && (
                    <button
                      type="button"
                      disabled={
                        redeemingSeriesId === pos.seriesId.toLowerCase()
                      }
                      onClick={() => handleRedeem(pos)}
                      className="flex items-center gap-1.5 rounded-lg bg-[#14202a] px-4 py-2 text-xs font-semibold text-white hover:bg-[#000a12] disabled:opacity-50 transition cursor-pointer"
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

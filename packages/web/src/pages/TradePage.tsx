import { useEffect, useRef, useState } from "react";
import { Clock, ShieldCheck } from "lucide-react";
import {
  BSC_TESTNET,
  type AtlasFeedTelemetry,
  type CandleBar,
  type CandlePoint,
  type Direction,
  type ExpiryTenor,
  type TicketSummary,
  type UnderlyingSymbol,
} from "@payoff/shared";
import {
  api,
  type ConsensusGuardState,
  type HealthResponse,
  type ShelfResponse,
} from "../lib/api";
import { getCopy, type Locale } from "../lib/i18n";
import {
  createClientForRpc,
  ensureUsdtApproval,
  executeOpenTicketTx,
  extractWalletErrorMessage,
  type ConnectedWallet,
} from "../lib/wallet";
import { AtlasOracleBadge } from "../components/AtlasOracleBadge";
import { KlineChart } from "../components/KlineChart";
import { LinearPayoffChart } from "../components/LinearPayoffChart";
import { MarketRulesAccordion } from "../components/MarketRulesAccordion";
import {
  OrderTicketPanel,
  type InstantBuyStage,
  type SlippagePauseState,
} from "../components/OrderTicketPanel";

interface Props {
  locale: Locale;
  wallet: ConnectedWallet;
  health?: HealthResponse;
  rpcUrl: string;
  liveSpots: Record<UnderlyingSymbol, { spot: number; change24hPct: number }>;
  liveTelemetry: Partial<Record<UnderlyingSymbol, AtlasFeedTelemetry>>;
  liveCircuitBreaker: Partial<Record<UnderlyingSymbol, ConsensusGuardState>>;
  onOpenWallet: () => void;
  onTxSuccess: () => void;
  onGoToPositions: () => void;
}

const SLIPPAGE_TOLERANCE_RATIO = 0.985; // 1.5% adverse slippage circuit breaker
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function getTargetKey(t: Pick<TicketSummary, "lowerStrike" | "upperStrike">) {
  return `${t.lowerStrike}-${t.upperStrike}`;
}

function formatSettlementCountdown(
  expirySec: number | undefined,
  nowSec: number,
  settledLabel: string
): string {
  if (!expirySec) return "--:--:--";
  const remaining = Math.max(0, expirySec - nowSec);
  if (remaining === 0) return settledLabel;
  const days = Math.floor(remaining / 86400);
  const hours = Math.floor((remaining % 86400) / 3600);
  const mins = Math.floor((remaining % 3600) / 60);
  const secs = remaining % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (days > 0) {
    return `${days}d ${pad(hours)}:${pad(mins)}:${pad(secs)}`;
  }
  return `${pad(hours)}:${pad(mins)}:${pad(secs)}`;
}

export function TradePage({
  locale,
  wallet,
  health,
  rpcUrl,
  liveSpots,
  liveTelemetry,
  liveCircuitBreaker,
  onOpenWallet,
  onTxSuccess,
  onGoToPositions,
}: Props) {
  const t = getCopy(locale);
  const [underlying, setUnderlying] = useState<UnderlyingSymbol>("BTC");
  const [direction, setDirection] = useState<Direction>("BULL");
  const [tenor, setTenor] = useState<ExpiryTenor>("DAILY");
  const [stakeUsdt, setStakeUsdt] = useState<number>(20);
  const [bar, setBar] = useState<CandleBar>("15m");
  const [candles, setCandles] = useState<CandlePoint[]>([]);

  const [shelf, setShelf] = useState<ShelfResponse | null>(null);
  const [selectedTargetKey, setSelectedTargetKey] = useState<string>("");

  const [stage, setStage] = useState<InstantBuyStage>("IDLE");
  const [slippagePause, setSlippagePause] = useState<
    SlippagePauseState | undefined
  >();
  const [txHash, setTxHash] = useState<string | undefined>();
  const [errorMsg, setErrorMsg] = useState<string | undefined>();
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));

  const contractsRef = useRef<{
    vaultAddress?: `0x${string}`;
    usdtAddress?: `0x${string}`;
  }>({});
  const stageRef = useRef<InstantBuyStage>(stage);
  stageRef.current = stage;

  useEffect(() => {
    if (health) {
      contractsRef.current = {
        vaultAddress: health.vaultAddress,
        usdtAddress:
          health.usdtAddress && health.usdtAddress !== ZERO_ADDRESS
            ? health.usdtAddress
            : BSC_TESTNET.usdtAddress,
      };
    }
  }, [health]);

  // Live 1-second settlement countdown ticker
  useEffect(() => {
    const id = setInterval(() => {
      setNowSec(Math.floor(Date.now() / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // Candles feed (Binance K-lines cold-start anchored to live Atlas spot)
  useEffect(() => {
    let cancelled = false;
    const loadCandles = () => {
      api
        .getCandles({ underlying, bar, limit: 120 })
        .then((res) => {
          if (!cancelled) setCandles(res.candles);
        })
        .catch(() => {});
    };
    loadCandles();
    const timer = setInterval(loadCandles, 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [underlying, bar]);

  // Fixed-grid shelf feed
  useEffect(() => {
    let cancelled = false;
    const loadShelf = (isBackground: boolean) => {
      if (isBackground && stageRef.current !== "IDLE") return;
      api
        .getShelf({ underlying, direction, tenor, stakeUsdt })
        .then((res) => {
          if (cancelled) return;
          setShelf(res);
          if (!isBackground) {
            setSlippagePause(undefined);
            setStage("IDLE");
            setErrorMsg(undefined);
          }
        })
        .catch((err) => {
          if (!cancelled && !isBackground) setErrorMsg(err.message);
        });
    };
    loadShelf(false);
    const timer = setInterval(() => loadShelf(true), 25_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [underlying, direction, tenor, stakeUsdt]);

  const defaultIdx = Math.min(
    Math.max(0, shelf?.grid?.defaultIndex ?? 1),
    Math.max(0, (shelf?.tiers.length ?? 1) - 1)
  );
  const isShelfSynced = Boolean(
    shelf &&
      shelf.underlying === underlying &&
      shelf.direction === direction &&
      shelf.tenor === tenor &&
      Math.abs(shelf.stakeUsdt - stakeUsdt) < 1e-6
  );
  const activeTicket: TicketSummary | undefined =
    shelf?.tiers.find((item) => getTargetKey(item) === selectedTargetKey) ??
    shelf?.tiers[defaultIdx] ??
    shelf?.tiers[0];
  const effectiveTargetKey = activeTicket ? getTargetKey(activeTicket) : "";

  const resetFlowState = () => {
    setSlippagePause(undefined);
    setStage("IDLE");
    setTxHash(undefined);
    setErrorMsg(undefined);
  };

  const handleSwitchUnderlying = (u: UnderlyingSymbol) => {
    if (u === underlying) return;
    setUnderlying(u);
    setSelectedTargetKey("");
    resetFlowState();
  };

  const handleSwitchDirection = (dir: Direction) => {
    if (dir === direction) return;
    setDirection(dir);
    setSelectedTargetKey("");
    resetFlowState();
  };

  const handleSwitchTenor = (nextTenor: ExpiryTenor) => {
    if (nextTenor === tenor) return;
    setTenor(nextTenor);
    setSelectedTargetKey("");
    resetFlowState();
  };

  const handleSelectTarget = (item: TicketSummary) => {
    setSelectedTargetKey(getTargetKey(item));
    resetFlowState();
  };

  const formatTradeError = (err: any, fallback: string): string => {
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

  const fillOpenRfqOnChain = async (
    rfq: SlippagePauseState["rfq"],
    sharedClient?: ReturnType<typeof createClientForRpc>
  ) => {
    if (rfq.quote.validUntil <= Math.floor(Date.now() / 1000)) {
      throw new Error("QuoteExpired");
    }
    setStage("FILLING");
    setErrorMsg(undefined);
    const hash = await executeOpenTicketTx({
      wallet,
      rpcUrl,
      rfq,
      onStage: (st) => setStage(st === "APPROVING" ? "APPROVING" : "FILLING"),
      publicClient: sharedClient,
    });
    setSlippagePause(undefined);
    setTxHash(hash);
    setStage("SUCCESS");
    await api.ingestTx(hash).catch(() => api.syncChain());
    onTxSuccess();
  };

  /**
   * Seamless 1-Click Open RFQ:
   * 1) Pre-check & confirm ERC20 USDT approval BEFORE requesting `/api/rfq/open` so the full 45s TTL goes to `fillOpenQuote`.
   * 2) Fetch fresh 45s firm EIP-712 quote from the protocol RFQ router.
   * 3) 1.5% adverse slippage circuit breaker: if firm maxPayout >= preview * 0.985, execute immediately;
   *    otherwise pause with inline updated-price confirmation & live 45s countdown.
   */
  const handleInstantBuy = async () => {
    if (!wallet.address || !activeTicket || !isShelfSynced) return;
    setErrorMsg(undefined);
    setTxHash(undefined);
    setSlippagePause(undefined);

    const previewMaxPayoutUsdt = activeTicket.maxPayoutUsdt;

    try {
      const publicClient = createClientForRpc(wallet.chainId, rpcUrl);
      let { vaultAddress, usdtAddress } = contractsRef.current;
      if (!vaultAddress || !usdtAddress || usdtAddress === ZERO_ADDRESS) {
        const h = await api.getHealth();
        vaultAddress = h.vaultAddress;
        usdtAddress =
          h.usdtAddress && h.usdtAddress !== ZERO_ADDRESS
            ? h.usdtAddress
            : BSC_TESTNET.usdtAddress;
        contractsRef.current = { vaultAddress, usdtAddress };
      }

      if (
        vaultAddress &&
        vaultAddress !== ZERO_ADDRESS &&
        usdtAddress &&
        usdtAddress !== ZERO_ADDRESS
      ) {
        await ensureUsdtApproval({
          wallet,
          rpcUrl,
          usdtAddress,
          spender: vaultAddress,
          amountUsdt: stakeUsdt,
          onApproving: () => setStage("APPROVING"),
          publicClient,
        });
      }

      setStage("QUOTING");
      const rfq = await api.requestOpenRfq({
        taker: wallet.address,
        underlying,
        direction,
        tenor,
        tierKind: activeTicket.tierKind,
        lowerStrike: activeTicket.lowerStrike,
        upperStrike: activeTicket.upperStrike,
        stakeUsdt,
      });

      const firmMaxPayoutUsdt = rfq.ticket.maxPayoutUsdt;
      if (
        previewMaxPayoutUsdt > 0 &&
        firmMaxPayoutUsdt < previewMaxPayoutUsdt * SLIPPAGE_TOLERANCE_RATIO
      ) {
        const dropPct =
          ((previewMaxPayoutUsdt - firmMaxPayoutUsdt) / previewMaxPayoutUsdt) *
          100;
        setSlippagePause({
          rfq,
          previewMaxPayoutUsdt,
          firmMaxPayoutUsdt,
          dropPct,
        });
        setStage("SLIPPAGE_CONFIRM");
        return;
      }

      await fillOpenRfqOnChain(rfq, publicClient);
    } catch (err: any) {
      setStage("IDLE");
      setErrorMsg(formatTradeError(err, "Transaction failed"));
    }
  };

  const handleConfirmSlippageQuote = async () => {
    if (!slippagePause) return;
    try {
      await fillOpenRfqOnChain(slippagePause.rfq);
    } catch (err: any) {
      setStage("SLIPPAGE_CONFIRM");
      setErrorMsg(formatTradeError(err, "Transaction failed"));
    }
  };

  const isTradeBusy =
    stage === "APPROVING" || stage === "QUOTING" || stage === "FILLING";
  const displaySpot =
    liveSpots[underlying]?.spot ||
    shelf?.spot ||
    (underlying === "BTC" ? 68000 : 2500);
  const displayChg =
    liveSpots[underlying]?.change24hPct ?? shelf?.change24hPct ?? 0;
  const priceChangeAbs = displaySpot * (displayChg / 100);
  const isUp = displayChg >= 0;
  const isBull = direction === "BULL";
  const startLinePrice =
    shelf?.grid?.anchorStartPrice ?? activeTicket?.startPrice;
  const countdownText = formatSettlementCountdown(
    shelf?.expiry,
    nowSec,
    t.settledNow
  );

  const activeTelemetry =
    liveTelemetry[underlying] ??
    health?.atlasTelemetry?.[underlying] ??
    shelf?.atlasTelemetry;
  const activeGuard =
    liveCircuitBreaker[underlying] ??
    health?.settlementCircuitBreaker?.[underlying] ??
    shelf?.quotingGuard;
  const quotingPaused = activeGuard?.quotingSafe === false;

  return (
    <main className="mx-auto max-w-6xl px-4 pt-5 pb-28 md:pb-12 sm:px-6">
      <div className="grid grid-cols-1 gap-7 lg:grid-cols-12">
        {/* Main Column (8 cols) */}
        <div className="lg:col-span-8 space-y-5">
          {/* Top Bar: Asset [BTC | ETH] + Tenor [24H Daily | 7D Weekly] + Zero Liquidation Badge */}
          <div className="flex flex-wrap items-center justify-between gap-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <div
                className="inline-flex items-center rounded-lg bg-[#eef0f2] p-0.5"
                role="group"
                aria-label="Asset"
              >
                {(["BTC", "ETH"] as UnderlyingSymbol[]).map((u) => {
                  const active = underlying === u;
                  return (
                    <button
                      key={u}
                      type="button"
                      disabled={isTradeBusy}
                      aria-pressed={active}
                      onClick={() => handleSwitchUnderlying(u)}
                      className={`min-h-[34px] rounded-md px-3.5 py-1 text-xs font-semibold transition cursor-pointer disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#14202a] ${
                        active
                          ? "bg-white text-[#14202a] shadow-xs"
                          : "text-[#667080] hover:text-[#14202a]"
                      }`}
                    >
                      {u}
                    </button>
                  );
                })}
              </div>

              <div
                className="inline-flex items-center rounded-lg bg-[#eef0f2] p-0.5"
                role="group"
                aria-label="Tenor"
              >
                {(
                  [
                    { id: "DAILY", label: t.tenorDailyPill },
                    { id: "WEEKLY", label: t.tenorWeeklyPill },
                  ] as const
                ).map((item) => {
                  const active = tenor === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      disabled={isTradeBusy}
                      aria-pressed={active}
                      onClick={() => handleSwitchTenor(item.id)}
                      className={`min-h-[34px] rounded-md px-3.5 py-1 text-xs font-semibold transition cursor-pointer disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#14202a] ${
                        active
                          ? "bg-white text-[#14202a] shadow-xs"
                          : "text-[#667080] hover:text-[#14202a]"
                      }`}
                    >
                      {item.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <span className="inline-flex items-center gap-1.5 rounded-full bg-[#e9f3f1] px-3 py-1 text-[11px] font-semibold text-[#0e7c72]">
              <ShieldCheck className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>{t.zeroLiqBadge}</span>
            </span>
          </div>

          {/* Market Event Header: Title, Live Atlas Spot, Start Line, Countdown, & Live Atlas Oracle Shield */}
          <section className="rounded-2xl border border-[#e2e5e8] bg-white p-4 sm:p-5 shadow-[0_1px_2px_rgba(20,32,42,0.04)] space-y-3.5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h1 className="text-lg sm:text-xl font-bold tracking-tight text-[#14202a]">
                  {t.eventTitle(underlying, tenor === "DAILY")}
                </h1>
                <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="text-3xl sm:text-4xl font-bold tracking-[-0.03em] text-[#14202a] tabular-nums leading-none">
                    $
                    {displaySpot.toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </span>
                  <span
                    className={`text-xs font-semibold tabular-nums ${
                      isUp ? "text-[#0e7c72]" : "text-[#b54134]"
                    }`}
                  >
                    {isUp ? "+" : "−"}$
                    {Math.abs(priceChangeAbs).toLocaleString(undefined, {
                      maximumFractionDigits: 2,
                    })}{" "}
                    ({isUp ? "+" : ""}
                    {displayChg.toFixed(2)}%)
                  </span>
                  <span className="text-xs text-[#667080]">{t.past24h}</span>
                </div>
              </div>

              {/* Start Line Badge & Live 1-Second Settlement Countdown */}
              <div className="flex flex-wrap items-center gap-2">
                {startLinePrice !== undefined && (
                  <div
                    className={`inline-flex flex-col rounded-xl border px-3 py-1.5 ${
                      isBull
                        ? "border-[#bfe2dc] bg-[#e9f3f1]/70 text-[#0e7c72]"
                        : "border-[#f1ccc6] bg-[#fbeeea]/70 text-[#b54134]"
                    }`}
                  >
                    <span className="text-[10px] font-semibold uppercase tracking-wide opacity-80">
                      {t.startLineLabel}
                    </span>
                    <span className="text-sm font-bold tabular-nums">
                      ${startLinePrice.toLocaleString()}
                    </span>
                  </div>
                )}

                <div className="inline-flex flex-col rounded-xl border border-[#e2e5e8] bg-[#f7f8f9] px-3 py-1.5">
                  <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-[#667080]">
                    <Clock className="h-3 w-3" aria-hidden="true" />
                    {t.settlesCountdownLabel}
                  </span>
                  <span className="text-sm font-bold text-[#14202a] tabular-nums">
                    {countdownText}
                  </span>
                </div>
              </div>
            </div>

            {/* Atlas Oracle Live Shield (Enterprise ConsensusScore + ECDSA Verifier) */}
            <AtlasOracleBadge
              locale={locale}
              underlying={underlying}
              telemetry={activeTelemetry}
              guard={activeGuard}
              signerAddress={health?.atlasSignerAddress}
              oracleAddress={health?.settlementOracleAddress}
              variant="compact"
            />
          </section>

          {/* TradingView Lightweight Charts v5 K-line (Binance historical cold-start anchored to Atlas live spot) */}
          <KlineChart
            locale={locale}
            candles={candles}
            bar={bar}
            onChangeBar={setBar}
            ticket={activeTicket}
            liveSpot={displaySpot}
          />

          {/* Linear Payoff Ladder Chart */}
          {activeTicket && (
            <LinearPayoffChart
              locale={locale}
              underlying={underlying}
              direction={direction}
              spot={displaySpot}
              ticket={activeTicket}
              gridStep={shelf?.grid?.gridStep}
            />
          )}

          {/* Settlement Rules & Atlas Oracle Security Accordion */}
          {shelf && (
            <MarketRulesAccordion
              locale={locale}
              underlying={underlying}
              direction={direction}
              tenor={tenor}
              expiryIso={shelf.expiryIso}
              ticket={activeTicket}
              grid={shelf.grid}
              atlasTelemetry={activeTelemetry}
              consensusGuard={activeGuard}
              signerAddress={health?.atlasSignerAddress}
              oracleAddress={health?.settlementOracleAddress}
            />
          )}
        </div>

        {/* Sticky Order Checkout Card (4 cols) */}
        <aside className="lg:col-span-4">
          {activeTicket && shelf ? (
            <OrderTicketPanel
              locale={locale}
              direction={direction}
              onChangeDirection={handleSwitchDirection}
              tiers={shelf.tiers}
              selectedTargetKey={effectiveTargetKey}
              onSelectTarget={handleSelectTarget}
              ticket={activeTicket}
              grid={shelf.grid}
              stakeUsdt={stakeUsdt}
              onChangeStake={(val) => {
                setStakeUsdt(val);
                if (stage === "SLIPPAGE_CONFIRM" || stage === "SUCCESS") {
                  resetFlowState();
                }
              }}
              walletConnected={wallet.kind !== "NONE"}
              usdtBalance={wallet.usdtBalance}
              isShelfSynced={isShelfSynced}
              quotingPaused={quotingPaused}
              stage={stage}
              slippagePause={slippagePause}
              txHash={txHash}
              errorMsg={errorMsg}
              onOpenWallet={onOpenWallet}
              onInstantBuy={() => void handleInstantBuy()}
              onConfirmSlippageQuote={() => void handleConfirmSlippageQuote()}
              onRefreshSlippageQuote={() => void handleInstantBuy()}
              onCancelFlow={resetFlowState}
              onGoToPositions={onGoToPositions}
            />
          ) : (
            <div className="rounded-2xl border border-[#e2e5e8] bg-white p-5 space-y-4 animate-pulse">
              <div className="grid grid-cols-2 gap-2">
                <div className="h-12 rounded-xl bg-[#eef0f2]" />
                <div className="h-12 rounded-xl bg-[#eef0f2]" />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="h-14 rounded-xl bg-[#f7f8f9]" />
                <div className="h-14 rounded-xl bg-[#f7f8f9]" />
                <div className="h-14 rounded-xl bg-[#f7f8f9]" />
                <div className="h-14 rounded-xl bg-[#f7f8f9]" />
              </div>
              <div className="h-12 rounded-xl bg-[#eef0f2]" />
              <div className="h-12 rounded-xl bg-[#14202a]/15" />
            </div>
          )}
        </aside>
      </div>
    </main>
  );
}

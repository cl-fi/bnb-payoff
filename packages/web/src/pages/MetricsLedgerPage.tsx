import { useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowLeftRight,
  BarChart3,
  CheckCircle2,
  Coins,
  ExternalLink,
  Radio,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import {
  ASSET_SPECS,
  ATLAS_FEEDS,
  ATLAS_OFFICIAL_SIGNER,
  BSC_TESTNET,
  SUPPORTED_UNDERLYINGS,
  type AtlasConsensusStatus,
  type HedgeLedgerEntry,
  type Phase1Metrics,
  type RwaAssetTelemetry,
  type RwaIvSource,
  type RwaMarketSession,
} from "@payoff/shared";
import {
  api,
  type HealthResponse,
  type OracleConsensusResponse,
  type SettlementHistoryRecord,
} from "../lib/api";
import { formatSettlementClock, formatStrikeNumber } from "../lib/format";

function formatScorePct(score: number | null | undefined): string {
  if (score === null || score === undefined || !Number.isFinite(score)) {
    return "--";
  }
  const pct = score <= 1 ? score * 100 : score;
  return `${Math.round(pct)}%`;
}

function formatPrice(val: number | null | undefined): string {
  if (val === null || val === undefined || !Number.isFinite(val)) return "--";
  return `$${val.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatVolatility(val: number | null | undefined): string {
  if (val === null || val === undefined || !Number.isFinite(val)) return "--";
  const pct = val <= 2 ? val * 100 : val;
  return `${pct.toFixed(2)}%`;
}

function isValidTxHash(hash?: string | null): hash is `0x${string}` {
  return Boolean(hash && /^0x[0-9a-fA-F]{64}$/.test(hash));
}

function statusPillClasses(status: AtlasConsensusStatus): string {
  switch (status) {
    case "HEALTHY":
      return "border-emerald-500/40 bg-emerald-500/15 text-emerald-300";
    case "DEGRADED":
    case "WARNING":
      return "border-amber-500/40 bg-amber-500/15 text-amber-300";
    case "CRITICAL":
    case "SPLIT_MARKET":
      return "border-rose-500/40 bg-rose-500/15 text-rose-300";
    default:
      return "border-slate-700 bg-slate-800/80 text-slate-400";
  }
}

function sessionBadgeClasses(session: RwaMarketSession): string {
  switch (session) {
    case "RTH":
      return "border-emerald-500/40 bg-emerald-500/15 text-emerald-300";
    case "EXTENDED":
      return "border-amber-500/40 bg-amber-500/15 text-amber-300";
    default:
      return "border-slate-700 bg-slate-800/80 text-slate-300";
  }
}

function ivSourceBadgeClasses(source: RwaIvSource): string {
  switch (source) {
    case "THETADATA_LIVE":
      return "border-emerald-500/40 bg-emerald-500/15 text-emerald-300";
    case "THETADATA_CACHED":
      return "border-sky-500/40 bg-sky-500/15 text-sky-300";
    default:
      return "border-slate-700 bg-slate-800/80 text-slate-300";
  }
}

export function MetricsLedgerPage() {
  const [metrics, setMetrics] = useState<Phase1Metrics | null>(null);
  const [ledger, setLedger] = useState<HedgeLedgerEntry[]>([]);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [consensus, setConsensus] = useState<OracleConsensusResponse | null>(
    null
  );
  const [settlements, setSettlements] = useState<SettlementHistoryRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const [m, l, h, c, ...histResults] = await Promise.all([
        api.getMetrics(),
        api.getLedger(50),
        api.getHealth().catch(() => null),
        api.getOracleConsensus().catch(() => null),
        ...SUPPORTED_UNDERLYINGS.map((sym) =>
          api.getSettlementHistory(sym, 5).catch(() => null)
        ),
      ]);
      setMetrics(m);
      setLedger(l.entries);
      setHealth(h);
      setConsensus(c);
      const merged = histResults
        .flatMap((res) => res?.records || [])
        .sort((a, b) => b.expiry - a.expiry);
      setSettlements(merged.slice(0, 15));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const totalTiers = metrics
    ? Object.values(metrics.tierDistribution).reduce((a, b) => a + b, 0)
    : 0;

  const explorerBase =
    BSC_TESTNET.explorerUrl || "https://testnet.bscscan.com";
  const oracleAddr =
    consensus?.oracleAddress || health?.settlementOracleAddress;
  const signerAddr =
    consensus?.signerAddress ||
    health?.atlasSignerAddress ||
    ATLAS_OFFICIAL_SIGNER;

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-white">
            Protocol Ops · Vault Solvency, Mock Market Maker &amp; Atlas
            ConsensusScore Monitor
          </h1>
          <p className="text-xs text-slate-400">
            BNB Smart Chain Testnet (Chain ID {health?.chainId ?? 97}) · 100%
            On-Chain USDT Solvency, Put-Call Parity Mock Maker Ledger &amp;
            Atlas Pull Oracle Circuit Breaker
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-900 px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800 cursor-pointer"
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
          />
          Refresh On-Chain &amp; Atlas Data
        </button>
      </div>

      {/* Vault Solvency Banner */}
      {metrics && (
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-emerald-500/30 bg-emerald-500/[0.07] p-4">
          <div className="flex items-center gap-3">
            <ShieldCheck className="h-6 w-6 text-emerald-400 shrink-0" />
            <div>
              <div className="text-sm font-bold text-white flex flex-wrap items-center gap-2">
                <span>Vault 100% Collateralized Solvency Check:</span>
                <span className="text-emerald-400">
                  {metrics.isVaultSolvent ? "FULLY SOLVENT" : "ALERT"}
                </span>
                {health?.vaultAddress && (
                  <a
                    href={`${explorerBase}/address/${health.vaultAddress}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 rounded bg-slate-900/70 px-2 py-0.5 font-mono text-[10px] font-medium text-slate-300 hover:text-white"
                  >
                    {health.vaultAddress.slice(0, 6)}...
                    {health.vaultAddress.slice(-4)}
                    <ExternalLink className="h-2.5 w-2.5" />
                  </a>
                )}
              </div>
              <div className="text-xs text-slate-300 tabular-nums mt-0.5">
                Vault USDT Balance: {metrics.vaultBalanceUsdt.toFixed(2)} USDT ·
                Locked Positions: {metrics.vaultLockedUsdt.toFixed(2)} USDT ·
                Mock Maker Margin: {metrics.vaultMakerMarginUsdt.toFixed(2)}{" "}
                USDT · Protocol Fees:{" "}
                {metrics.vaultAccruedProtocolFeesUsdt.toFixed(2)} USDT
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-1.5 text-xs">
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
            <span className="text-slate-300">
              Protocol Open Fee Cap (≤5%): Current Avg{" "}
              <strong className="text-emerald-400 tabular-nums">
                {(metrics.avgProtocolFeeBps / 100).toFixed(2)}%
              </strong>
            </span>
          </div>
        </div>
      )}

      {/* Atlas Enterprise ConsensusScore & Settlement Circuit Breaker Monitor */}
      <section className="rounded-2xl border border-slate-800 bg-[#101622] p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <Radio className="h-5 w-5 text-emerald-400" />
            <div>
              <h2 className="text-sm font-bold text-white">
                Atlas Enterprise ConsensusScore &amp; Settlement Circuit Breaker
                Monitor
              </h2>
              <p className="text-[11px] text-slate-400">
                Permissionless Pull Oracle (<code className="font-mono text-slate-300">AtlasPullSettlementOracle</code>) · ECDSA
                Signer{" "}
                <a
                  href={`${explorerBase}/address/${signerAddr}`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-slate-300 underline underline-offset-2 hover:text-white"
                >
                  {signerAddr.slice(0, 6)}...{signerAddr.slice(-5)}
                </a>
                {oracleAddr &&
                  oracleAddr !==
                    "0x0000000000000000000000000000000000000000" && (
                    <>
                      {" · "}Oracle Contract{" "}
                      <a
                        href={`${explorerBase}/address/${oracleAddr}`}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono text-slate-300 underline underline-offset-2 hover:text-white"
                      >
                        {oracleAddr.slice(0, 6)}...{oracleAddr.slice(-4)}
                      </a>
                    </>
                  )}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 text-xs">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${
                consensus?.wsConnected
                  ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
                  : "border-slate-700 bg-slate-900 text-slate-300"
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  consensus?.wsConnected
                    ? "bg-emerald-400 animate-pulse"
                    : "bg-slate-400"
                }`}
              />
              {consensus?.wsConnected
                ? "Atlas Push WS Live"
                : health?.dataSourceStatus ||
                  health?.dataSource ||
                  "HTTP Fallback"}
            </span>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {SUPPORTED_UNDERLYINGS.map((sym) => {
            const spec = ASSET_SPECS[sym];
            const isRwa = spec.assetClass === "RWA_EQUITY";
            const feed = ATLAS_FEEDS[sym];
            const tel =
              consensus?.telemetry?.[sym] ?? health?.atlasTelemetry?.[sym];
            const rwa: RwaAssetTelemetry | undefined =
              consensus?.rwaTelemetry?.[sym] ?? health?.rwaTelemetry?.[sym];
            const guard =
              consensus?.circuitBreaker?.[sym] ??
              health?.settlementCircuitBreaker?.[sym];
            const status: AtlasConsensusStatus =
              tel?.consensusStatus ?? guard?.consensusStatus ?? "UNKNOWN";
            const score = tel?.consensusScore ?? guard?.consensusScore ?? null;
            const scorePct =
              score === null || !Number.isFinite(score)
                ? 0
                : Math.max(0, Math.min(100, score <= 1 ? score * 100 : score));
            const rwaBreakerActive = Boolean(
              rwa && (rwa.splitGuardTriggered || rwa.corporateActionBlackout)
            );
            const quotingHalted = guard?.quotingSafe === false || rwaBreakerActive;
            const rwaClock = formatSettlementClock(
              rwa?.settlementUtcHour ?? spec.settlementUtcHour
            );
            const thetaIvText =
              rwa?.thetaAtmIv !== null &&
              rwa?.thetaAtmIv !== undefined &&
              Number.isFinite(rwa.thetaAtmIv)
                ? `${(rwa.thetaAtmIv <= 5 ? rwa.thetaAtmIv * 100 : rwa.thetaAtmIv).toFixed(1)}%`
                : "--";

            return (
              <div
                key={sym}
                className="rounded-xl border border-slate-800 bg-slate-950/60 p-4 space-y-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="flex flex-wrap items-center gap-1.5 text-sm font-bold text-white tabular-nums">
                      <span>
                        #{tel?.feedId || feed.feedId} · {feed.pair}
                      </span>
                      {isRwa && (
                        <span className="rounded border border-teal-500/40 bg-teal-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-teal-300">
                          RWA
                        </span>
                      )}
                      <span className="font-mono text-[11px] font-normal text-slate-400">
                        ({tel?.feedIdHex || feed.feedIdHex})
                      </span>
                    </div>
                    <div className="text-lg font-black text-white tabular-nums mt-0.5">
                      {formatPrice(tel?.price ?? health?.spots?.[sym])}
                    </div>
                  </div>
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-bold tabular-nums ${statusPillClasses(
                      status
                    )}`}
                  >
                    {status === "CRITICAL" || status === "SPLIT_MARKET" ? (
                      <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />
                    ) : status === "WARNING" || status === "DEGRADED" ? (
                      <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                    ) : (
                      <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
                    )}
                    {status} · {formatScorePct(score)}
                  </span>
                </div>

                <div className="h-1.5 w-full rounded-full bg-slate-800 overflow-hidden">
                  <div
                    className={`h-full rounded-full ${
                      status === "HEALTHY"
                        ? "bg-emerald-400"
                        : status === "DEGRADED" || status === "WARNING"
                          ? "bg-amber-400"
                          : status === "CRITICAL" || status === "SPLIT_MARKET"
                            ? "bg-rose-400"
                            : "bg-slate-500"
                    }`}
                    style={{ width: `${scorePct}%` }}
                  />
                </div>

                <div className="grid grid-cols-3 gap-2 text-xs tabular-nums">
                  <div className="rounded-lg bg-slate-900/90 px-2.5 py-2">
                    <div className="text-[10px] text-slate-400">TWAP</div>
                    <div className="font-semibold text-slate-200 mt-0.5">
                      {formatPrice(tel?.twapPrice)}
                    </div>
                  </div>
                  <div className="rounded-lg bg-slate-900/90 px-2.5 py-2">
                    <div className="text-[10px] text-slate-400">Median</div>
                    <div className="font-semibold text-slate-200 mt-0.5">
                      {formatPrice(tel?.medianPrice)}
                    </div>
                  </div>
                  <div className="rounded-lg bg-slate-900/90 px-2.5 py-2">
                    <div className="flex items-center gap-1 text-[10px] text-slate-400">
                      <Activity className="h-3 w-3" aria-hidden="true" />
                      Volatility
                    </div>
                    <div className="font-semibold text-slate-200 mt-0.5">
                      {formatVolatility(tel?.priceVolatility)}
                    </div>
                  </div>
                </div>

                {/* RWA Risk & Hedge Telemetry Block (NVDAB) */}
                {isRwa && (
                  <div className="rounded-lg border border-teal-500/25 bg-slate-900/80 p-3 space-y-2.5 text-[11px] tabular-nums">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-bold text-teal-300 uppercase tracking-wider text-[10px]">
                        RWA Risk &amp; Hedge Telemetry
                      </span>
                      <span
                        className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold ${sessionBadgeClasses(
                          rwa?.session ?? "EXTENDED"
                        )}`}
                      >
                        {rwa?.session ?? "EXTENDED"} · {rwaClock.utcLabel} · US
                        Close
                      </span>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <div className="rounded-md bg-slate-950/70 px-2.5 py-1.5">
                        <div className="text-[10px] text-slate-400">
                          bStock shareMultiplier
                        </div>
                        <div className="font-semibold text-slate-100 mt-0.5">
                          {rwa ? `${rwa.shareMultiplier.toFixed(6)}x` : "--"}
                        </div>
                        <div className="text-[10px] text-slate-400">
                          Drift:{" "}
                          <span
                            className={
                              rwa && Math.abs(rwa.multiplierDriftPct) > 1
                                ? "font-semibold text-rose-300"
                                : "text-slate-300"
                            }
                          >
                            {rwa
                              ? `${rwa.multiplierDriftPct >= 0 ? "+" : ""}${rwa.multiplierDriftPct.toFixed(2)}%`
                              : "--"}
                          </span>{" "}
                          · Gap:{" "}
                          <span className="text-slate-300">
                            {rwa
                              ? `${rwa.crossVenueMultiplierGapPct.toFixed(2)}%`
                              : "--"}
                          </span>
                        </div>
                      </div>

                      <div className="rounded-md bg-slate-950/70 px-2.5 py-1.5">
                        <div className="text-[10px] text-slate-400">
                          {rwa?.perpSymbol || spec.binancePerpSymbol || "NVDAUSDT"}{" "}
                          Perp Basis
                        </div>
                        <div
                          className={`font-semibold mt-0.5 ${
                            rwa?.spotPerpBasisBps != null &&
                            rwa.spotPerpBasisBps > 30
                              ? "text-amber-300"
                              : "text-slate-100"
                          }`}
                        >
                          {rwa?.spotPerpBasisBps !== null &&
                          rwa?.spotPerpBasisBps !== undefined
                            ? `${rwa.spotPerpBasisBps.toFixed(1)} bps`
                            : "--"}
                          {rwa?.perpPriceUsd != null && (
                            <span className="ml-1 font-normal text-[10px] text-slate-400">
                              ({formatPrice(rwa.perpPriceUsd)})
                            </span>
                          )}
                        </div>
                        <div className="text-[10px] text-slate-400">
                          Delta Hedge:{" "}
                          <span className="font-semibold text-teal-300">
                            ×{(rwa?.shareMultiplier ?? 1).toFixed(4)}
                          </span>
                        </div>
                      </div>

                      <div className="col-span-2 rounded-md bg-slate-950/70 px-2.5 py-1.5 flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <div className="text-[10px] text-slate-400">
                            ThetaData IV · CBOE Expiry
                          </div>
                          <div className="font-semibold text-slate-100 mt-0.5">
                            ATM IV {thetaIvText} ·{" "}
                            <span className="text-slate-300">
                              {rwa?.thetaExpiration || "M/W/F Fallback"}
                            </span>
                            {rwa && rwa.thetaStrikeCount > 0 && (
                              <span className="text-[10px] text-slate-400">
                                {" "}
                                ({rwa.thetaStrikeCount} strikes)
                              </span>
                            )}
                          </div>
                        </div>
                        <span
                          className={`rounded-md border px-2 py-0.5 text-[10px] font-semibold ${ivSourceBadgeClasses(
                            rwa?.ivSource ?? "SYNTHETIC_BASELINE"
                          )}`}
                        >
                          {rwa?.ivSource ?? "SYNTHETIC_BASELINE"}
                        </span>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800/90 pt-2 text-[10px]">
                      <span
                        className={
                          rwa?.splitGuardTriggered
                            ? "font-bold text-rose-300"
                            : "text-emerald-400"
                        }
                      >
                        Split-Cutover Sentinel:{" "}
                        {rwa?.splitGuardTriggered ? "TRIGGERED (>1%)" : "ARMED"}
                      </span>
                      <span
                        className={
                          rwa?.corporateActionBlackout
                            ? "font-bold text-rose-300"
                            : "text-emerald-400"
                        }
                      >
                        Blackout Guard:{" "}
                        {rwa?.corporateActionBlackout
                          ? rwa.blackoutReason || "ACTIVE"
                          : "CLEAR"}
                      </span>
                    </div>
                  </div>
                )}

                {(() => {
                  const twapHealth =
                    consensus?.twapWindowHealth?.[sym] ??
                    health?.twapWindowHealth?.[sym];
                  const isSettled = Boolean(twapHealth?.onChainSettled);
                  const isPaused = Boolean(
                    twapHealth?.onChainPaused && !isSettled
                  );
                  const isLowHealthOffChain = Boolean(
                    !isSettled &&
                      !isPaused &&
                      twapHealth?.status === "DISPUTED_LOW_HEALTH"
                  );
                  return (
                    <>
                      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800 pt-2.5 text-[11px]">
                        <span
                          className={
                            isPaused
                              ? "font-semibold text-rose-300"
                              : isLowHealthOffChain
                                ? "font-semibold text-amber-300"
                                : "text-emerald-400"
                          }
                        >
                          30m TWAP Health (&ge;40%):{" "}
                          {isSettled
                            ? "SETTLED"
                            : isPaused
                              ? "DISPUTED · PAUSED FOR ADMIN"
                              : isLowHealthOffChain
                                ? `LOW HEALTH ${formatScorePct(twapHealth?.avgConsensusScore)} (${twapHealth?.observedMinutes}/${twapHealth?.sampleCountTarget}m)`
                                : twapHealth && twapHealth.observedMinutes > 0
                                  ? `${formatScorePct(twapHealth.avgConsensusScore)} (${twapHealth.observedMinutes}/${twapHealth.sampleCountTarget}m)`
                                  : `ARMED (${rwaClock.windowUtc})`}
                        </span>
                        <span
                          className={
                            quotingHalted
                              ? "font-semibold text-rose-300"
                              : "text-emerald-400"
                          }
                        >
                          Mock Maker Quoting:{" "}
                          {quotingHalted ? "HALTED" : "ACTIVE"}
                        </span>
                      </div>
                      {guard?.reason && (
                        <div className="rounded-lg bg-amber-500/10 border border-amber-500/30 px-2.5 py-1.5 text-[11px] text-amber-200">
                          {guard.reason}
                        </div>
                      )}
                      {rwaBreakerActive && (
                        <div className="rounded-lg bg-rose-500/10 border border-rose-500/30 px-2.5 py-1.5 text-[11px] text-rose-200">
                          {rwa?.corporateActionBlackout
                            ? `Corporate Action Blackout: ${rwa.blackoutReason || "Active"}`
                            : `Split-Cutover Sentinel Triggered: multiplier drift ${rwa?.multiplierDriftPct.toFixed(2)}% > 1.0%`}
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>
            );
          })}
        </div>
      </section>

      {/* 4 Core Protocol & Mock Market Maker Metric Cards */}
      {metrics && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
          {/* Metric 1 */}
          <div className="rounded-2xl border border-slate-800 bg-[#101622] p-4 space-y-2">
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span>1. Order Flow &amp; Repeat Rate</span>
              <Coins className="h-4 w-4 text-emerald-400" />
            </div>
            <div className="text-2xl font-black text-white tabular-nums">
              {metrics.totalOrders} Orders
            </div>
            <div className="space-y-1 text-xs text-slate-300 tabular-nums">
              <div className="flex justify-between">
                <span className="text-slate-400">Total Volume</span>
                <span>{metrics.totalVolumeUsdt.toFixed(2)} USDT</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Unique / Repeat Buyers</span>
                <span>
                  {metrics.uniqueBuyers} / {metrics.repeatBuyers}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Repeat Rate</span>
                <span className="font-bold text-emerald-400">
                  {metrics.repeatPurchaseRatePct.toFixed(1)}%
                </span>
              </div>
            </div>
          </div>

          {/* Metric 2 */}
          <div className="rounded-2xl border border-slate-800 bg-[#101622] p-4 space-y-2">
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span>2. Shelf vs. Custom Distribution</span>
              <BarChart3 className="h-4 w-4 text-sky-400" />
            </div>
            <div className="text-2xl font-black text-white tabular-nums">
              {metrics.defaultShelfSharePct.toFixed(0)}% Fixed Shelf
            </div>
            <div className="space-y-1.5 text-xs tabular-nums">
              {(
                [
                  { k: "CONSERVATIVE", label: "Cushioned" },
                  { k: "STANDARD", label: "Standard" },
                  { k: "BREAKOUT", label: "Breakout" },
                  { k: "CUSTOM", label: "Custom Range" },
                ] as const
              ).map((item) => {
                const cnt = metrics.tierDistribution[item.k] || 0;
                const pct = totalTiers > 0 ? (cnt / totalTiers) * 100 : 0;
                return (
                  <div key={item.k} className="space-y-0.5">
                    <div className="flex justify-between text-[11px] text-slate-300">
                      <span>{item.label}</span>
                      <span>
                        {cnt} ({pct.toFixed(0)}%)
                      </span>
                    </div>
                    <div className="h-1.5 w-full rounded-full bg-slate-800 overflow-hidden">
                      <div
                        className="h-full bg-sky-400 rounded-full"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Metric 3 */}
          <div className="rounded-2xl border border-slate-800 bg-[#101622] p-4 space-y-2">
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span>3. Early Close &amp; Atomic Merge</span>
              <RefreshCw className="h-4 w-4 text-amber-400" />
            </div>
            <div className="text-2xl font-black text-white tabular-nums">
              {metrics.earlyCloseRatePct.toFixed(1)}% Early Exit
            </div>
            <div className="space-y-1 text-xs text-slate-300 tabular-nums">
              <div className="flex justify-between">
                <span className="text-slate-400">Atomic Merge Unlocks</span>
                <span>{metrics.atomicMergeUnlocks}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">External Takeovers</span>
                <span>{metrics.externalTakeovers}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Capital Unlocked</span>
                <span className="font-bold text-amber-300">
                  {metrics.totalCapitalUnlockedUsdt.toFixed(2)} USDT
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Turnover Boost</span>
                <span className="font-bold text-emerald-400">
                  +{metrics.capitalTurnoverBoostPct.toFixed(1)}%
                </span>
              </div>
            </div>
          </div>

          {/* Metric 4 */}
          <div className="rounded-2xl border border-slate-800 bg-[#101622] p-4 space-y-2">
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span>4. Mock Maker Parity Economics</span>
              <ArrowLeftRight className="h-4 w-4 text-emerald-400" />
            </div>
            <div className="text-2xl font-black text-emerald-400 tabular-nums">
              +${metrics.totalMmNetMarginUsd.toFixed(2)}
            </div>
            <div className="space-y-1 text-xs text-slate-300 tabular-nums">
              <div className="flex justify-between">
                <span className="text-slate-400">Avg Net Margin / Order</span>
                <span>${metrics.avgNetMarginPerOrderUsd.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Protocol Fee Revenue</span>
                <span>${metrics.totalProtocolFeeUsd.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Reference Combo Fee</span>
                <span>${metrics.totalExchangeFeeUsd.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Put-Call Parity Saved</span>
                <span className="font-bold text-sky-300">
                  {metrics.parityFlipCount}x / $
                  {metrics.totalParitySavedUsd.toFixed(2)}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* On-Chain Atlas Pull Settlement History */}
      {settlements.length > 0 && (
        <div className="rounded-2xl border border-slate-800 bg-[#101622] overflow-hidden">
          <div className="border-b border-slate-800 px-5 py-3.5 flex items-center justify-between">
            <h2 className="text-sm font-bold text-white">
              On-Chain Atlas Pull Oracle Settlements (ECDSA Verified)
            </h2>
            <span className="text-xs text-slate-400">
              {settlements.length} recent records
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-950/70 text-slate-400">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Asset / Feed</th>
                  <th scope="col" className="px-4 py-3 font-medium">Expiry (UTC)</th>
                  <th scope="col" className="px-4 py-3 font-medium text-right">
                    Settlement Price
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">Oracle Timestamp</th>
                  <th scope="col" className="px-4 py-3 font-medium">Source</th>
                  <th scope="col" className="px-4 py-3 font-medium text-right">Tx</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70 text-slate-200 tabular-nums">
                {settlements.map((rec) => (
                  <tr
                    key={`${rec.underlying}-${rec.expiry}`}
                    className="hover:bg-slate-900/50"
                  >
                    <td className="px-4 py-3 font-semibold">
                      <span className="inline-flex items-center gap-1.5">
                        <span>{rec.underlying}</span>
                        {ASSET_SPECS[rec.underlying].assetClass ===
                          "RWA_EQUITY" && (
                          <span className="rounded border border-teal-500/40 bg-teal-500/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-teal-300">
                            RWA
                          </span>
                        )}
                        {rec.feedId && (
                          <span className="font-mono text-[10px] text-slate-400">
                            #{rec.feedId}
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {rec.expiryIso.slice(0, 16).replace("T", " ")} UTC
                    </td>
                    <td className="px-4 py-3 text-right font-bold text-emerald-400">
                      {formatPrice(rec.priceUsd)}
                    </td>
                    <td className="px-4 py-3 text-slate-400">
                      {new Date(rec.oracleTimestamp * 1000)
                        .toISOString()
                        .slice(0, 19)
                        .replace("T", " ")}{" "}
                      UTC
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span
                          className={`rounded px-2 py-0.5 text-[10px] font-semibold ${
                            rec.isManualOverride ||
                            rec.source === "ADMIN_EMERGENCY_SETTLED"
                              ? "bg-amber-500/15 text-amber-300"
                              : "bg-emerald-500/15 text-emerald-300"
                          }`}
                        >
                          {rec.source}
                          {rec.sampleCount && rec.sampleCount > 0
                            ? ` (${rec.sampleCount} pts)`
                            : ""}
                        </span>
                      </div>
                      {rec.overrideReason && (
                        <div className="mt-1 max-w-xs truncate text-[10px] text-amber-200/80" title={rec.overrideReason}>
                          Reason: {rec.overrideReason}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {isValidTxHash(rec.txHash) ? (
                        <a
                          href={`${explorerBase}/tx/${rec.txHash}`}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 font-mono text-[11px] text-sky-300 hover:underline"
                        >
                          {rec.txHash.slice(0, 8)}...
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      ) : (
                        <span className="text-slate-500">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Mock Market Maker Hedge Ledger Table */}
      <div className="rounded-2xl border border-slate-800 bg-[#101622] overflow-hidden">
        <div className="border-b border-slate-800 px-5 py-3.5 flex items-center justify-between">
          <h2 className="text-sm font-bold text-white">
            Mock Market Maker Hedge Ledger (Black-Scholes + Put-Call Parity
            Routing)
          </h2>
          <span className="text-xs text-slate-400">
            {ledger.length} on-chain fill records
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-950/70 text-slate-400">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">Action</th>
                <th scope="col" className="px-4 py-3 font-medium">Range</th>
                <th scope="col" className="px-4 py-3 font-medium">Maker / Venue</th>
                <th scope="col" className="px-4 py-3 font-medium">Parity Route</th>
                <th scope="col" className="px-4 py-3 font-medium">Synthetic Legs</th>
                <th scope="col" className="px-4 py-3 font-medium text-right">Combo Fee</th>
                <th scope="col" className="px-4 py-3 font-medium text-right">
                  Parity Saved
                </th>
                <th scope="col" className="px-4 py-3 font-medium text-right">
                  MM Net Margin
                </th>
                <th scope="col" className="px-4 py-3 font-medium text-right">
                  Unlocked USDT
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70 text-slate-200 tabular-nums">
              {ledger.length === 0 ? (
                <tr>
                  <td
                    colSpan={9}
                    className="px-4 py-8 text-center text-slate-500"
                  >
                    No on-chain fills yet. Open a continuous-payout ticket on the
                    Trade tab to populate the Mock Maker ledger.
                  </td>
                </tr>
              ) : (
                ledger.map((row) => (
                  <tr key={row.id} className="hover:bg-slate-900/50">
                    <td className="px-4 py-3">
                      <span
                        className={`rounded px-2 py-0.5 text-[11px] font-semibold ${
                          row.action === "OPEN"
                            ? "bg-emerald-500/15 text-emerald-300"
                            : "bg-sky-500/15 text-sky-300"
                        }`}
                      >
                        {row.action}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-medium">
                      {row.underlying} {row.direction}{" "}
                      <span className="text-slate-400">
                        {formatStrikeNumber(row.lowerStrike, row.underlying)}–
                        {formatStrikeNumber(row.upperStrike, row.underlying)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div>{row.makerName}</div>
                      <div className="text-[10px] text-slate-400">
                        {row.venue} · {row.executionMode}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {row.isParityFlip ? (
                        <span className="inline-flex items-center gap-1 rounded-md border border-sky-500/40 bg-sky-500/15 px-2 py-0.5 text-[11px] font-semibold text-sky-300">
                          <ArrowLeftRight className="h-3 w-3" />
                          Parity Flip ({row.hedgeRoute})
                        </span>
                      ) : (
                        <span className="text-slate-300">{row.hedgeRoute}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-[10px] text-slate-400">
                      <div>+ {row.longLegInstId}</div>
                      <div>- {row.shortLegInstId}</div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      ${row.exchangeFeeUsd.toFixed(3)}
                    </td>
                    <td className="px-4 py-3 text-right text-sky-300 font-semibold">
                      {row.paritySavedUsd > 0
                        ? `+$${row.paritySavedUsd.toFixed(3)}`
                        : "—"}
                    </td>
                    <td className="px-4 py-3 text-right text-emerald-400 font-semibold">
                      ${row.mmNetMarginUsd.toFixed(3)}
                    </td>
                    <td className="px-4 py-3 text-right text-amber-300">
                      {row.capitalUnlockedUsdt > 0
                        ? `${row.capitalUnlockedUsdt.toFixed(2)} USDT`
                        : "—"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

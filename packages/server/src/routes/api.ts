import type { FastifyInstance } from "fastify";
import {
  ConsensusCircuitBreakerError,
  type ShelfEngine,
} from "@payoff/mock-maker";
import {
  MIN_CLOSE_LEAD_TIME_SEC,
  SETTLEMENT_DELAY_SEC,
  SETTLEMENT_EXACT_MATCH_GRACE_SEC,
  SETTLEMENT_FALLBACK_TOLERANCE_SEC,
  SETTLEMENT_HEALTH_MIN_AVG_SCORE,
  SETTLEMENT_TWAP_INTERVAL_SEC,
  SETTLEMENT_TWAP_SAMPLE_COUNT,
  SETTLEMENT_UTC_HOUR,
  symbolToAssetId,
  type CandleBar,
  type Direction,
  type ExpiryTenor,
  type TierKind,
  type UnderlyingSymbol,
} from "@payoff/shared";
import type { ServerConfig } from "../config.js";
import type { PayoffDatabase } from "../db/database.js";
import type { AtlasOracleService } from "../services/atlasOracle.js";
import type { ChainService } from "../services/chainService.js";
import type { MarketDataService } from "../services/marketData.js";
import type { MetricsService } from "../services/metricsService.js";
import type { PositionsService } from "../services/positionsService.js";
import type { RfqGateway } from "../services/rfqGateway.js";

export interface AppServices {
  config: ServerConfig;
  db: PayoffDatabase;
  atlasOracle: AtlasOracleService;
  marketData: MarketDataService;
  chain: ChainService;
  shelfEngine: ShelfEngine;
  rfq: RfqGateway;
  positions: PositionsService;
  metrics: MetricsService;
}

export function registerApiRoutes(app: FastifyInstance, svc: AppServices) {
  app.get("/api/health", async () => {
    const [effectiveNow, vaultHealth, settlementOracleAddress, onChainFees] =
      await Promise.all([
        svc.chain.getEffectiveNow(),
        svc.chain.getVaultHealth(),
        svc.chain.getSettlementOracleContract(),
        svc.chain.getOnChainProtocolFees(),
      ]);
    const btc = svc.marketData.getSnapshot("BTC");
    const eth = svc.marketData.getSnapshot("ETH");
    const activeExpiry = svc.chain.getActiveTwapWindowExpiry(effectiveNow);
    const [btcTwapHealth, ethTwapHealth] = await Promise.all([
      svc.chain.getTwapWindowHealth("BTC", activeExpiry, { checkOnChain: false }),
      svc.chain.getTwapWindowHealth("ETH", activeExpiry, { checkOnChain: false }),
    ]);
    return {
      ok: true,
      chainId: svc.config.chainId,
      isLocalDev: svc.config.isLocalDev,
      rpcUrl: svc.config.rpcUrl,
      usdtAddress: svc.config.usdtAddress,
      vaultAddress: svc.config.vaultAddress,
      lensAddress: svc.config.lensAddress,
      settlementOracleAddress,
      settlementOracleSource: "ATLAS_PULL_ORACLE",
      atlasSignerAddress: svc.atlasOracle.getAuthorizedSigner(),
      oracleAddress: settlementOracleAddress,
      dbEngine: svc.db.engine,
      protocolFeeBps: onChainFees.openFeeBps,
      closeFeeBps: onChainFees.closeFeeBps,
      effectiveNow,
      dataSource: btc.dataSource,
      dataSourceStatus: btc.dataSource,
      spots: {
        BTC: btc.spot,
        ETH: eth.spot,
      },
      atlasTelemetry: svc.atlasOracle.getAllTelemetry(),
      settlementCircuitBreaker: svc.chain.getSettlementCircuitBreaker(),
      twapConfig: {
        sampleCount: SETTLEMENT_TWAP_SAMPLE_COUNT,
        sampleIntervalSec: SETTLEMENT_TWAP_INTERVAL_SEC,
        settlementDelaySec: SETTLEMENT_DELAY_SEC,
        exactMatchGraceSec: SETTLEMENT_EXACT_MATCH_GRACE_SEC,
        fallbackToleranceSec: SETTLEMENT_FALLBACK_TOLERANCE_SEC,
        healthMinAvgScore: SETTLEMENT_HEALTH_MIN_AVG_SCORE,
        minCloseLeadTimeSec: MIN_CLOSE_LEAD_TIME_SEC,
      },
      twapWindowHealth: {
        BTC: btcTwapHealth,
        ETH: ethTwapHealth,
      },
      vaultHealth,
    };
  });

  app.get("/api/oracle/consensus", async () => {
    const [settlementOracleAddress, effectiveNow] = await Promise.all([
      svc.chain.getSettlementOracleContract(),
      svc.chain.getEffectiveNow(),
    ]);
    const activeExpiry = svc.chain.getActiveTwapWindowExpiry(effectiveNow);
    const [btcTwapHealth, ethTwapHealth] = await Promise.all([
      svc.chain.getTwapWindowHealth("BTC", activeExpiry, { checkOnChain: true }),
      svc.chain.getTwapWindowHealth("ETH", activeExpiry, { checkOnChain: true }),
    ]);
    return {
      oracle: "ATLAS_PULL_ORACLE",
      signerAddress: svc.atlasOracle.getAuthorizedSigner(),
      oracleAddress: settlementOracleAddress,
      feeds: svc.atlasOracle.getFeedsConfig(),
      telemetry: svc.atlasOracle.getAllTelemetry(),
      circuitBreaker: svc.chain.getSettlementCircuitBreaker(),
      twapConfig: {
        sampleCount: SETTLEMENT_TWAP_SAMPLE_COUNT,
        sampleIntervalSec: SETTLEMENT_TWAP_INTERVAL_SEC,
        settlementDelaySec: SETTLEMENT_DELAY_SEC,
        exactMatchGraceSec: SETTLEMENT_EXACT_MATCH_GRACE_SEC,
        fallbackToleranceSec: SETTLEMENT_FALLBACK_TOLERANCE_SEC,
        healthMinAvgScore: SETTLEMENT_HEALTH_MIN_AVG_SCORE,
        minCloseLeadTimeSec: MIN_CLOSE_LEAD_TIME_SEC,
      },
      twapWindowHealth: {
        BTC: btcTwapHealth,
        ETH: ethTwapHealth,
      },
      wsConnected: svc.atlasOracle.isWsConnected(),
      updatedAtMs: Date.now(),
    };
  });

  /**
   * On-demand permissionless 30m TWAP proof bundle for direct user wallet settlement.
   * Validates expiry & checks on-chain state BEFORE fetching cached/singleflight Atlas proofs.
   */
  app.get<{
    Querystring: {
      underlying?: string;
      expiry?: string;
    };
  }>("/api/oracle/settlement-proof", async (req, reply) => {
    const underlying = (
      req.query.underlying || "BTC"
    ).toUpperCase() as UnderlyingSymbol;
    if (underlying !== "BTC" && underlying !== "ETH") {
      return reply
        .code(400)
        .send({ error: "Only BTC and ETH underlyings are supported" });
    }
    const expiry = Number(req.query.expiry);
    if (!Number.isInteger(expiry) || expiry <= 0) {
      return reply
        .code(400)
        .send({ error: "Valid unix timestamp query param `expiry` is required" });
    }

    const effNow = await svc.chain.getEffectiveNow();
    if (expiry > effNow) {
      return reply
        .code(400)
        .send({ error: "Expiry has not been reached yet" });
    }
    const offset = SETTLEMENT_UTC_HOUR * 3600;
    const isStandard08Utc =
      expiry >= offset && (expiry - offset) % 86400 === 0;
    const maxHistoryAgeSec = 180 * 86400;
    if (!isStandard08Utc && !svc.config.isLocalDev) {
      return reply
        .code(400)
        .send({ error: "Expiry must be aligned to standard 08:00 UTC schedule" });
    }
    if (effNow - expiry > maxHistoryAgeSec) {
      return reply
        .code(400)
        .send({ error: "Expiry exceeds Atlas 180-day signed historical retention" });
    }

    const [oracleAddress, onChainSettlement, health] = await Promise.all([
      svc.chain.getSettlementOracleContract(),
      svc.chain.readOnChainSettlement(underlying, expiry),
      svc.chain.getTwapWindowHealth(underlying, expiry, { checkOnChain: true }),
    ]);

    if (onChainSettlement?.settled) {
      return {
        status: "ALREADY_SETTLED" as const,
        underlying,
        expiry,
        oracleAddress,
        assetId: symbolToAssetId(underlying),
        settlement: onChainSettlement,
        health,
      };
    }

    if (health.onChainPaused || health.status === "DISPUTED_LOW_HEALTH") {
      return {
        status: "DISPUTED_PAUSED" as const,
        underlying,
        expiry,
        oracleAddress,
        assetId: symbolToAssetId(underlying),
        health,
        reason:
          "Expiry is frozen due to low 30m Atlas ConsensusScore (< 0.40); awaiting admin emergency settlement",
      };
    }

    const availableAt = expiry + SETTLEMENT_DELAY_SEC;
    if (effNow < availableAt) {
      return {
        status: "WAITING_DELAY" as const,
        underlying,
        expiry,
        availableAt,
        oracleAddress,
        assetId: symbolToAssetId(underlying),
        health,
      };
    }

    // Guard upstream Atlas API quota: only fetch 30 proofs for recent expiries (<= 7d)
    // or expiries that have an active ticket/series on this deployment.
    const maxPublicProofAgeSec = 7 * 86400;
    if (!svc.config.isLocalDev && effNow - expiry > maxPublicProofAgeSec) {
      const [dbTickets, onChainSeries] = await Promise.all([
        svc.db.getAllTickets(),
        svc.chain.getAllSeriesOnChain(),
      ]);
      const hasKnownMarket =
        dbTickets.some(
          (t) => t.underlying === underlying && t.expiry === expiry
        ) ||
        Boolean(
          onChainSeries?.some(
            (s) => s.underlying === underlying && s.expiry === expiry
          )
        );
      if (!hasKnownMarket) {
        return reply.code(400).send({
          error:
            "Expiry is outside the 7-day public proof window and has no active market on this vault",
        });
      }
    }

    try {
      const twap = await svc.atlasOracle.fetchSignedTwapProofs(
        underlying,
        expiry,
        { nowSec: effNow }
      );
      if (!twap) {
        return reply.code(503).send({
          error: "Signed Atlas 30m TWAP proofs are temporarily unavailable",
        });
      }
      return {
        status: "READY" as const,
        underlying,
        expiry,
        oracleAddress,
        assetId: symbolToAssetId(underlying),
        feedId: twap.feedId,
        feedIdHex: twap.feedIdHex,
        sampleCount: twap.sampleCount,
        twapPriceUsd: twap.twapPriceUsd,
        windowStartTimestamp: twap.windowStartTimestamp,
        windowEndTimestamp: twap.windowEndTimestamp,
        maxAbsTimestampDiffSec: twap.maxAbsTimestampDiffSec,
        proofs: twap.proofs,
        health,
      };
    } catch (err: any) {
      return reply.code(503).send({
        error:
          err?.message || "Failed to assemble signed Atlas 30m TWAP proofs",
      });
    }
  });

  app.get<{
    Querystring: {
      underlying?: string;
      bar?: string;
      limit?: string;
    };
  }>("/api/market/candles", async (req, reply) => {
    const underlying = (
      req.query.underlying || "BTC"
    ).toUpperCase() as UnderlyingSymbol;
    if (underlying !== "BTC" && underlying !== "ETH") {
      return reply
        .code(400)
        .send({ error: "Only BTC and ETH underlyings are supported" });
    }
    const allowedBars: CandleBar[] = ["5m", "15m", "1H", "4H", "1D"];
    const bar = (
      allowedBars.includes(req.query.bar as CandleBar) ? req.query.bar : "15m"
    ) as CandleBar;
    const limit = Math.min(200, Math.max(20, Number(req.query.limit || 120)));
    const { candles, source } = await svc.marketData.getCandlesWithSource(
      underlying,
      bar,
      limit
    );
    return { underlying, bar, candles, source };
  });

  app.get<{
    Querystring: {
      underlying?: string;
      limit?: string;
    };
  }>("/api/market/settlement-history", async (req, reply) => {
    const underlying = (
      req.query.underlying || "BTC"
    ).toUpperCase() as UnderlyingSymbol;
    if (underlying !== "BTC" && underlying !== "ETH") {
      return reply
        .code(400)
        .send({ error: "Only BTC and ETH underlyings are supported" });
    }
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 10)));
    const settlementOracleAddress =
      await svc.chain.getSettlementOracleContract();
    let recordedOnChain = await svc.db.getAllSettlements(underlying, limit);
    if (recordedOnChain.length === 0) {
      await svc.chain.syncEvents();
      await svc.chain.backfillRecentSettlements(underlying);
      recordedOnChain = await svc.db.getAllSettlements(underlying, limit);
    }
    const feedCfg = svc.atlasOracle.getFeedsConfig()[underlying];

    const records = recordedOnChain.map((r) => ({
      underlying: r.underlying,
      feedId: r.feedId ?? (r.isManualOverride ? null : feedCfg.feedId),
      feedIdHex: (r.feedIdHex ??
        (r.isManualOverride ? null : feedCfg.feedIdHex)) as `0x${string}` | null,
      expiry: r.expiry,
      expiryIso: new Date(r.expiry * 1000).toISOString(),
      priceUsd: r.settlementPrice,
      oracleTimestamp: r.oracleTimestamp ?? r.expiry,
      settledAt: r.settledAt,
      submitter: r.submitter,
      txHash: r.txHash,
      source: r.source,
      sampleCount: r.sampleCount,
      isManualOverride: r.isManualOverride,
      overrideReason: r.overrideReason,
    }));

    return {
      underlying,
      feedId: feedCfg.feedId,
      feedIdHex: feedCfg.feedIdHex,
      pair: feedCfg.pair,
      oracleAddress: settlementOracleAddress,
      signerAddress: svc.atlasOracle.getAuthorizedSigner(),
      source: "ATLAS_PULL_ORACLE",
      records,
    };
  });

  app.get<{
    Querystring: {
      underlying?: string;
      direction?: string;
      tenor?: string;
      stake?: string;
    };
  }>("/api/market/shelf", async (req, reply) => {
    const underlying = (
      req.query.underlying || "BTC"
    ).toUpperCase() as UnderlyingSymbol;
    if (underlying !== "BTC" && underlying !== "ETH") {
      return reply
        .code(400)
        .send({ error: "Only BTC and ETH underlyings are supported" });
    }
    const direction = (req.query.direction || "BULL").toUpperCase() as Direction;
    const tenor = (req.query.tenor || "DAILY").toUpperCase() as ExpiryTenor;
    const stakeUsdt = Math.max(1, Math.min(50_000, Number(req.query.stake || 20)));

    const snap = svc.marketData.getSnapshot(underlying);
    const book = svc.marketData.getExpiryBook(underlying, tenor);
    const atlasTelemetry = svc.atlasOracle.getTelemetry(underlying);
    const quotingGuard = svc.atlasOracle.getConsensusGuard(underlying);
    const onChainFees = await svc.chain.getOnChainProtocolFees();
    const { grid, tiers, consensusRisk } = svc.shelfEngine.buildFixedGridShelf({
      book,
      direction,
      stakeUsdt,
      protocolFeeBps: onChainFees.openFeeBps,
      atlasTelemetry,
    });

    return {
      underlying,
      direction,
      tenor,
      stakeUsdt,
      spot: snap.spot,
      change24hPct: snap.change24hPct,
      dataSource: snap.dataSource,
      atlasTelemetry,
      quotingGuard,
      consensusRisk,
      expiry: book.expiry,
      expiryIso: book.expiryIso,
      hoursToExpiry: book.hoursToExpiry,
      availableStrikes: book.availableStrikes,
      grid,
      tiers,
    };
  });

  app.post<{
    Body: {
      underlying: UnderlyingSymbol;
      direction: Direction;
      tenor: ExpiryTenor;
      lowerStrike: number;
      upperStrike: number;
      stakeUsdt?: number;
      stake?: number;
    };
  }>("/api/market/preview-custom", async (req, reply) => {
    const {
      underlying = "BTC",
      direction = "BULL",
      tenor = "DAILY",
      lowerStrike,
      upperStrike,
      stakeUsdt,
      stake,
    } = req.body || ({} as any);

    if (underlying !== "BTC" && underlying !== "ETH") {
      return reply
        .code(400)
        .send({ error: "Only BTC and ETH underlyings are supported" });
    }
    const resolvedStake = Number(stakeUsdt ?? stake ?? 20);
    const book = svc.marketData.getExpiryBook(underlying, tenor);
    const atlasTelemetry = svc.atlasOracle.getTelemetry(underlying);
    const onChainFees = await svc.chain.getOnChainProtocolFees();
    const best = svc.shelfEngine.priceSpread({
      book,
      tierKind: "CUSTOM",
      tierLabel: "Custom Range",
      direction,
      lowerStrike: Number(lowerStrike),
      upperStrike: Number(upperStrike),
      stakeUsdt: resolvedStake,
      protocolFeeBps: onChainFees.openFeeBps,
      mmOpenMarkupBps: 110,
      venue: "MOCK_MAKER",
      atlasTelemetry,
    });
    return {
      ticket: best.summary,
      availableStrikes: book.availableStrikes,
      atlasTelemetry,
      consensusRisk: best.consensusRisk,
    };
  });

  app.post<{
    Body: {
      taker: `0x${string}`;
      underlying: UnderlyingSymbol;
      direction: Direction;
      tenor: ExpiryTenor;
      tierKind: TierKind;
      lowerStrike: number;
      upperStrike: number;
      stakeUsdt: number;
    };
  }>("/api/rfq/open", async (req, reply) => {
    try {
      const b = req.body;
      if (!b?.taker) {
        return reply.code(400).send({ error: "Missing taker wallet address" });
      }
      if (b.underlying !== "BTC" && b.underlying !== "ETH") {
        return reply
          .code(400)
          .send({ error: "Only BTC and ETH underlyings are supported" });
      }
      const res = await svc.rfq.requestOpenRfq({
        taker: b.taker,
        underlying: b.underlying,
        direction: b.direction,
        tenor: b.tenor,
        tierKind: b.tierKind || "CUSTOM",
        lowerStrike: Number(b.lowerStrike),
        upperStrike: Number(b.upperStrike),
        stakeUsdt: Number(b.stakeUsdt),
      });
      return res;
    } catch (err: any) {
      if (err instanceof ConsensusCircuitBreakerError) {
        return reply.code(503).send({
          error: err.message,
          circuitBreaker: true,
          consensusStatus: err.consensusStatus,
          consensusScore: err.consensusScore,
        });
      }
      return reply.code(400).send({ error: err?.message || "Open RFQ failed" });
    }
  });

  app.post<{
    Body: {
      taker: `0x${string}`;
      seriesId: `0x${string}`;
      isUp?: boolean;
      closeAmountUsdt?: number;
    };
  }>("/api/rfq/close", async (req, reply) => {
    try {
      const b = req.body;
      if (!b?.taker || !b?.seriesId) {
        return reply.code(400).send({ error: "Missing taker or seriesId" });
      }
      const res = await svc.rfq.requestCloseRfq({
        taker: b.taker,
        seriesId: b.seriesId,
        isUp: typeof b.isUp === "boolean" ? b.isUp : undefined,
        closeAmountUsdt: b.closeAmountUsdt
          ? Number(b.closeAmountUsdt)
          : undefined,
      });
      return res;
    } catch (err: any) {
      if (err instanceof ConsensusCircuitBreakerError) {
        return reply.code(503).send({
          error: err.message,
          circuitBreaker: true,
          consensusStatus: err.consensusStatus,
          consensusScore: err.consensusScore,
        });
      }
      return reply
        .code(400)
        .send({ error: err?.message || "Close RFQ failed" });
    }
  });

  app.post("/api/chain/sync", async () => {
    await svc.chain.syncEvents();
    const settled = await svc.chain.runSettlementKeeper();
    return { ok: true, settled };
  });

  app.post<{ Body: { txHash?: string } }>(
    "/api/tx/ingest",
    async (req, reply) => {
      const txHash = req.body?.txHash?.trim();
      if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
        return reply.code(400).send({ error: "Invalid transaction hash txHash" });
      }
      try {
        const res = await svc.chain.ingestTransaction(txHash as `0x${string}`);
        return { ok: true, ...res };
      } catch (err: any) {
        return reply.code(400).send({
          error:
            err?.shortMessage ||
            err?.message ||
            "Transaction receipt ingestion failed",
        });
      }
    }
  );

  app.get<{ Params: { address: string } }>(
    "/api/positions/:address",
    async (req) => {
      const positions = await svc.positions.getPositionsForAddress(
        req.params.address
      );
      return { positions };
    }
  );

  app.get("/api/metrics", async () => {
    await svc.chain.syncEvents();
    return svc.metrics.computePhase1Metrics();
  });

  app.get<{ Querystring: { limit?: string } }>("/api/ledger", async (req) => {
    await svc.chain.syncEvents();
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
    return {
      entries: await svc.db.getHedgeLedger(limit),
    };
  });

  // Local devnet utilities (strictly gated to chainId === 31337)
  app.get("/api/dev/demo-account", async (_req, reply) => {
    if (!svc.config.isLocalDev || !svc.config.demoTakerPrivateKey) {
      return reply
        .code(404)
        .send({ error: "Not available outside local devnet" });
    }
    return {
      chainId: svc.config.chainId,
      rpcUrl: svc.config.rpcUrl,
      address: svc.config.demoTakerAddress,
      privateKey: svc.config.demoTakerPrivateKey,
      usdtAddress: svc.config.usdtAddress,
      vaultAddress: svc.config.vaultAddress,
    };
  });

  app.post<{ Body: { address: `0x${string}` } }>(
    "/api/dev/faucet",
    async (req, reply) => {
      if (!svc.config.isLocalDev) {
        return reply
          .code(404)
          .send({ error: "Not available outside local devnet" });
      }
      try {
        const txHash = await svc.chain.mintFaucetLocal(req.body.address);
        return { ok: true, txHash };
      } catch (err: any) {
        return reply
          .code(400)
          .send({ error: err?.message || "Faucet failed" });
      }
    }
  );

  app.post<{
    Body: {
      underlying: UnderlyingSymbol;
      expiry: number;
      settlementPrice: number;
    };
  }>("/api/dev/simulate-expiry", async (req, reply) => {
    if (!svc.config.isLocalDev) {
      return reply
        .code(404)
        .send({ error: "Not available outside local devnet" });
    }
    try {
      const res = await svc.chain.simulateExpiryAndSettleLocal({
        underlying: req.body.underlying,
        expiry: Number(req.body.expiry),
        settlementPrice: Number(req.body.settlementPrice),
      });
      await svc.marketData.refreshAll();
      return { ok: true, ...res };
    } catch (err: any) {
      return reply
        .code(400)
        .send({ error: err?.message || "Simulate expiry failed" });
    }
  });
}

import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { ShelfEngine } from "@payoff/mock-maker";
import { loadConfig, type ServerConfig } from "./config.js";
import { createPayoffDatabase } from "./db/database.js";
import { registerApiRoutes } from "./routes/api.js";
import { AtlasOracleService } from "./services/atlasOracle.js";
import { ChainService } from "./services/chainService.js";
import { MarketDataService } from "./services/marketData.js";
import { MetricsService } from "./services/metricsService.js";
import { PositionsService } from "./services/positionsService.js";
import { RfqGateway } from "./services/rfqGateway.js";
import { RwaRiskService } from "./services/rwaRiskService.js";
import { registerWsStream } from "./ws/stream.js";

export async function buildApp(overrides?: Partial<ServerConfig>) {
  const config = { ...loadConfig(overrides?.chainId), ...overrides };
  const db = await createPayoffDatabase({
    databaseUrl: config.databaseUrl,
    dbPath: config.dbPath,
  });

  let marketDataRef: MarketDataService | undefined;
  let chainRef: ChainService | undefined;

  const atlasOracle = new AtlasOracleService({
    apiKey: config.atlasApiKey,
    btcFeedId: config.atlasBtcFeedId,
    ethFeedId: config.atlasEthFeedId,
    nvdabFeedId: config.atlasNvdabFeedId,
    authorizedSigner: config.atlasSignerAddress,
    enableLiveAtlas: config.enableLiveAtlas,
    pollIntervalMs: config.pollIntervalMs,
    onTelemetryUpdate: (telemetry) => {
      marketDataRef?.handleAtlasTelemetryUpdate(telemetry);
      void chainRef?.recordTwapHealthTick(telemetry);
    },
  });

  const rwaRisk = new RwaRiskService(config, db, atlasOracle, {
    effectiveNowFn: () =>
      chainRef?.getCachedEffectiveNow() ?? Math.floor(Date.now() / 1000),
    onStateChange: () => {
      void marketDataRef?.refreshOne("NVDAB");
    },
  });
  await rwaRisk.init();

  const chain = new ChainService(config, db, atlasOracle, undefined, rwaRisk);
  chainRef = chain;
  const marketData = new MarketDataService(atlasOracle, {
    enableLiveAtlas: config.enableLiveAtlas,
    enableBinanceKlines: config.enableBinanceKlines,
    pollIntervalMs: config.pollIntervalMs,
    nvdabSettlementUtcHour: config.nvdabSettlementUtcHour,
    effectiveNowFn: () => chain.getCachedEffectiveNow(),
    rwaRisk,
  });
  marketDataRef = marketData;
  chain.setMarketData(marketData);

  const shelfEngine = new ShelfEngine();
  const rfq = new RfqGateway(
    config,
    db,
    atlasOracle,
    marketData,
    chain,
    shelfEngine,
    rwaRisk
  );
  const positions = new PositionsService(db, marketData, chain, rwaRisk);
  const metrics = new MetricsService(db, chain);

  const app = Fastify({ logger: false });
  const corsOrigins = config.corsOrigin
    ? config.corsOrigin
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
  await app.register(cors, {
    origin:
      !corsOrigins || corsOrigins.length === 0 || corsOrigins.includes("*")
        ? true
        : corsOrigins,
  });
  await app.register(websocket);

  const services = {
    config,
    db,
    atlasOracle,
    rwaRisk,
    marketData,
    chain,
    shelfEngine,
    rfq,
    positions,
    metrics,
  };

  registerApiRoutes(app, services);
  registerWsStream(app, services);

  app.addHook("onClose", async () => {
    atlasOracle.stop();
    rwaRisk.stop();
    marketData.stop();
    chain.stop();
    await db.close();
  });

  return { app, services };
}

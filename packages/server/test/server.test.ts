import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { recoverTypedDataAddress, type Hex } from "viem";
import {
  GRID_CONFIG,
  buildFixedGridShelf,
  computeFairSpreadUnitUsd,
  computeMmCloseUnitUsd,
  computeMmOpenUnitUsd,
  estimatePositionExitUsdt,
  resetFixedGridCache,
} from "@payoff/mock-maker";
import {
  ASSET_BTC_ID,
  ASSET_ETH_ID,
  ATLAS_FEEDS,
  ATLAS_MAGIC_MARKER,
  ATLAS_OFFICIAL_SIGNER,
  CLOSE_QUOTE_TYPES,
  OPEN_QUOTE_TYPES,
  bsOptionPrice,
  computeDownTokenId,
  computeSeriesId,
  computeUpTokenId,
  getPayoffEip712Domain,
  type CloseRfqResponse,
  type ExpiryBook,
  type FixedGridMeta,
  type OpenRfqResponse,
  type Phase1Metrics,
  type TicketSummary,
} from "@payoff/shared";
import { buildApp } from "../src/app.js";
import {
  AtlasOracleService,
  assembleAtlasExtraData,
  buildSignedAtlasProofWithKey,
  decodeAtlasPayloadPackages,
  evaluateConsensusGuard,
  verifyAtlasSignedPayload,
} from "../src/services/atlasOracle.js";
import { anchorCandlesToSpot } from "../src/services/marketData.js";

/**
 * Public production signed Atlas Oracle fixtures captured from
 * https://api.atlasoracle.io/report/v1/price/history and /v1/price/latest.
 * Signed by official Atlas production signer 0x59eD4701224fD9e2a85Ef2946c2ab828C1dDC600.
 * Contains ONLY public signed market data — zero API keys or secrets.
 */
const PRODUCTION_ATLAS_HISTORY_BTC = {
  payload: "0x000002720c6bed79993fee76157800006b06958001" as Hex,
  signature:
    "0xc9d5cbbd66d4a0ed85b03d9ec0a4f8210e7f7485fba1c64e8cdc1d49cd1877fa20da5f67348fe118a0c997a7d0082f33ff3e713b6d366df16928aad87e1945d71c" as Hex,
  magicMarker: ATLAS_MAGIC_MARKER,
  timestampSeconds: 1795593600,
  expectedPrice18: 58659311287081698203000n,
  expectedPrice8: 5865931128708n,
};

const PRODUCTION_ATLAS_LATEST_MULTI = {
  payload:
    "0x000002720c71fb9cd941997aa6c800006b06be500000027800590612d7521b06abd800006b06be5002" as Hex,
  signature:
    "0x87d845fecfada85927079a53ca58f3867ffc859237a856b60a52c7c763ba5a1f3aad49710f63d9e2cbd57630f3a43d38c170cf83f05ad4bb242fbb0ea34220d91b" as Hex,
  magicMarker: ATLAS_MAGIC_MARKER,
  timestampSeconds: 1795604048,
  btcPrice8: 5877101047984n,
  ethPrice8: 164219787142n,
};

describe("@payoff/server — Atlas Oracle, ConsensusScore & BNB API integration", () => {
  let app: Awaited<ReturnType<typeof buildApp>>["app"];
  let services: Awaited<ReturnType<typeof buildApp>>["services"];

  const SECRET_SENTINEL = "atlas-unit-test-secret-never-expose";

  beforeAll(async () => {
    const built = await buildApp({
      databaseUrl: undefined,
      dbPath: ":memory:",
      rpcUrl: "http://127.0.0.1:8545",
      enableLiveAtlas: false,
      enableBinanceKlines: false,
      atlasApiKey: SECRET_SENTINEL,
      vaultAddress: "0x1111111111111111111111111111111111111111",
      settlementOracleAddress: "0x3333333333333333333333333333333333333333",
      lensAddress: "0x4444444444444444444444444444444444444444",
      usdtAddress: "0x2222222222222222222222222222222222222222",
      chainId: 31337,
    });
    app = built.app;
    services = built.services;
  });

  afterAll(async () => {
    await app.close();
  });

  it("verifies real production Atlas signed payloads, extraData assembly, and rejects tampered payloads/rogue signers", async () => {
    // 1. Single-feed historical 08:00 UTC BTC proof
    const extraData = assembleAtlasExtraData(
      PRODUCTION_ATLAS_HISTORY_BTC.payload,
      PRODUCTION_ATLAS_HISTORY_BTC.signature,
      PRODUCTION_ATLAS_HISTORY_BTC.magicMarker
    );
    expect(extraData.startsWith("0x00000272")).toBe(true);
    expect(extraData.endsWith("7096")).toBe(true);

    const decoded = decodeAtlasPayloadPackages(
      PRODUCTION_ATLAS_HISTORY_BTC.payload
    );
    expect(decoded).toHaveLength(1);
    expect(decoded[0]!.feedId).toBe("626");
    expect(decoded[0]!.feedIdHex).toBe(ATLAS_FEEDS.BTC.feedIdHex);
    expect(decoded[0]!.price18).toBe(
      PRODUCTION_ATLAS_HISTORY_BTC.expectedPrice18
    );
    expect(decoded[0]!.price8).toBe(
      PRODUCTION_ATLAS_HISTORY_BTC.expectedPrice8
    );
    expect(decoded[0]!.timestampSeconds).toBe(
      PRODUCTION_ATLAS_HISTORY_BTC.timestampSeconds
    );

    const verifiedSingle = await verifyAtlasSignedPayload({
      payload: PRODUCTION_ATLAS_HISTORY_BTC.payload,
      signature: PRODUCTION_ATLAS_HISTORY_BTC.signature,
      magicMarker: PRODUCTION_ATLAS_HISTORY_BTC.magicMarker,
      expectedSigner: ATLAS_OFFICIAL_SIGNER,
    });
    expect(verifiedSingle.recoveredSigner.toLowerCase()).toBe(
      ATLAS_OFFICIAL_SIGNER.toLowerCase()
    );
    expect(verifiedSingle.extraData).toBe(extraData);

    // 2. Multi-feed latest payload (BTC #626 + ETH #632)
    const verifiedMulti = await verifyAtlasSignedPayload({
      payload: PRODUCTION_ATLAS_LATEST_MULTI.payload,
      signature: PRODUCTION_ATLAS_LATEST_MULTI.signature,
      magicMarker: PRODUCTION_ATLAS_LATEST_MULTI.magicMarker,
      expectedSigner: ATLAS_OFFICIAL_SIGNER,
    });
    expect(verifiedMulti.packages).toHaveLength(2);
    expect(verifiedMulti.packages[0]!.feedId).toBe("626");
    expect(verifiedMulti.packages[0]!.price8).toBe(
      PRODUCTION_ATLAS_LATEST_MULTI.btcPrice8
    );
    expect(verifiedMulti.packages[1]!.feedId).toBe("632");
    expect(verifiedMulti.packages[1]!.price8).toBe(
      PRODUCTION_ATLAS_LATEST_MULTI.ethPrice8
    );

    // 3. Rejects tampered payload against official signer
    const tamperedPayload =
      `0x00000272ff${PRODUCTION_ATLAS_HISTORY_BTC.payload.slice(12)}` as Hex;
    await expect(
      verifyAtlasSignedPayload({
        payload: tamperedPayload,
        signature: PRODUCTION_ATLAS_HISTORY_BTC.signature,
        magicMarker: PRODUCTION_ATLAS_HISTORY_BTC.magicMarker,
        expectedSigner: ATLAS_OFFICIAL_SIGNER,
      })
    ).rejects.toThrow(/signer mismatch/i);

    // 4. Rejects invalid magicMarker
    expect(() =>
      assembleAtlasExtraData(
        PRODUCTION_ATLAS_HISTORY_BTC.payload,
        PRODUCTION_ATLAS_HISTORY_BTC.signature,
        "0xdead"
      )
    ).toThrow(/magicMarker/i);

    // 5. Local signing helper round-trips with verifyAtlasSignedPayload
    const localPk =
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
    const built = await buildSignedAtlasProofWithKey({
      privateKey: localPk,
      packages: [
        {
          feedIdHex: ATLAS_FEEDS.BTC.feedIdHex,
          price18: 65000_00000000n * 10n ** 10n,
          timestampSeconds: 1800000000,
        },
      ],
    });
    const verifiedLocal = await verifyAtlasSignedPayload({
      payload: built.payload,
      signature: built.signature,
      magicMarker: built.magicMarker,
      expectedSigner: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    });
    expect(verifiedLocal.packages[0]!.priceUsd).toBe(65000);
    expect(verifiedLocal.packages[0]!.timestampSeconds).toBe(1800000000);
  });

  it("enforces Atlas expiry window [expiry - 60, expiry + 60] and latest fallback within 60s", async () => {
    const oracle = new AtlasOracleService({
      enableLiveAtlas: false,
      authorizedSigner: ATLAS_OFFICIAL_SIGNER,
    });

    // Valid historical proof right at expiry
    oracle.setHttpFetcher(async (endpoint) => {
      expect(endpoint).toBe("/v1/price/history");
      return {
        payload: PRODUCTION_ATLAS_HISTORY_BTC.payload,
        signature: PRODUCTION_ATLAS_HISTORY_BTC.signature,
        magicMarker: PRODUCTION_ATLAS_HISTORY_BTC.magicMarker,
      };
    });
    const proof = await oracle.fetchSignedExpiryProof(
      "BTC",
      PRODUCTION_ATLAS_HISTORY_BTC.timestampSeconds
    );
    expect(proof).not.toBeNull();
    expect(proof!.source).toBe("ATLAS_PULL_HISTORY");
    expect(proof!.price8).toBe(PRODUCTION_ATLAS_HISTORY_BTC.expectedPrice8);
    expect(proof!.extraData.endsWith("7096")).toBe(true);

    // Rejects proof whose signed timestamp is outside [expiry - 60, expiry + 60]
    await expect(
      oracle.fetchSignedExpiryProof(
        "BTC",
        PRODUCTION_ATLAS_HISTORY_BTC.timestampSeconds + 120
      )
    ).rejects.toThrow(/outside expiry window/i);

    // Falls back to /v1/price/latest when /v1/price/history fails AND expiry is within last 60s
    const calls: string[] = [];
    oracle.setHttpFetcher(async (endpoint) => {
      calls.push(endpoint);
      if (endpoint === "/v1/price/history") {
        throw new Error("history indexing delay");
      }
      return {
        payload: PRODUCTION_ATLAS_LATEST_MULTI.payload,
        signature: PRODUCTION_ATLAS_LATEST_MULTI.signature,
        magicMarker: PRODUCTION_ATLAS_LATEST_MULTI.magicMarker,
      };
    });
    const latestProof = await oracle.fetchSignedExpiryProof(
      "BTC",
      PRODUCTION_ATLAS_LATEST_MULTI.timestampSeconds,
      { nowSec: PRODUCTION_ATLAS_LATEST_MULTI.timestampSeconds + 25 }
    );
    expect(calls).toEqual(["/v1/price/history", "/v1/price/latest"]);
    expect(latestProof).not.toBeNull();
    expect(latestProof!.source).toBe("ATLAS_PULL_LATEST");
    expect(latestProof!.price8).toBe(PRODUCTION_ATLAS_LATEST_MULTI.btcPrice8);
  });

  it("evaluates Atlas ConsensusScore circuit breaker across HEALTHY, DEGRADED, WARNING, CRITICAL, and SPLIT_MARKET", () => {
    const healthy = evaluateConsensusGuard({
      consensusStatus: "HEALTHY",
      consensusScore: 0.94,
    });
    expect(healthy.settlementSafe).toBe(true);
    expect(healthy.quotingSafe).toBe(true);
    expect(healthy.paused).toBe(false);

    const degradedOk = evaluateConsensusGuard({
      consensusStatus: "DEGRADED",
      consensusScore: 0.78,
    });
    expect(degradedOk.settlementSafe).toBe(true);
    expect(degradedOk.quotingSafe).toBe(true);
    expect(degradedOk.paused).toBe(false);

    const lowScore = evaluateConsensusGuard({
      consensusStatus: "DEGRADED",
      consensusScore: 0.65,
    });
    expect(lowScore.settlementSafe).toBe(false);
    expect(lowScore.quotingSafe).toBe(true);
    expect(lowScore.paused).toBe(true);
    expect(lowScore.reason).toContain("70.0%");

    const warning = evaluateConsensusGuard({
      consensusStatus: "WARNING",
      consensusScore: 0.72,
    });
    expect(warning.settlementSafe).toBe(false);
    expect(warning.quotingSafe).toBe(true);
    expect(warning.paused).toBe(true);

    const critical = evaluateConsensusGuard({
      consensusStatus: "CRITICAL",
      consensusScore: 0.35,
    });
    expect(critical.settlementSafe).toBe(false);
    expect(critical.quotingSafe).toBe(false);
    expect(critical.paused).toBe(true);

    const split = evaluateConsensusGuard({
      consensusStatus: "SPLIT_MARKET",
      consensusScore: 0.2,
    });
    expect(split.settlementSafe).toBe(false);
    expect(split.quotingSafe).toBe(false);
    expect(split.paused).toBe(true);
  });

  it("GET /api/health and GET /api/oracle/consensus expose Atlas telemetry & never leak ATLAS_API_KEY", async () => {
    services.atlasOracle.ingestAtlasPayloadData({
      consensusScores: [
        {
          feedId: "626",
          consensusScore: 0.947,
          consensusStatus: "HEALTHY",
          twapPrice: "61502.50",
          medianPrice: "61500.00",
          priceChangePct: 1.25,
          priceVolatility: 0.0012,
        },
        {
          feedId: "632",
          consensusScore: 0.935,
          consensusStatus: "HEALTHY",
          twapPrice: "1750.25",
          medianPrice: "1750.00",
          priceChangePct: 0.85,
          priceVolatility: 0.0015,
        },
      ],
      priceDetails: [
        { feedId: "626", timestampSeconds: "1795604573", price: 61500 },
        { feedId: "632", timestampSeconds: "1795604573", price: 1750 },
      ],
    });

    const healthRes = await app.inject({ method: "GET", url: "/api/health" });
    expect(healthRes.statusCode).toBe(200);
    expect(healthRes.body).not.toContain(SECRET_SENTINEL);

    const health = healthRes.json();
    expect(health.ok).toBe(true);
    expect(health.chainId).toBe(31337);
    expect(health.usdtAddress).toBe("0x2222222222222222222222222222222222222222");
    expect(health.vaultAddress).toBe("0x1111111111111111111111111111111111111111");
    expect(health.lensAddress).toBe("0x4444444444444444444444444444444444444444");
    expect(health.settlementOracleAddress).toBe(
      "0x3333333333333333333333333333333333333333"
    );
    expect(health.settlementOracleSource).toBe("ATLAS_PULL_ORACLE");
    expect(health.atlasSignerAddress).toBe(ATLAS_OFFICIAL_SIGNER);
    expect(health.dataSourceStatus).toBeDefined();
    expect(health.atlasTelemetry.BTC.consensusStatus).toBe("HEALTHY");
    expect(health.atlasTelemetry.BTC.consensusScore).toBeCloseTo(0.947, 3);
    expect(health.settlementCircuitBreaker.BTC.settlementSafe).toBe(true);

    const consensusRes = await app.inject({
      method: "GET",
      url: "/api/oracle/consensus",
    });
    expect(consensusRes.statusCode).toBe(200);
    expect(consensusRes.body).not.toContain(SECRET_SENTINEL);

    const consensus = consensusRes.json();
    expect(consensus.oracle).toBe("ATLAS_PULL_ORACLE");
    expect(consensus.signerAddress).toBe(ATLAS_OFFICIAL_SIGNER);
    expect(consensus.feeds.BTC.feedId).toBe("626");
    expect(consensus.feeds.ETH.feedId).toBe("632");
    expect(consensus.telemetry.BTC.twapPrice).toBeCloseTo(61502.5, 2);
    expect(consensus.telemetry.ETH.medianPrice).toBeCloseTo(1750, 2);
    expect(consensus.circuitBreaker.BTC.paused).toBe(false);
    expect(typeof consensus.updatedAtMs).toBe("number");
  });

  it("GET /api/market/candles anchors Binance K-lines to live Atlas spot and falls back smoothly offline", async () => {
    // 1. Anchoring helper extends high/low and locks close to live Atlas spot
    const anchored = anchorCandlesToSpot(
      [
        { time: 1000, open: 61000, high: 61200, low: 60900, close: 61100 },
        { time: 1900, open: 61100, high: 61400, low: 61050, close: 61300 },
      ],
      61888.5
    );
    expect(anchored[1]!.close).toBe(61888.5);
    expect(anchored[1]!.high).toBe(61888.5);
    expect(anchored[1]!.low).toBe(61050);

    // 2. Mock Binance K-lines cold-start anchored to live Atlas BTC spot
    services.atlasOracle.setTelemetryOverride("BTC", { price: 62345.67 });
    services.marketData.setBinanceKlinesFetcher(async () => [
      [1795600000000, "62000", "62100", "61900", "62050"],
      [1795600900000, "62050", "62200", "62000", "62150"],
    ]);

    try {
      const binanceRes = await app.inject({
        method: "GET",
        url: "/api/market/candles?underlying=BTC&bar=15m&limit=40",
      });
      expect(binanceRes.statusCode).toBe(200);
      const binanceBody = binanceRes.json() as {
        source: string;
        candles: Array<{
          time: number;
          open: number;
          high: number;
          low: number;
          close: number;
        }>;
      };
      expect(binanceBody.source).toBe("BINANCE_KLINES");
      expect(binanceBody.candles).toHaveLength(2);
      const lastBar = binanceBody.candles[1]!;
      expect(lastBar.close).toBe(62345.67);
      expect(lastBar.high).toBe(62345.67);

      // 3. Offline / error fallback generates smooth synthetic candles anchored to Atlas spot
      services.marketData.setBinanceKlinesFetcher(async () => {
        throw new Error("network offline");
      });
      const synthRes = await app.inject({
        method: "GET",
        url: "/api/market/candles?underlying=BTC&bar=1H&limit=30",
      });
      expect(synthRes.statusCode).toBe(200);
      const synthBody = synthRes.json();
      expect(synthBody.source).toBe("SYNTHETIC");
      expect(synthBody.candles).toHaveLength(30);
      expect(synthBody.candles[synthBody.candles.length - 1].close).toBe(
        62345.67
      );
    } finally {
      services.marketData.setBinanceKlinesFetcher(undefined);
      services.atlasOracle.setTelemetryOverride("BTC", {
        price: 61500,
        consensusStatus: "HEALTHY",
        consensusScore: 0.947,
      });
    }
  });

  it("GET /api/market/shelf returns 4 fixed-grid target tiers and grid metadata for BTC & ETH", async () => {
    resetFixedGridCache();

    const bullRes = await app.inject({
      method: "GET",
      url: "/api/market/shelf?underlying=BTC&direction=BULL&tenor=DAILY&stake=20",
    });
    expect(bullRes.statusCode).toBe(200);
    const bullBody = bullRes.json() as {
      spot: number;
      stakeUsdt: number;
      grid: FixedGridMeta;
      tiers: TicketSummary[];
      availableStrikes: number[];
    };
    expect(bullBody.stakeUsdt).toBe(20);
    expect(bullBody.tiers).toHaveLength(4);
    expect(bullBody.grid.gridStep).toBe(500);
    expect(bullBody.grid.hysteresisBuffer).toBe(125);
    expect(bullBody.grid.gridHigh - bullBody.grid.gridLow).toBe(500);
    expect(bullBody.grid.anchorStartPrice).toBe(bullBody.grid.gridLow);
    expect(bullBody.grid.defaultIndex).toBe(1);

    for (let i = 0; i < bullBody.tiers.length; i++) {
      const t = bullBody.tiers[i]!;
      expect(t.startPrice).toBe(bullBody.grid.anchorStartPrice);
      expect(t.lowerStrike).toBe(bullBody.grid.gridLow);
      expect(t.guardrails.valid).toBe(true);
      expect(t.maxMultiplier).toBeGreaterThan(1.15);
      expect(t.stepSteps).toBe(GRID_CONFIG["BTC:DAILY"].offsets[i]);
      if (i > 0) {
        expect(t.capPrice).toBeGreaterThan(bullBody.tiers[i - 1]!.capPrice);
        expect(t.maxMultiplier).toBeGreaterThan(
          bullBody.tiers[i - 1]!.maxMultiplier
        );
      }
    }
    expect(bullBody.tiers[0]!.isSharedCenterPool).toBe(true);
    expect(bullBody.tiers[1]!.isSharedCenterPool).toBe(false);

    const bearRes = await app.inject({
      method: "GET",
      url: "/api/market/shelf?underlying=BTC&direction=BEAR&tenor=DAILY&stake=20",
    });
    expect(bearRes.statusCode).toBe(200);
    const bearBody = bearRes.json() as {
      grid: FixedGridMeta;
      tiers: TicketSummary[];
    };
    expect(bearBody.tiers).toHaveLength(4);
    expect(bearBody.grid.gridLow).toBe(bullBody.grid.gridLow);
    expect(bearBody.grid.gridHigh).toBe(bullBody.grid.gridHigh);
    expect(bearBody.tiers[0]!.isSharedCenterPool).toBe(true);
    expect(bearBody.tiers[0]!.lowerStrike).toBe(bullBody.tiers[0]!.lowerStrike);
    expect(bearBody.tiers[0]!.upperStrike).toBe(bullBody.tiers[0]!.upperStrike);

    for (const [underlying, tenor, expectedStep, expectedHyst] of [
      ["BTC", "WEEKLY", 500, 125],
      ["ETH", "DAILY", 25, 6],
      ["ETH", "WEEKLY", 50, 12],
    ] as const) {
      const res = await app.inject({
        method: "GET",
        url: `/api/market/shelf?underlying=${underlying}&direction=BULL&tenor=${tenor}&stake=20`,
      });
      expect(res.statusCode).toBe(200);
      const b = res.json() as { grid: FixedGridMeta; tiers: TicketSummary[] };
      expect(b.tiers).toHaveLength(4);
      expect(b.grid.gridStep).toBe(expectedStep);
      expect(b.grid.hysteresisBuffer).toBe(expectedHyst);
    }

    const badRes = await app.inject({
      method: "GET",
      url: "/api/market/shelf?underlying=SOL",
    });
    expect(badRes.statusCode).toBe(400);
  });

  it("locks fixed grid within hysteresis band (±$125 BTC) and snaps/extends outward on sparse strikes", () => {
    resetFixedGridCache();

    const makeBook = (
      spot: number,
      tenor: "DAILY" | "WEEKLY" = "DAILY",
      opts?: {
        hoursToExpiry?: number;
        iv?: number;
        filterStrikes?: (k: number) => boolean;
      }
    ): ExpiryBook => {
      const iv = opts?.iv ?? 0.6;
      const snap = services.marketData.buildSyntheticSnapshot(
        "BTC",
        spot,
        0,
        iv
      );
      const base = tenor === "DAILY" ? snap.daily! : snap.weekly!;
      const hoursToExpiry = opts?.hoursToExpiry ?? base.hoursToExpiry;
      const T = Math.max(hoursToExpiry, 0.25) / (365 * 24);
      const availableStrikes = opts?.filterStrikes
        ? base.availableStrikes.filter(opts.filterStrikes)
        : base.availableStrikes;
      const syntheticStrikes: ExpiryBook["syntheticStrikes"] = {};
      for (const k of availableStrikes) {
        const orig = base.syntheticStrikes[k]!;
        if (opts?.hoursToExpiry !== undefined) {
          const cFair = bsOptionPrice(true, spot, k, T, iv);
          const pFair = bsOptionPrice(false, spot, k, T, iv);
          const half = spot * 0.0002;
          syntheticStrikes[k] = {
            strike: k,
            call: {
              ...orig.call,
              bidUsd: Math.max(0.5, cFair - half),
              askUsd: Math.max(1.0, cFair + half),
              markUsd: cFair,
              iv,
            },
            put: {
              ...orig.put,
              bidUsd: Math.max(0.5, pFair - half),
              askUsd: Math.max(1.0, pFair + half),
              markUsd: pFair,
              iv,
            },
          };
        } else {
          syntheticStrikes[k] = orig;
        }
      }
      return {
        ...base,
        expiry: 1800000000 + (tenor === "WEEKLY" ? 86400 * 4 : 0),
        hoursToExpiry,
        atmIv: iv,
        availableStrikes,
        syntheticStrikes,
      };
    };

    const s0 = buildFixedGridShelf({
      book: makeBook(61700),
      direction: "BULL",
      stakeUsdt: 100,
      protocolFeeBps: 400,
    });
    expect(s0.grid.gridLow).toBe(61500);
    expect(s0.grid.gridHigh).toBe(62000);

    const sHighInside = buildFixedGridShelf({
      book: makeBook(62120),
      direction: "BULL",
      stakeUsdt: 100,
      protocolFeeBps: 400,
    });
    expect(sHighInside.grid.gridLow).toBe(61500);
    expect(sHighInside.grid.gridHigh).toBe(62000);

    const sShiftUp = buildFixedGridShelf({
      book: makeBook(62130),
      direction: "BULL",
      stakeUsdt: 100,
      protocolFeeBps: 400,
    });
    expect(sShiftUp.grid.gridLow).toBe(62000);
    expect(sShiftUp.grid.gridHigh).toBe(62500);
  });

  it("enforces Put-Call Parity no-arbitrage, <12% buy-then-sell friction, 45s TTL, and ConsensusScore quoting circuit breaker", async () => {
    resetFixedGridCache();

    // 1. Mathematical invariants
    for (const underlying of ["BTC", "ETH"] as const) {
      for (const tenor of ["DAILY", "WEEKLY"] as const) {
        const book = services.marketData.getExpiryBook(underlying, tenor);
        const { tiers } = buildFixedGridShelf({
          book,
          direction: "BULL",
          stakeUsdt: 100,
          protocolFeeBps: 400,
        });

        for (const tier of tiers) {
          const width = tier.upperStrike - tier.lowerStrike;
          const upFair = computeFairSpreadUnitUsd(
            book,
            true,
            tier.lowerStrike,
            tier.upperStrike
          );
          const downFair = computeFairSpreadUnitUsd(
            book,
            false,
            tier.lowerStrike,
            tier.upperStrike
          );
          expect(upFair + downFair).toBeCloseTo(width, 10);
          expect(
            computeMmOpenUnitUsd(upFair, width, 110) +
              computeMmOpenUnitUsd(downFair, width, 110)
          ).toBeGreaterThan(width);
          expect(
            computeMmCloseUnitUsd(upFair, width) +
              computeMmCloseUnitUsd(downFair, width)
          ).toBeLessThan(width);

          const exitEst = estimatePositionExitUsdt({
            book,
            isCall: true,
            lowerStrike: tier.lowerStrike,
            upperStrike: tier.upperStrike,
            remainingLongUsdt: tier.maxPayoutUsdt,
            hoursRemaining: book.hoursToExpiry,
          });
          const roundTripLossPct =
            ((tier.stakeUsdt - exitEst.bestBidUsdt) / tier.stakeUsdt) * 100;
          expect(roundTripLossPct).toBeGreaterThan(4);
          expect(roundTripLossPct).toBeLessThan(12);
        }
      }
    }

    // 2. End-to-end /api/rfq/open -> /api/rfq/close + CRITICAL circuit breaker
    const rtTaker = "0x5555555555555555555555555555555555555555" as const;
    const shelfRes = await app.inject({
      method: "GET",
      url: "/api/market/shelf?underlying=BTC&direction=BULL&tenor=DAILY&stake=100",
    });
    const stdTier = (shelfRes.json().tiers as TicketSummary[])[1]!;
    const fixedNow = Math.floor(Date.now() / 1000);

    const nowSpy = vi
      .spyOn(services.chain, "getEffectiveNow")
      .mockResolvedValue(fixedNow);
    const makerStateSpy = vi
      .spyOn(services.chain, "getMakerOnChainState")
      .mockResolvedValue({
        whitelisted: true,
        marginUnits: 500_000_000_000n,
        epoch: 1n,
      });

    try {
      const openRes = await app.inject({
        method: "POST",
        url: "/api/rfq/open",
        payload: {
          taker: rtTaker,
          underlying: "BTC",
          direction: "BULL",
          tenor: "DAILY",
          tierKind: stdTier.tierKind,
          lowerStrike: stdTier.lowerStrike,
          upperStrike: stdTier.upperStrike,
          stakeUsdt: 100,
        },
      });
      expect(openRes.statusCode).toBe(200);
      const openBody = openRes.json() as OpenRfqResponse;
      expect(openBody.quote.validUntil - fixedNow).toBe(45);
      expect(openBody.usdtAddress).toBe(
        "0x2222222222222222222222222222222222222222"
      );

      const maxPayoutUsdt = Number(openBody.quote.maxPayout) / 1e6;
      await services.db.upsertTicketOnOpen({
        seriesId: openBody.seriesId,
        isUp: 1,
        taker: rtTaker,
        maker: openBody.quote.maker,
        tierKind: stdTier.tierKind,
        underlying: "BTC",
        direction: "BULL",
        lowerStrike: stdTier.lowerStrike,
        upperStrike: stdTier.upperStrike,
        expiry: openBody.quote.expiry,
        maxPayout: maxPayoutUsdt,
        stakeUsdt: 100,
        protocolFeeUsdt: 3.85,
        openTxHash: "0x" + "f1".repeat(32),
        timestamp: fixedNow,
      });

      const readBalSpy = vi
        .spyOn(services.chain.publicClient, "readContract")
        .mockImplementation(async (req: any) => {
          if (req.functionName === "balanceOf") {
            const [account] = req.args as [string, bigint];
            if (account.toLowerCase() === rtTaker.toLowerCase()) {
              return BigInt(openBody.quote.maxPayout);
            }
            return 0n;
          }
          return 0n;
        });

      try {
        // Trigger CRITICAL ConsensusScore -> /api/rfq/open MUST reject (503 circuitBreaker)
        services.atlasOracle.setTelemetryOverride("BTC", {
          consensusStatus: "CRITICAL",
          consensusScore: 0.35,
        });

        const blockedOpen = await app.inject({
          method: "POST",
          url: "/api/rfq/open",
          payload: {
            taker: rtTaker,
            underlying: "BTC",
            direction: "BULL",
            tenor: "DAILY",
            tierKind: stdTier.tierKind,
            lowerStrike: stdTier.lowerStrike,
            upperStrike: stdTier.upperStrike,
            stakeUsdt: 100,
          },
        });
        expect(blockedOpen.statusCode).toBe(503);
        expect(blockedOpen.json().circuitBreaker).toBe(true);

        // Even during CRITICAL, /api/rfq/close MUST remain open so users are never trapped!
        const emergencyClose = await app.inject({
          method: "POST",
          url: "/api/rfq/close",
          payload: {
            taker: rtTaker,
            seriesId: openBody.seriesId,
            isUp: true,
          },
        });
        expect(emergencyClose.statusCode).toBe(200);
        const closeBody = emergencyClose.json() as CloseRfqResponse;
        expect(closeBody.quote.validUntil - fixedNow).toBe(45);
        expect(closeBody.netProceedsUsdt).toBeGreaterThan(0);
        expect(closeBody.netProceedsUsdt).toBeLessThan(100);
      } finally {
        readBalSpy.mockRestore();
        services.atlasOracle.setTelemetryOverride("BTC", {
          consensusStatus: "HEALTHY",
          consensusScore: 0.947,
        });
      }
    } finally {
      nowSpy.mockRestore();
      makerStateSpy.mockRestore();
    }
  });

  it("POST /api/market/preview-custom enforces all 3 guardrails and triggers Put-Call Parity on ITM spreads", async () => {
    const shelfRes = await app.inject({
      method: "GET",
      url: "/api/market/shelf?underlying=BTC&direction=BULL&tenor=DAILY&stake=20",
    });
    const { availableStrikes, spot } = shelfRes.json() as {
      availableStrikes: number[];
      spot: number;
    };

    const unaligned = await app.inject({
      method: "POST",
      url: "/api/market/preview-custom",
      payload: {
        underlying: "BTC",
        direction: "BULL",
        tenor: "DAILY",
        lowerStrike: availableStrikes[0]! + 123,
        upperStrike: availableStrikes[4]! + 123,
        stakeUsdt: 20,
      },
    });
    expect(unaligned.json().ticket.guardrails.strikeAligned).toBe(false);
    expect(unaligned.json().ticket.guardrails.valid).toBe(false);

    const wide = await app.inject({
      method: "POST",
      url: "/api/market/preview-custom",
      payload: {
        underlying: "BTC",
        direction: "BULL",
        tenor: "DAILY",
        lowerStrike: availableStrikes[8]!,
        upperStrike: availableStrikes[availableStrikes.length - 1]!,
        stakeUsdt: 20,
      },
    });
    expect(wide.json().ticket.guardrails.widthWithinCap).toBe(false);
    expect(wide.json().ticket.guardrails.valid).toBe(false);

    const itmStrikes = availableStrikes.filter((k) => k < spot);
    const deepLower = itmStrikes[Math.max(0, itmStrikes.length - 5)]!;
    const deepUpper = itmStrikes[Math.max(1, itmStrikes.length - 1)]!;
    const deepItm = await app.inject({
      method: "POST",
      url: "/api/market/preview-custom",
      payload: {
        underlying: "BTC",
        direction: "BULL",
        tenor: "DAILY",
        lowerStrike: deepLower,
        upperStrike: deepUpper,
        stakeUsdt: 20,
      },
    });
    const ticket = deepItm.json().ticket as TicketSummary;
    expect(ticket.guardrails.lowMultiplierWarning).toBe(true);
    expect(ticket.recommendedHedge?.isParityFlip).toBe(true);
    expect(ticket.recommendedHedge?.route).toBe("PARITY_PUT_SPREAD");
  });

  it("POST /api/rfq/open returns valid EIP-712 v2 signature, checks makerMargin/whitelist, and rejects self-trade", async () => {
    const shelfRes = await app.inject({
      method: "GET",
      url: "/api/market/shelf?underlying=ETH&direction=BULL&tenor=DAILY&stake=20",
    });
    const stdTier = (shelfRes.json().tiers as TicketSummary[])[1]!;
    const taker = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65" as const;

    const stateSpy = vi
      .spyOn(services.chain, "getMakerOnChainState")
      .mockImplementation(async (maker) => ({
        whitelisted: true,
        marginUnits:
          maker.toLowerCase() === services.config.makers[0]!.address.toLowerCase()
            ? 1_000_000n // 1 USDT (insufficient)
            : 500_000_000_000n,
        epoch: 3n,
      }));

    try {
      const rfqRes = await app.inject({
        method: "POST",
        url: "/api/rfq/open",
        payload: {
          taker,
          underlying: "ETH",
          direction: "BULL",
          tenor: "DAILY",
          tierKind: "STANDARD",
          lowerStrike: stdTier.lowerStrike,
          upperStrike: stdTier.upperStrike,
          stakeUsdt: 20,
        },
      });
      expect(rfqRes.statusCode).toBe(200);
      const body = rfqRes.json() as OpenRfqResponse;
      expect(body.competingQuotes).toHaveLength(2);
      expect(body.quote.maker.toLowerCase()).not.toBe(
        services.config.makers[0]!.address.toLowerCase()
      );
      expect(body.quote.assetId).toBe(ASSET_ETH_ID);
      expect(body.quote.isUp).toBe(true);
      expect(body.quote.makerEpoch).toBe("3");

      const recovered = await recoverTypedDataAddress({
        domain: getPayoffEip712Domain(body.chainId, body.verifyingContract),
        types: OPEN_QUOTE_TYPES,
        primaryType: "OpenQuote",
        message: {
          taker: body.quote.taker,
          maker: body.quote.maker,
          assetId: body.quote.assetId,
          isUp: body.quote.isUp,
          lowerStrike: BigInt(body.quote.lowerStrike),
          upperStrike: BigInt(body.quote.upperStrike),
          expiry: BigInt(body.quote.expiry),
          userPayAmount: BigInt(body.quote.userPayAmount),
          maxPayout: BigInt(body.quote.maxPayout),
          maxProtocolFeeBps: body.quote.maxProtocolFeeBps,
          makerEpoch: BigInt(body.quote.makerEpoch),
          validUntil: BigInt(body.quote.validUntil),
          nonce: BigInt(body.quote.nonce),
        },
        signature: body.signature,
      });
      expect(recovered.toLowerCase()).toBe(body.quote.maker.toLowerCase());

      // Zero margin across all makers -> rejected cleanly
      stateSpy.mockResolvedValue({
        whitelisted: true,
        marginUnits: 0n,
        epoch: 0n,
      });
      const dryRes = await app.inject({
        method: "POST",
        url: "/api/rfq/open",
        payload: {
          taker,
          underlying: "ETH",
          direction: "BULL",
          tenor: "DAILY",
          tierKind: "STANDARD",
          lowerStrike: stdTier.lowerStrike,
          upperStrike: stdTier.upperStrike,
          stakeUsdt: 20,
        },
      });
      expect(dryRes.statusCode).toBe(400);
      expect(dryRes.json().error).toContain("makerMargin");
    } finally {
      stateSpy.mockRestore();
    }

    // Self-trade rejection when single configured maker equals taker
    const singleMakerApp = await buildApp({
      databaseUrl: undefined,
      dbPath: ":memory:",
      rpcUrl: "http://127.0.0.1:8545",
      enableLiveAtlas: false,
      enableBinanceKlines: false,
      vaultAddress: "0x1111111111111111111111111111111111111111",
      usdtAddress: "0x2222222222222222222222222222222222222222",
      chainId: 31337,
      makers: [services.config.makers[0]!],
    });
    try {
      const selfRes = await singleMakerApp.app.inject({
        method: "POST",
        url: "/api/rfq/open",
        payload: {
          taker: services.config.makers[0]!.address,
          underlying: "ETH",
          direction: "BULL",
          tenor: "DAILY",
          tierKind: "STANDARD",
          lowerStrike: stdTier.lowerStrike,
          upperStrike: stdTier.upperStrike,
          stakeUsdt: 20,
        },
      });
      expect(selfRes.statusCode).toBe(400);
      expect(selfRes.json().error).toMatch(/self-trade/i);
    } finally {
      await singleMakerApp.app.close();
    }
  });

  it("supports dual UP + DOWN positions on same seriesId and validates CloseQuote EIP-712 recovery", async () => {
    const dualBuyer = "0x8888888888888888888888888888888888888888" as const;
    const expiry = Math.floor(Date.now() / 1000) + 86400;
    const sharedSid = computeSeriesId(
      ASSET_BTC_ID,
      61000_00000000n,
      63000_00000000n,
      expiry
    );

    await services.db.upsertTicketOnOpen({
      seriesId: sharedSid,
      isUp: 1,
      taker: dualBuyer,
      maker: services.config.makers[0]!.address,
      tierKind: "STANDARD",
      underlying: "BTC",
      direction: "BULL",
      lowerStrike: 61000,
      upperStrike: 63000,
      expiry,
      maxPayout: 55,
      stakeUsdt: 20,
      protocolFeeUsdt: 0.77,
      openTxHash: "0x" + "a1".repeat(32),
      timestamp: Math.floor(Date.now() / 1000) - 120,
    });
    await services.db.upsertTicketOnOpen({
      seriesId: sharedSid,
      isUp: 0,
      taker: dualBuyer,
      maker: services.config.makers[1]!.address,
      tierKind: "CUSTOM",
      underlying: "BTC",
      direction: "BEAR",
      lowerStrike: 61000,
      upperStrike: 63000,
      expiry,
      maxPayout: 45,
      stakeUsdt: 18,
      protocolFeeUsdt: 0.69,
      openTxHash: "0x" + "a2".repeat(32),
      timestamp: Math.floor(Date.now() / 1000) - 60,
    });

    const onChainSpy = vi
      .spyOn(services.chain, "getUserActivePositionsOnChain")
      .mockResolvedValue([
        {
          tokenId: computeUpTokenId(sharedSid).toString(),
          seriesId: sharedSid,
          assetId: ASSET_BTC_ID,
          underlying: "BTC",
          direction: "BULL",
          isUp: true,
          lowerStrike: 61000,
          upperStrike: 63000,
          expiry,
          balanceUsdt: 55,
          settled: false,
          settlementPrice: 0,
          claimableUsdt: 0,
        },
        {
          tokenId: computeDownTokenId(sharedSid).toString(),
          seriesId: sharedSid,
          assetId: ASSET_BTC_ID,
          underlying: "BTC",
          direction: "BEAR",
          isUp: false,
          lowerStrike: 61000,
          upperStrike: 63000,
          expiry,
          balanceUsdt: 45,
          settled: false,
          settlementPrice: 0,
          claimableUsdt: 0,
        },
      ]);

    const readContractSpy = vi
      .spyOn(services.chain.publicClient, "readContract")
      .mockImplementation(async (req: any) => {
        if (req.functionName === "balanceOf") {
          const [account, tokenId] = req.args as [string, bigint];
          if (account.toLowerCase() === dualBuyer.toLowerCase()) {
            return tokenId === computeDownTokenId(sharedSid)
              ? 45_000_000n
              : 55_000_000n;
          }
          if (
            account.toLowerCase() ===
              services.config.makers[1]!.address.toLowerCase() &&
            tokenId === computeUpTokenId(sharedSid)
          ) {
            return 45_000_000n;
          }
          return 0n;
        }
        return 0n;
      });
    const makerStateSpy = vi
      .spyOn(services.chain, "getMakerOnChainState")
      .mockResolvedValue({
        whitelisted: true,
        marginUnits: 500_000_000_000n,
        epoch: 2n,
      });

    try {
      const posRes = await app.inject({
        method: "GET",
        url: `/api/positions/${dualBuyer}`,
      });
      expect(posRes.statusCode).toBe(200);
      const { positions } = posRes.json();
      expect(positions).toHaveLength(2);
      const upPos = positions.find((p: any) => p.isUp === true);
      const downPos = positions.find((p: any) => p.isUp === false);
      expect(upPos.remainingBalanceUsdt).toBe(55);
      expect(downPos.remainingBalanceUsdt).toBe(45);

      const ambigClose = await app.inject({
        method: "POST",
        url: "/api/rfq/close",
        payload: { taker: dualBuyer, seriesId: sharedSid },
      });
      expect(ambigClose.statusCode).toBe(400);
      expect(ambigClose.json().error).toContain("isUp");

      const closeDownRes = await app.inject({
        method: "POST",
        url: "/api/rfq/close",
        payload: {
          taker: dualBuyer,
          seriesId: sharedSid,
          isUp: false,
          closeAmountUsdt: 45,
        },
      });
      expect(closeDownRes.statusCode).toBe(200);
      const closeBody = closeDownRes.json() as CloseRfqResponse;
      expect(closeBody.executionMode).toBe("ATOMIC_MERGE_UNLOCK");
      expect(closeBody.quote.maker.toLowerCase()).toBe(
        services.config.makers[1]!.address.toLowerCase()
      );

      const recovered = await recoverTypedDataAddress({
        domain: getPayoffEip712Domain(
          closeBody.chainId,
          closeBody.verifyingContract
        ),
        types: CLOSE_QUOTE_TYPES,
        primaryType: "CloseQuote",
        message: {
          taker: closeBody.quote.taker,
          maker: closeBody.quote.maker,
          seriesId: closeBody.quote.seriesId,
          isUp: closeBody.quote.isUp,
          amount: BigInt(closeBody.quote.amount),
          buybackAmount: BigInt(closeBody.quote.buybackAmount),
          maxCloseFeeBps: closeBody.quote.maxCloseFeeBps,
          makerEpoch: BigInt(closeBody.quote.makerEpoch),
          validUntil: BigInt(closeBody.quote.validUntil),
          nonce: BigInt(closeBody.quote.nonce),
        },
        signature: closeBody.signature,
      });
      expect(recovered.toLowerCase()).toBe(closeBody.quote.maker.toLowerCase());
    } finally {
      onChainSpy.mockRestore();
      readContractSpy.mockRestore();
      makerStateSpy.mockRestore();
    }
  });

  it("Atlas Permissionless Settlement Keeper pauses on WARNING/CRITICAL and settles with trailing extraData when HEALTHY", async () => {
    const expiry = PRODUCTION_ATLAS_HISTORY_BTC.timestampSeconds;
    const buyer = "0x9999999999999999999999999999999999999999";

    await services.db.upsertTicketOnOpen({
      seriesId: "0x" + "cc".repeat(32),
      isUp: 1,
      taker: buyer,
      maker: services.config.makers[0]!.address,
      tierKind: "STANDARD",
      underlying: "BTC",
      direction: "BULL",
      lowerStrike: 58000,
      upperStrike: 60000,
      expiry,
      maxPayout: 50,
      stakeUsdt: 20,
      protocolFeeUsdt: 0.77,
      openTxHash: "0x" + "11".repeat(32),
      timestamp: expiry - 3600,
    });

    services.atlasOracle.setHttpFetcher(async (endpoint) => {
      if (endpoint === "/v1/price/history") {
        return {
          payload: PRODUCTION_ATLAS_HISTORY_BTC.payload,
          signature: PRODUCTION_ATLAS_HISTORY_BTC.signature,
          magicMarker: PRODUCTION_ATLAS_HISTORY_BTC.magicMarker,
        };
      }
      throw new Error("unexpected endpoint");
    });

    const readSpy = vi
      .spyOn(services.chain, "readOnChainSettlement")
      .mockResolvedValue({
        settlementPrice: 0,
        settledAt: 0,
        settled: false,
        feedIdHex: null,
        oracleTimestamp: null,
        submitter: null,
      });
    const nowSpy = vi
      .spyOn(services.chain, "getEffectiveNow")
      .mockResolvedValue(expiry + 120);
    const fakeTxHash = ("0x" + "ab".repeat(32)) as Hex;
    const submitSpy = vi
      .spyOn(services.chain, "submitAtlasSettlementProofOnChain")
      .mockImplementation(async (underlying, exp, proof) => {
        // Confirm encoded calldata appends trailing Atlas extraData ending with 0x7096
        const encoded = services.chain.encodeSettleWithAtlasProofData(
          underlying,
          exp,
          proof.extraData
        );
        expect(encoded.endsWith("7096")).toBe(true);
        await services.db.recordSettlement({
          underlying,
          expiry: exp,
          settlementPrice: Number(PRODUCTION_ATLAS_HISTORY_BTC.expectedPrice8) / 1e8,
          txHash: fakeTxHash,
          settledAt: exp + 120,
          source: proof.source,
          feedId: proof.feedId,
          feedIdHex: proof.feedIdHex,
          oracleTimestamp: proof.timestampSeconds,
          submitter: services.chain.getOracleAddress(),
        });
        return fakeTxHash;
      });

    try {
      // 1. WARNING status -> Settlement Circuit Breaker MUST pause automated settlement
      services.atlasOracle.setTelemetryOverride("BTC", {
        consensusStatus: "WARNING",
        consensusScore: 0.68,
      });
      const pausedResults = await services.chain.runSettlementKeeper();
      expect(pausedResults).toHaveLength(0);
      expect(submitSpy).not.toHaveBeenCalled();

      // 2. Restore HEALTHY -> Keeper fetches signed Atlas history proof and settles!
      services.atlasOracle.setTelemetryOverride("BTC", {
        consensusStatus: "HEALTHY",
        consensusScore: 0.95,
      });
      const settledResults = await services.chain.runSettlementKeeper();
      expect(settledResults).toHaveLength(1);
      expect(settledResults[0]!.underlying).toBe("BTC");
      expect(settledResults[0]!.expiry).toBe(expiry);
      expect(settledResults[0]!.source).toBe("ATLAS_PULL_HISTORY");
      expect(settledResults[0]!.feedId).toBe("626");
      expect(submitSpy).toHaveBeenCalledTimes(1);

      // 3. GET /api/market/settlement-history returns Atlas settled record + proof metadata
      const histRes = await app.inject({
        method: "GET",
        url: "/api/market/settlement-history?underlying=BTC&limit=5",
      });
      expect(histRes.statusCode).toBe(200);
      const hist = histRes.json();
      expect(hist.feedId).toBe("626");
      expect(hist.oracleAddress).toBe(
        "0x3333333333333333333333333333333333333333"
      );
      expect(hist.records).toHaveLength(1);
      expect(hist.records[0].source).toBe("ATLAS_PULL_HISTORY");
      expect(hist.records[0].oracleTimestamp).toBe(expiry);
      expect(hist.records[0].txHash).toBe(fakeTxHash);
    } finally {
      readSpy.mockRestore();
      nowSpy.mockRestore();
      submitSpy.mockRestore();
      services.atlasOracle.setHttpFetcher(undefined);
    }
  });

  it("aggregates Phase 1 metrics in /api/metrics with USDT fields and handles /api/tx/ingest validation", async () => {
    const buyer1 = "0x15d34aaf54267db7d7c367839aaf71a00a2c6a65";
    await services.db.upsertTicketOnOpen({
      seriesId: "0x" + "aa".repeat(32),
      isUp: 1,
      taker: buyer1,
      maker: services.config.makers[0]!.address,
      tierKind: "STANDARD",
      underlying: "BTC",
      direction: "BULL",
      lowerStrike: 62000,
      upperStrike: 64000,
      expiry: 1795507200,
      maxPayout: 59,
      stakeUsdt: 20,
      protocolFeeUsdt: 0.77,
      openTxHash: "0x" + "01".repeat(32),
      timestamp: 1795420000,
    });
    await services.db.upsertTicketOnOpen({
      seriesId: "0x" + "bb".repeat(32),
      isUp: 1,
      taker: buyer1,
      maker: services.config.makers[0]!.address,
      tierKind: "CUSTOM",
      underlying: "BTC",
      direction: "BULL",
      lowerStrike: 60500,
      upperStrike: 62500,
      expiry: 1795507200,
      maxPayout: 32,
      stakeUsdt: 20,
      protocolFeeUsdt: 0.77,
      openTxHash: "0x" + "02".repeat(32),
      timestamp: 1795420100,
    });
    await services.db.updateTicketOnClose({
      seriesId: "0x" + "aa".repeat(32),
      isUp: 1,
      taker: buyer1,
      closedAmount: 59,
      buybackNetUsdt: 28.3,
      timestamp: 1795430000,
    });
    await services.db.insertHedgeLedger({
      txHash: "0x" + "03".repeat(32),
      action: "CLOSE",
      seriesId: "0x" + "aa".repeat(32),
      underlying: "BTC",
      direction: "BULL",
      lowerStrike: 62000,
      upperStrike: 64000,
      makerName: "Payoff Reference Desk",
      venue: "MOCK_MAKER",
      hedgeRoute: "DIRECT_CALL_SPREAD",
      isParityFlip: false,
      longLegInstId: "BTC-C1",
      shortLegInstId: "BTC-C2",
      notionalUnderlying: 0.0295,
      rawExchangeCostUsd: 28.6,
      exchangeFeeUsd: 0.15,
      paritySavedUsd: 0,
      userCashflowUsd: 28.3,
      protocolFeeUsd: 0,
      mmNetMarginUsd: 0.3,
      capitalUnlockedUsdt: 59,
      executionMode: "ATOMIC_MERGE_UNLOCK",
      createdAt: 1795430000,
    });

    const mRes = await app.inject({ method: "GET", url: "/api/metrics" });
    expect(mRes.statusCode).toBe(200);
    const m = mRes.json() as Phase1Metrics;
    expect(m.uniqueBuyers).toBeGreaterThanOrEqual(1);
    expect(m.repeatBuyers).toBeGreaterThanOrEqual(1);
    expect(m.atomicMergeUnlocks).toBe(1);
    expect(m.totalCapitalUnlockedUsdt).toBe(59);
    expect(typeof m.vaultMakerMarginUsdt).toBe("number");
    expect(typeof m.vaultAccruedProtocolFeesUsdt).toBe("number");

    const badIngest = await app.inject({
      method: "POST",
      url: "/api/tx/ingest",
      payload: { txHash: "not-a-hash" },
    });
    expect(badIngest.statusCode).toBe(400);

    const receiptSpy = vi
      .spyOn(services.chain.publicClient, "waitForTransactionReceipt")
      .mockResolvedValue({
        status: "reverted",
        blockNumber: 12345n,
        logs: [],
      } as any);
    try {
      const revRes = await app.inject({
        method: "POST",
        url: "/api/tx/ingest",
        payload: { txHash: "0x" + "ee".repeat(32) },
      });
      expect(revRes.statusCode).toBe(400);
      expect(revRes.json().error).toContain("reverted");
    } finally {
      receiptSpy.mockRestore();
    }
  });

  it("GET /api/market/settlement-history backfills settled on-chain 08:00 UTC expiries via eth_call when eth_getLogs is throttled", async () => {
    const expiry = PRODUCTION_ATLAS_HISTORY_BTC.timestampSeconds;
    const nowSpy = vi
      .spyOn(services.chain, "getEffectiveNow")
      .mockResolvedValue(expiry + 3600);
    const syncSpy = vi
      .spyOn(services.chain, "syncEvents")
      .mockResolvedValue(undefined);
    const readSpy = vi
      .spyOn(services.chain, "readOnChainSettlement")
      .mockImplementation(async (sym, exp) => {
        if (sym === "ETH" && exp === expiry) {
          return {
            settlementPrice: 1642.19787142,
            settledAt: expiry + 30,
            settled: true,
            feedIdHex: ATLAS_FEEDS.ETH.feedIdHex,
            oracleTimestamp: expiry,
            submitter: "0x000000000000000000000000000000000000dEaD",
          };
        }
        return {
          settlementPrice: 0,
          settledAt: 0,
          settled: false,
          feedIdHex: null,
          oracleTimestamp: null,
          submitter: null,
        };
      });

    try {
      const histRes = await app.inject({
        method: "GET",
        url: "/api/market/settlement-history?underlying=ETH&limit=5",
      });
      expect(histRes.statusCode).toBe(200);
      const body = histRes.json();
      expect(body.underlying).toBe("ETH");
      expect(body.feedId).toBe("632");
      expect(body.records).toHaveLength(1);
      expect(body.records[0].expiry).toBe(expiry);
      expect(body.records[0].priceUsd).toBeCloseTo(1642.19787142, 6);
      expect(body.records[0].source).toBe("ONCHAIN_SYNCED");
    } finally {
      nowSpy.mockRestore();
      syncSpy.mockRestore();
      readSpy.mockRestore();
    }
  });
});

import { describe, expect, it } from "vitest";
import { recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ASSET_BTC_ID,
  ASSET_NVDAB_ID,
  ATLAS_FEEDS,
  BSC_TESTNET,
  bsOptionPrice,
  CLOSE_QUOTE_TYPES,
  computeSeriesId,
  estimateCustomTicketPreview,
  generateOccEquityStrikes,
  getPayoffEip712Domain,
  OPEN_QUOTE_TYPES,
  priceToUnits,
  resolveClampedCustomRange,
  usdtToUnits,
  type AtlasFeedTelemetry,
  type ExpiryBook,
  type ExpiryTenor,
  type OptionStrikeQuote,
  type RwaAssetTelemetry,
} from "@payoff/shared";
import {
  buildFixedGridShelf,
  computeCombinedRiskAdjustments,
  computeConsensusRiskAdjustments,
  computeFairSpreadUnitUsd,
  computeMmCloseUnitUsd,
  computeMmOpenUnitUsd,
  computeRwaRiskAdjustments,
  ConsensusCircuitBreakerError,
  estimatePositionExitUsdt,
  GRID_CONFIG,
  MockMakerSigner,
  priceSpreadOnVenue,
  resetFixedGridCache,
  ShelfEngine,
} from "../src/index.js";

// Deterministic Hardhat/Anvil test private keys (never used on mainnet or funded wallets)
const TEST_MAKER_PK =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const TEST_TAKER_ADDR =
  "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;
const TEST_VAULT_ADDR =
  "0x1111111111111111111111111111111111111111" as const;

function buildTestBook(spot = 90_000, iv = 0.6, hoursToExpiry = 24): ExpiryBook {
  const expiry = 1_800_000_000;
  const strikes: number[] = [];
  for (let k = 84_000; k <= 96_000; k += 500) {
    strikes.push(k);
  }
  const T = hoursToExpiry / (365 * 24);
  const syntheticStrikes: Record<number, OptionStrikeQuote> = {};
  for (const strike of strikes) {
    const cFair = bsOptionPrice(true, spot, strike, T, iv);
    const pFair = bsOptionPrice(false, spot, strike, T, iv);
    const half = spot * 0.0003;
    syntheticStrikes[strike] = {
      strike,
      call: {
        strike,
        instId: `BTC-USD-TEST-${strike}-C`,
        bidUsd: Math.max(0.5, cFair - half),
        askUsd: Math.max(1.0, cFair + half),
        markUsd: cFair,
        iv,
        bidSize: 50,
        askSize: 50,
      },
      put: {
        strike,
        instId: `BTC-USD-TEST-${strike}-P`,
        bidUsd: Math.max(0.5, pFair - half),
        askUsd: Math.max(1.0, pFair + half),
        markUsd: pFair,
        iv,
        bidSize: 50,
        askSize: 50,
      },
    };
  }
  return {
    underlying: "BTC",
    tenor: "DAILY",
    expiry,
    expiryIso: new Date(expiry * 1000).toISOString(),
    hoursToExpiry,
    spot,
    atmIv: iv,
    availableStrikes: strikes,
    syntheticStrikes,
  };
}

function makeTelemetry(
  overrides: Partial<AtlasFeedTelemetry> = {}
): AtlasFeedTelemetry {
  return {
    underlying: "BTC",
    feedId: ATLAS_FEEDS.BTC.feedId,
    feedIdHex: ATLAS_FEEDS.BTC.feedIdHex,
    price: 90_000,
    timestampSeconds: Math.floor(Date.now() / 1000),
    consensusScore: 0.96,
    consensusStatus: "HEALTHY",
    twapPrice: 89_980,
    medianPrice: 90_005,
    priceChangePct: 1.25,
    priceVolatility: 0.002,
    updatedAtMs: Date.now(),
    ...overrides,
  };
}

describe("@payoff/mock-maker pricing, Put-Call Parity & Atlas ConsensusScore risk engine", () => {
  it("enforces strict Put-Call Parity no-arbitrage across strikes and risk regimes", () => {
    const book = buildTestBook(90_250, 0.62, 24);
    const pairs: Array<[number, number]> = [
      [88_000, 90_000],
      [90_000, 90_500],
      [90_000, 92_000],
      [91_000, 93_000],
    ];
    const regimes: Array<AtlasFeedTelemetry | undefined> = [
      undefined,
      makeTelemetry({ consensusStatus: "HEALTHY", consensusScore: 0.95 }),
      makeTelemetry({
        consensusStatus: "DEGRADED",
        consensusScore: 0.78,
        priceVolatility: 0.03,
      }),
      makeTelemetry({
        consensusStatus: "WARNING",
        consensusScore: 0.65,
        priceVolatility: 0.06,
      }),
    ];

    for (const telemetry of regimes) {
      const risk = computeConsensusRiskAdjustments(telemetry);
      for (const [k1, k2] of pairs) {
        const width = k2 - k1;
        const upFair = computeFairSpreadUnitUsd(book, true, k1, k2, undefined, telemetry);
        const downFair = computeFairSpreadUnitUsd(book, false, k1, k2, undefined, telemetry);

        // Exact Put-Call Parity fair mid
        expect(upFair + downFair).toBeCloseTo(width, 8);

        // No-arbitrage open ask: UP_ask + DOWN_ask > width
        const upAsk = computeMmOpenUnitUsd(upFair, width, 110, risk.spreadMultiplier);
        const downAsk = computeMmOpenUnitUsd(downFair, width, 110, risk.spreadMultiplier);
        expect(upAsk).toBeGreaterThan(upFair);
        expect(downAsk).toBeGreaterThan(downFair);
        expect(upAsk + downAsk).toBeGreaterThan(width);

        // No-arbitrage close bid: UP_bid + DOWN_bid < width
        const upBid = computeMmCloseUnitUsd(upFair, width, risk.spreadMultiplier);
        const downBid = computeMmCloseUnitUsd(downFair, width, risk.spreadMultiplier);
        expect(upBid).toBeLessThan(upFair);
        expect(downBid).toBeLessThan(downFair);
        expect(upBid + downBid).toBeLessThan(width);
      }
    }
  });

  it("widens spreads and boosts IV floor on Atlas DEGRADED / WARNING and priceVolatility spikes", () => {
    const book = buildTestBook(90_000, 0.55, 24);
    const healthy = makeTelemetry({
      consensusStatus: "HEALTHY",
      consensusScore: 0.97,
      priceVolatility: 0.001,
    });
    const degraded = makeTelemetry({
      consensusStatus: "DEGRADED",
      consensusScore: 0.8,
      priceVolatility: 0.02,
    });
    const warning = makeTelemetry({
      consensusStatus: "WARNING",
      consensusScore: 0.64,
      priceVolatility: 0.05,
    });

    const rHealthy = computeConsensusRiskAdjustments(healthy);
    const rDegraded = computeConsensusRiskAdjustments(degraded);
    const rWarning = computeConsensusRiskAdjustments(warning);

    expect(rHealthy.quotingAllowed).toBe(true);
    expect(rHealthy.spreadMultiplier).toBe(1.0);
    expect(rHealthy.ivFloorBoost).toBe(0);

    expect(rDegraded.quotingAllowed).toBe(true);
    expect(rDegraded.spreadMultiplier).toBeGreaterThan(rHealthy.spreadMultiplier);
    expect(rDegraded.ivFloorBoost).toBeGreaterThan(0);

    expect(rWarning.quotingAllowed).toBe(true);
    expect(rWarning.spreadMultiplier).toBeGreaterThan(rDegraded.spreadMultiplier);
    expect(rWarning.ivFloorBoost).toBeGreaterThan(rDegraded.ivFloorBoost);

    // Priced spread maxPayoutUsdt shrinks (wider ask) under DEGRADED and WARNING
    const pHealthy = priceSpreadOnVenue({
      book,
      tierKind: "STANDARD",
      tierLabel: "Target $91,500",
      direction: "BULL",
      lowerStrike: 90_000,
      upperStrike: 91_500,
      stakeUsdt: 100,
      protocolFeeBps: 400,
      mmOpenMarkupBps: 110,
      atlasTelemetry: healthy,
    });
    const pDegraded = priceSpreadOnVenue({
      book,
      tierKind: "STANDARD",
      tierLabel: "Target $91,500",
      direction: "BULL",
      lowerStrike: 90_000,
      upperStrike: 91_500,
      stakeUsdt: 100,
      protocolFeeBps: 400,
      mmOpenMarkupBps: 110,
      atlasTelemetry: degraded,
    });
    const pWarning = priceSpreadOnVenue({
      book,
      tierKind: "STANDARD",
      tierLabel: "Target $91,500",
      direction: "BULL",
      lowerStrike: 90_000,
      upperStrike: 91_500,
      stakeUsdt: 100,
      protocolFeeBps: 400,
      mmOpenMarkupBps: 110,
      atlasTelemetry: warning,
    });

    expect(pHealthy.venue).toBe("MOCK_MAKER");
    expect(pDegraded.summary.maxPayoutUsdt).toBeLessThan(
      pHealthy.summary.maxPayoutUsdt
    );
    expect(pWarning.summary.maxPayoutUsdt).toBeLessThan(
      pDegraded.summary.maxPayoutUsdt
    );

    // Indicative early exit bid also becomes more conservative under WARNING
    const exitHealthy = estimatePositionExitUsdt({
      book,
      isCall: true,
      lowerStrike: 90_000,
      upperStrike: 91_500,
      remainingLongUsdt: 200,
      hoursRemaining: 24,
      atlasTelemetry: healthy,
    });
    const exitWarning = estimatePositionExitUsdt({
      book,
      isCall: true,
      lowerStrike: 90_000,
      upperStrike: 91_500,
      remainingLongUsdt: 200,
      hoursRemaining: 24,
      atlasTelemetry: warning,
    });
    expect(exitWarning.bestBidUsdt).toBeLessThan(exitHealthy.bestBidUsdt);
  });

  it("generates hysteresis-locked fixed-grid shelf with 4 tiers and shared center pool", () => {
    resetFixedGridCache();
    const engine = new ShelfEngine();
    const book1 = buildTestBook(90_200, 0.6, 24);
    const shelf1 = engine.buildFixedGridShelf({
      book: book1,
      direction: "BULL",
      stakeUsdt: 20,
      protocolFeeBps: 400,
      atlasTelemetry: makeTelemetry(),
    });

    expect(shelf1.grid.gridLow).toBe(90_000);
    expect(shelf1.grid.gridHigh).toBe(90_500);
    expect(shelf1.tiers.length).toBe(4);
    expect(shelf1.tiers[0]?.isSharedCenterPool).toBe(true);

    // Spot moves slightly below gridLow within hysteresis buffer (125) -> stays locked to 90,000
    const book2 = buildTestBook(89_920, 0.6, 24);
    const shelf2 = buildFixedGridShelf({
      book: book2,
      direction: "BULL",
      stakeUsdt: 20,
      protocolFeeBps: 400,
    });
    expect(shelf2.grid.gridLow).toBe(90_000);
    expect(shelf2.grid.gridHigh).toBe(90_500);
  });

  it("halts OpenQuote signing on CRITICAL / SPLIT_MARKET while still allowing CloseQuote exits, and produces valid EIP-712 signatures", async () => {
    const makerAccount = privateKeyToAccount(TEST_MAKER_PK);
    const signer = new MockMakerSigner({
      chainId: BSC_TESTNET.chainId,
      verifyingContract: TEST_VAULT_ADDR,
      makers: [
        {
          id: "mm1",
          name: "Payoff Reference MM #1",
          privateKey: TEST_MAKER_PK,
          openMarkupBps: 110,
          closeCompetitivenessBps: 15,
        },
      ],
    });

    const expiry = 1_800_000_000;
    const validUntil = 1_799_999_000;
    const lowerStrike8 = priceToUnits(90_000);
    const upperStrike8 = priceToUnits(92_000);
    const openInput = {
      taker: TEST_TAKER_ADDR,
      maker: makerAccount.address,
      assetId: ASSET_BTC_ID,
      isUp: true,
      lowerStrike: lowerStrike8,
      upperStrike: upperStrike8,
      expiry,
      userPayAmount: usdtToUnits(20),
      maxPayout: usdtToUnits(54),
      maxProtocolFeeBps: 400,
      makerEpoch: 0n,
      validUntil,
      nonce: 1001n,
    };

    // 1. CRITICAL and SPLIT_MARKET reject OpenQuote via ConsensusCircuitBreakerError
    await expect(
      signer.signOpenQuote({
        quote: openInput,
        atlasTelemetry: makeTelemetry({
          consensusStatus: "CRITICAL",
          consensusScore: 0.42,
        }),
      })
    ).rejects.toBeInstanceOf(ConsensusCircuitBreakerError);

    await expect(
      signer.signOpenQuote({
        quote: openInput,
        atlasTelemetry: makeTelemetry({
          consensusStatus: "SPLIT_MARKET",
          consensusScore: 0.31,
        }),
      })
    ).rejects.toBeInstanceOf(ConsensusCircuitBreakerError);

    // 2. HEALTHY signs valid EIP-712 OpenQuote recoverable to maker address
    const signedOpen = await signer.signOpenQuote({
      quote: openInput,
      atlasTelemetry: makeTelemetry({ consensusStatus: "HEALTHY" }),
    });
    const expectedSeriesId = computeSeriesId(
      ASSET_BTC_ID,
      lowerStrike8,
      upperStrike8,
      expiry
    );
    expect(signedOpen.seriesId).toBe(expectedSeriesId);

    const recoveredOpen = await recoverTypedDataAddress({
      domain: getPayoffEip712Domain(BSC_TESTNET.chainId, TEST_VAULT_ADDR),
      types: OPEN_QUOTE_TYPES,
      primaryType: "OpenQuote",
      message: {
        taker: signedOpen.quote.taker,
        maker: signedOpen.quote.maker,
        assetId: signedOpen.quote.assetId,
        isUp: signedOpen.quote.isUp,
        lowerStrike: BigInt(signedOpen.quote.lowerStrike),
        upperStrike: BigInt(signedOpen.quote.upperStrike),
        expiry: BigInt(signedOpen.quote.expiry),
        userPayAmount: BigInt(signedOpen.quote.userPayAmount),
        maxPayout: BigInt(signedOpen.quote.maxPayout),
        maxProtocolFeeBps: signedOpen.quote.maxProtocolFeeBps,
        makerEpoch: BigInt(signedOpen.quote.makerEpoch),
        validUntil: BigInt(signedOpen.quote.validUntil),
        nonce: BigInt(signedOpen.quote.nonce),
      },
      signature: signedOpen.signature,
    });
    expect(recoveredOpen.toLowerCase()).toBe(makerAccount.address.toLowerCase());

    // 3. CloseQuote still signs even during CRITICAL / SPLIT_MARKET (users are never trapped)
    const closeBid = signer.computeCloseBid({
      amountUnits: usdtToUnits(54),
      makerCompBalanceUnits: usdtToUnits(54),
      baseBidUsdt: 17.5,
      closeCompetitivenessBps: 15,
      atlasTelemetry: makeTelemetry({ consensusStatus: "CRITICAL", consensusScore: 0.4 }),
    });
    expect(closeBid.executionMode).toBe("ATOMIC_MERGE_UNLOCK");
    expect(closeBid.unlockAmountUsdt).toBe(54);
    expect(closeBid.requiredTopUpUnits).toBe(0n);

    const signedClose = await signer.signCloseQuote({
      quote: {
        taker: TEST_TAKER_ADDR,
        maker: makerAccount.address,
        seriesId: expectedSeriesId,
        isUp: true,
        amount: usdtToUnits(54),
        buybackAmount: closeBid.buybackUnits,
        maxCloseFeeBps: 0,
        makerEpoch: 0n,
        validUntil,
        nonce: 1002n,
      },
      atlasTelemetry: makeTelemetry({
        consensusStatus: "SPLIT_MARKET",
        consensusScore: 0.25,
      }),
    });
    expect(signedClose.conservativeExitApplied).toBe(true);

    const recoveredClose = await recoverTypedDataAddress({
      domain: getPayoffEip712Domain(BSC_TESTNET.chainId, TEST_VAULT_ADDR),
      types: CLOSE_QUOTE_TYPES,
      primaryType: "CloseQuote",
      message: {
        taker: signedClose.quote.taker,
        maker: signedClose.quote.maker,
        seriesId: signedClose.quote.seriesId,
        isUp: signedClose.quote.isUp,
        amount: BigInt(signedClose.quote.amount),
        buybackAmount: BigInt(signedClose.quote.buybackAmount),
        maxCloseFeeBps: signedClose.quote.maxCloseFeeBps,
        makerEpoch: BigInt(signedClose.quote.makerEpoch),
        validUntil: BigInt(signedClose.quote.validUntil),
        nonce: BigInt(signedClose.quote.nonce),
      },
      signature: signedClose.signature,
    });
    expect(recoveredClose.toLowerCase()).toBe(makerAccount.address.toLowerCase());
  });
});

function buildNvdabTestBook(
  spot: number,
  tenor: ExpiryTenor = "DAILY",
  iv = 0.52,
  hoursToExpiry = tenor === "DAILY" ? 24 : 144,
  rwaTelemetry?: RwaAssetTelemetry
): ExpiryBook {
  const expiry = 1_795_813_200; // 2026-11-27T21:00:00Z
  const strikes = generateOccEquityStrikes(spot);
  const T = hoursToExpiry / (365 * 24);
  const syntheticStrikes: Record<number, OptionStrikeQuote> = {};

  for (const strike of strikes) {
    const cFair = bsOptionPrice(true, spot, strike, T, iv);
    const pFair = bsOptionPrice(false, spot, strike, T, iv);
    const half = Math.max(0.01, spot * 0.0005);
    syntheticStrikes[strike] = {
      strike,
      call: {
        strike,
        instId: `NVDAB-USD-TEST-${strike}-C`,
        bidUsd: Math.max(0.01, cFair - half),
        askUsd: Math.max(0.02, cFair + half),
        markUsd: cFair,
        iv,
        bidSize: 100,
        askSize: 100,
      },
      put: {
        strike,
        instId: `NVDAB-USD-TEST-${strike}-P`,
        bidUsd: Math.max(0.01, pFair - half),
        askUsd: Math.max(0.02, pFair + half),
        markUsd: pFair,
        iv,
        bidSize: 100,
        askSize: 100,
      },
    };
  }

  return {
    underlying: "NVDAB",
    tenor,
    expiry,
    expiryIso: new Date(expiry * 1000).toISOString(),
    hoursToExpiry,
    spot,
    atmIv: iv,
    availableStrikes: strikes,
    syntheticStrikes,
    rwaTelemetry,
  };
}

function makeRwaTelemetry(
  overrides: Partial<RwaAssetTelemetry> = {}
): RwaAssetTelemetry {
  return {
    underlying: "NVDAB",
    session: "RTH",
    shareMultiplier: 1.00077822,
    baselineShareMultiplier: 1.00077822,
    multiplierDriftPct: 0,
    crossVenueMultiplierGapPct: 0.08,
    splitGuardTriggered: false,
    corporateActionBlackout: false,
    blackoutReason: null,
    perpSymbol: "NVDAUSDT",
    perpPriceUsd: 153.35,
    spotPerpBasisBps: 12,
    ivSource: "THETADATA_LIVE",
    thetaAtmIv: 0.52,
    thetaExpiration: "2026-11-27",
    thetaStrikeCount: 60,
    thetaUpdatedAtMs: Date.now(),
    settlementUtcHour: 21,
    updatedAtMs: Date.now(),
    ...overrides,
  };
}

function makeNvdabAtlasTelemetry(
  overrides: Partial<AtlasFeedTelemetry> = {}
): AtlasFeedTelemetry {
  return {
    underlying: "NVDAB",
    feedId: ATLAS_FEEDS.NVDAB.feedId,
    feedIdHex: ATLAS_FEEDS.NVDAB.feedIdHex,
    price: 153.5,
    timestampSeconds: Math.floor(Date.now() / 1000),
    consensusScore: 0.9,
    consensusStatus: "HEALTHY",
    twapPrice: 153.48,
    medianPrice: 153.5,
    priceChangePct: 0.85,
    priceVolatility: 0.002,
    updatedAtMs: Date.now(),
    ...overrides,
  };
}

describe("@payoff/mock-maker NVDAB RWA shelf, 24/7 regimes, Put-Call Parity & circuit breakers", () => {
  it("lands 100% on real OCC strikes at $153.50, $150.80 ($1/$2.50 boundary), and $146.50 ($1 zone) with clean fractional tierLabels", () => {
    expect(GRID_CONFIG["NVDAB:DAILY"]).toEqual({
      step: 2.5,
      hysteresis: 0.625,
      offsets: [1, 2, 3, 4],
      defaultSlot: 1,
    });
    expect(GRID_CONFIG["NVDAB:WEEKLY"]).toEqual({
      step: 5,
      hysteresis: 1.25,
      offsets: [1, 2, 3, 4],
      defaultSlot: 1,
    });

    const cases: Array<{ spot: number; tenor: ExpiryTenor }> = [
      { spot: 153.5, tenor: "DAILY" },
      { spot: 153.5, tenor: "WEEKLY" },
      { spot: 150.8, tenor: "DAILY" },
      { spot: 150.8, tenor: "WEEKLY" },
      { spot: 146.5, tenor: "DAILY" },
      { spot: 146.5, tenor: "WEEKLY" },
    ];

    for (const { spot, tenor } of cases) {
      resetFixedGridCache();
      const book = buildNvdabTestBook(spot, tenor);
      const occSet = new Set(book.availableStrikes);

      for (const direction of ["BULL", "BEAR"] as const) {
        const shelf = buildFixedGridShelf({
          book,
          direction,
          stakeUsdt: 20,
          protocolFeeBps: 400,
          atlasTelemetry: makeNvdabAtlasTelemetry({ price: spot }),
          rwaTelemetry: makeRwaTelemetry(),
        });

        expect(occSet.has(shelf.grid.gridLow)).toBe(true);
        expect(occSet.has(shelf.grid.gridHigh)).toBe(true);
        expect(shelf.tiers.length).toBe(4);
        expect(shelf.tiers[0]?.isSharedCenterPool).toBe(true);

        for (const tier of shelf.tiers) {
          expect(occSet.has(tier.lowerStrike)).toBe(true);
          expect(occSet.has(tier.upperStrike)).toBe(true);
          expect(tier.guardrails.strikeAligned).toBe(true);
          expect(tier.guardrails.widthWithinCap).toBe(true);

          // Fractional strikes render with 2 decimals ($152.50), whole strikes cleanly ($155)
          const cap = tier.capPrice;
          if (Math.abs(cap - Math.round(cap)) < 1e-6) {
            expect(tier.tierLabel).toBe(`Target $${Math.round(cap)}`);
          } else {
            expect(tier.tierLabel).toBe(`Target $${cap.toFixed(2)}`);
          }
        }
      }
    }

    // Spot $153.50 DAILY BULL exact strikes & labels
    resetFixedGridCache();
    const shelf153 = buildFixedGridShelf({
      book: buildNvdabTestBook(153.5, "DAILY"),
      direction: "BULL",
      stakeUsdt: 20,
      protocolFeeBps: 400,
    });
    expect(shelf153.grid.gridLow).toBe(152.5);
    expect(shelf153.grid.gridHigh).toBe(155);
    expect(shelf153.tiers.map((t) => t.capPrice)).toEqual([
      155, 157.5, 160, 162.5,
    ]);
    expect(shelf153.tiers.map((t) => t.tierLabel)).toEqual([
      "Target $155",
      "Target $157.50",
      "Target $160",
      "Target $162.50",
    ]);

    // Spot $150.80 DAILY BEAR straddling $1/$2.50 boundary snaps cleanly to $150, $147, $145, $142
    resetFixedGridCache();
    const shelf150Bear = buildFixedGridShelf({
      book: buildNvdabTestBook(150.8, "DAILY"),
      direction: "BEAR",
      stakeUsdt: 20,
      protocolFeeBps: 400,
    });
    expect(shelf150Bear.grid.gridLow).toBe(150);
    expect(shelf150Bear.grid.gridHigh).toBe(152.5);
    expect(shelf150Bear.tiers.map((t) => t.capPrice)).toEqual([
      150, 147, 145, 142,
    ]);

    // Spot $146.50 DAILY ($1 zone) snaps gridHigh=148 & stays 100% OCC-aligned
    resetFixedGridCache();
    const shelf146 = buildFixedGridShelf({
      book: buildNvdabTestBook(146.5, "DAILY"),
      direction: "BULL",
      stakeUsdt: 20,
      protocolFeeBps: 400,
    });
    expect(shelf146.grid.gridLow).toBe(145);
    expect(shelf146.grid.gridHigh).toBe(148);
    expect(shelf146.tiers.map((t) => t.capPrice)).toEqual([148, 150, 152.5, 155]);
  });

  it("enforces RWA 24/7 regimes, spot-perp basis buffer, and strict Put-Call Parity across RTH/EXTENDED/WEEKEND + high basis", () => {
    const rth = makeRwaTelemetry({ session: "RTH", spotPerpBasisBps: 15 });
    const extended = makeRwaTelemetry({
      session: "EXTENDED",
      spotPerpBasisBps: 20,
    });
    const weekend = makeRwaTelemetry({
      session: "WEEKEND",
      spotPerpBasisBps: 25,
    });
    const rthHighBasis = makeRwaTelemetry({
      session: "RTH",
      spotPerpBasisBps: 70, // 1 + (70-30)/200 = 1.20x
    });
    const weekendExtremeBasis = makeRwaTelemetry({
      session: "WEEKEND",
      spotPerpBasisBps: 250, // clamped to 1.50x basis * 1.50x weekend = 2.25x
    });

    // Exact session + basis multipliers
    const adjRth = computeRwaRiskAdjustments(rth);
    expect(adjRth).toMatchObject({
      quotingAllowed: true,
      spreadMultiplier: 1.0,
      ivFloorBoost: 0,
      varianceTimeScale: 1.0,
      basisSpreadMultiplier: 1.0,
    });

    const adjExt = computeRwaRiskAdjustments(extended);
    expect(adjExt).toMatchObject({
      quotingAllowed: true,
      spreadMultiplier: 1.25,
      ivFloorBoost: 0.04,
      varianceTimeScale: 0.85,
      basisSpreadMultiplier: 1.0,
    });

    const adjWknd = computeRwaRiskAdjustments(weekend);
    expect(adjWknd).toMatchObject({
      quotingAllowed: true,
      spreadMultiplier: 1.5,
      ivFloorBoost: 0.08,
      varianceTimeScale: 0.7,
      basisSpreadMultiplier: 1.0,
    });

    const adjBasis = computeRwaRiskAdjustments(rthHighBasis);
    expect(adjBasis.basisSpreadMultiplier).toBeCloseTo(1.2, 4);
    expect(adjBasis.spreadMultiplier).toBeCloseTo(1.2, 4);

    const adjExtreme = computeRwaRiskAdjustments(weekendExtremeBasis);
    expect(adjExtreme.basisSpreadMultiplier).toBeCloseTo(1.5, 4);
    expect(adjExtreme.spreadMultiplier).toBeCloseTo(2.25, 4);

    // Strict Put-Call Parity across all RWA + Atlas regimes and strike pairs
    const book = buildNvdabTestBook(153.5, "DAILY", 0.52, 24);
    const strikePairs: Array<[number, number]> = [
      [147, 150],
      [150, 152.5],
      [152.5, 155],
      [152.5, 157.5],
      [155, 160],
    ];
    const combos: Array<{
      atlas: AtlasFeedTelemetry;
      rwa: RwaAssetTelemetry;
    }> = [
      { atlas: makeNvdabAtlasTelemetry(), rwa: rth },
      { atlas: makeNvdabAtlasTelemetry(), rwa: extended },
      { atlas: makeNvdabAtlasTelemetry(), rwa: weekend },
      { atlas: makeNvdabAtlasTelemetry(), rwa: rthHighBasis },
      { atlas: makeNvdabAtlasTelemetry(), rwa: weekendExtremeBasis },
      {
        atlas: makeNvdabAtlasTelemetry({
          consensusStatus: "DEGRADED",
          consensusScore: 0.72,
          priceVolatility: 0.025,
        }),
        rwa: weekendExtremeBasis,
      },
    ];

    for (const { atlas, rwa } of combos) {
      const combined = computeCombinedRiskAdjustments(atlas, rwa);
      for (const [k1, k2] of strikePairs) {
        const width = k2 - k1;
        const upFair = computeFairSpreadUnitUsd(
          book,
          true,
          k1,
          k2,
          undefined,
          atlas,
          rwa
        );
        const downFair = computeFairSpreadUnitUsd(
          book,
          false,
          k1,
          k2,
          undefined,
          atlas,
          rwa
        );

        // Exact Put-Call Parity fair mid
        expect(upFair + downFair).toBeCloseTo(width, 8);

        // Strict no-arbitrage ask: UP_ask + DOWN_ask > width
        const upAsk = computeMmOpenUnitUsd(
          upFair,
          width,
          110,
          combined.spreadMultiplier
        );
        const downAsk = computeMmOpenUnitUsd(
          downFair,
          width,
          110,
          combined.spreadMultiplier
        );
        expect(upAsk).toBeGreaterThan(upFair);
        expect(downAsk).toBeGreaterThan(downFair);
        expect(upAsk + downAsk).toBeGreaterThan(width);

        // Strict no-arbitrage bid: UP_bid + DOWN_bid < width
        const upBid = computeMmCloseUnitUsd(
          upFair,
          width,
          combined.spreadMultiplier
        );
        const downBid = computeMmCloseUnitUsd(
          downFair,
          width,
          combined.spreadMultiplier
        );
        expect(upBid).toBeLessThan(upFair);
        expect(downBid).toBeLessThan(downFair);
        expect(upBid + downBid).toBeLessThan(width);

        // End-to-end priceSpreadOnVenue & estimatePositionExitUsdt no-arbitrage verification
        const bullOpen = priceSpreadOnVenue({
          book,
          tierKind: "STANDARD",
          tierLabel: `Target $${k2}`,
          direction: "BULL",
          lowerStrike: k1,
          upperStrike: k2,
          stakeUsdt: 100,
          protocolFeeBps: 400,
          mmOpenMarkupBps: 110,
          atlasTelemetry: atlas,
          rwaTelemetry: rwa,
        });
        const bearOpen = priceSpreadOnVenue({
          book,
          tierKind: "STANDARD",
          tierLabel: `Target $${k1}`,
          direction: "BEAR",
          lowerStrike: k1,
          upperStrike: k2,
          stakeUsdt: 100,
          protocolFeeBps: 400,
          mmOpenMarkupBps: 110,
          atlasTelemetry: atlas,
          rwaTelemetry: rwa,
        });
        const mmNet = 100 - (100 * 400) / 10_400;
        const impliedUpAsk = (mmNet / bullOpen.summary.maxPayoutUsdt) * width;
        const impliedDownAsk = (mmNet / bearOpen.summary.maxPayoutUsdt) * width;
        expect(impliedUpAsk + impliedDownAsk).toBeGreaterThan(width);

        const bullExit = estimatePositionExitUsdt({
          book,
          isCall: true,
          lowerStrike: k1,
          upperStrike: k2,
          remainingLongUsdt: 100,
          hoursRemaining: 24,
          atlasTelemetry: atlas,
          rwaTelemetry: rwa,
        });
        const bearExit = estimatePositionExitUsdt({
          book,
          isCall: false,
          lowerStrike: k1,
          upperStrike: k2,
          remainingLongUsdt: 100,
          hoursRemaining: 24,
          atlasTelemetry: atlas,
          rwaTelemetry: rwa,
        });
        expect(bullExit.bestBidUsdt + bearExit.bestBidUsdt).toBeLessThan(100);
      }
    }

    // Spread monotonically widens: RTH -> EXTENDED -> WEEKEND, and low basis -> high basis
    const baseParams = {
      book,
      tierKind: "STANDARD" as const,
      tierLabel: "Target $157.50",
      direction: "BULL" as const,
      lowerStrike: 152.5,
      upperStrike: 157.5,
      stakeUsdt: 100,
      protocolFeeBps: 400,
      mmOpenMarkupBps: 110,
      atlasTelemetry: makeNvdabAtlasTelemetry(),
    };
    const pRth = priceSpreadOnVenue({ ...baseParams, rwaTelemetry: rth });
    const pExt = priceSpreadOnVenue({ ...baseParams, rwaTelemetry: extended });
    const pWknd = priceSpreadOnVenue({ ...baseParams, rwaTelemetry: weekend });
    const pHighBasis = priceSpreadOnVenue({
      ...baseParams,
      rwaTelemetry: rthHighBasis,
    });

    expect(pExt.summary.maxPayoutUsdt).toBeLessThan(pRth.summary.maxPayoutUsdt);
    expect(pWknd.summary.maxPayoutUsdt).toBeLessThan(pExt.summary.maxPayoutUsdt);
    expect(pHighBasis.summary.maxPayoutUsdt).toBeLessThan(
      pRth.summary.maxPayoutUsdt
    );
  });

  it("halts OpenQuote signing on splitGuardTriggered / corporateActionBlackout while keeping CloseQuote operational", async () => {
    const makerAccount = privateKeyToAccount(TEST_MAKER_PK);
    const signer = new MockMakerSigner({
      chainId: BSC_TESTNET.chainId,
      verifyingContract: TEST_VAULT_ADDR,
      makers: [
        {
          id: "mm1",
          name: "Payoff Reference MM #1",
          privateKey: TEST_MAKER_PK,
          openMarkupBps: 110,
          closeCompetitivenessBps: 15,
        },
      ],
    });

    const expiry = 1_795_813_200; // 2026-11-27T21:00:00Z
    const validUntil = expiry - 600;
    const lowerStrike8 = priceToUnits(152.5);
    const upperStrike8 = priceToUnits(157.5);
    const healthyAtlas = makeNvdabAtlasTelemetry();

    const openInput = {
      taker: TEST_TAKER_ADDR,
      maker: makerAccount.address,
      assetId: ASSET_NVDAB_ID,
      isUp: true,
      lowerStrike: lowerStrike8,
      upperStrike: upperStrike8,
      expiry,
      userPayAmount: usdtToUnits(20),
      maxPayout: usdtToUnits(48),
      maxProtocolFeeBps: 400,
      makerEpoch: 0n,
      validUntil,
      nonce: 2001n,
    };

    const splitRwa = makeRwaTelemetry({
      shareMultiplier: 1.05,
      baselineShareMultiplier: 1.00077822,
      multiplierDriftPct: 4.92,
      splitGuardTriggered: true,
    });
    const blackoutRwa = makeRwaTelemetry({
      corporateActionBlackout: true,
      blackoutReason: "Scheduled NVDA stock split cutover",
    });

    // 1. isOpenQuotingAllowed flags both RWA breakers even when Atlas consensus is HEALTHY
    expect(signer.isOpenQuotingAllowed(healthyAtlas, splitRwa).quotingAllowed).toBe(
      false
    );
    expect(
      signer.isOpenQuotingAllowed(healthyAtlas, blackoutRwa).quotingAllowed
    ).toBe(false);
    expect(
      signer.isOpenQuotingAllowed(healthyAtlas, makeRwaTelemetry()).quotingAllowed
    ).toBe(true);

    // 2. signOpenQuote throws ConsensusCircuitBreakerError on splitGuardTriggered & corporateActionBlackout
    await expect(
      signer.signOpenQuote({
        quote: openInput,
        atlasTelemetry: healthyAtlas,
        rwaTelemetry: splitRwa,
      })
    ).rejects.toBeInstanceOf(ConsensusCircuitBreakerError);

    await expect(
      signer.signOpenQuote({
        quote: openInput,
        atlasTelemetry: healthyAtlas,
        rwaTelemetry: blackoutRwa,
      })
    ).rejects.toBeInstanceOf(ConsensusCircuitBreakerError);

    // 3. Normal RTH telemetry signs valid recoverable EIP-712 OpenQuote for NVDAB
    const signedOpen = await signer.signOpenQuote({
      quote: openInput,
      atlasTelemetry: healthyAtlas,
      rwaTelemetry: makeRwaTelemetry(),
    });
    const expectedSeriesId = computeSeriesId(
      ASSET_NVDAB_ID,
      lowerStrike8,
      upperStrike8,
      expiry
    );
    expect(signedOpen.seriesId).toBe(expectedSeriesId);

    // 4. CloseQuote stays operational under BOTH splitGuardTriggered and corporateActionBlackout
    const calmBid = signer.computeCloseBid({
      amountUnits: usdtToUnits(48),
      makerCompBalanceUnits: usdtToUnits(48),
      baseBidUsdt: 18.0,
      closeCompetitivenessBps: 15,
      atlasTelemetry: healthyAtlas,
      rwaTelemetry: makeRwaTelemetry(),
    });
    const splitBid = signer.computeCloseBid({
      amountUnits: usdtToUnits(48),
      makerCompBalanceUnits: usdtToUnits(48),
      baseBidUsdt: 18.0,
      closeCompetitivenessBps: 15,
      atlasTelemetry: healthyAtlas,
      rwaTelemetry: splitRwa,
    });
    expect(splitBid.buybackUsdt).toBeLessThan(calmBid.buybackUsdt);
    expect(splitBid.consensusRisk.quotingAllowed).toBe(false);

    const signedCloseSplit = await signer.signCloseQuote({
      quote: {
        taker: TEST_TAKER_ADDR,
        maker: makerAccount.address,
        seriesId: expectedSeriesId,
        isUp: true,
        amount: usdtToUnits(48),
        buybackAmount: splitBid.buybackUnits,
        maxCloseFeeBps: 0,
        makerEpoch: 0n,
        validUntil,
        nonce: 2002n,
      },
      atlasTelemetry: healthyAtlas,
      rwaTelemetry: splitRwa,
    });
    expect(signedCloseSplit.conservativeExitApplied).toBe(true);

    const signedCloseBlackout = await signer.signCloseQuote({
      quote: {
        taker: TEST_TAKER_ADDR,
        maker: makerAccount.address,
        seriesId: expectedSeriesId,
        isUp: true,
        amount: usdtToUnits(48),
        buybackAmount: splitBid.buybackUnits,
        maxCloseFeeBps: 0,
        makerEpoch: 0n,
        validUntil,
        nonce: 2003n,
      },
      atlasTelemetry: healthyAtlas,
      rwaTelemetry: blackoutRwa,
    });
    expect(signedCloseBlackout.conservativeExitApplied).toBe(true);

    const recoveredClose = await recoverTypedDataAddress({
      domain: getPayoffEip712Domain(BSC_TESTNET.chainId, TEST_VAULT_ADDR),
      types: CLOSE_QUOTE_TYPES,
      primaryType: "CloseQuote",
      message: {
        taker: signedCloseSplit.quote.taker,
        maker: signedCloseSplit.quote.maker,
        seriesId: signedCloseSplit.quote.seriesId,
        isUp: signedCloseSplit.quote.isUp,
        amount: BigInt(signedCloseSplit.quote.amount),
        buybackAmount: BigInt(signedCloseSplit.quote.buybackAmount),
        maxCloseFeeBps: signedCloseSplit.quote.maxCloseFeeBps,
        makerEpoch: BigInt(signedCloseSplit.quote.makerEpoch),
        validUntil: BigInt(signedCloseSplit.quote.validUntil),
        nonce: BigInt(signedCloseSplit.quote.nonce),
      },
      signature: signedCloseSplit.signature,
    });
    expect(recoveredClose.toLowerCase()).toBe(makerAccount.address.toLowerCase());
  });
});

describe("@payoff/mock-maker Quick fine-step slider & Custom dual-range fair bounds", () => {
  function buildDenseBook(
    underlying: "BTC" | "ETH" | "NVDAB",
    spot: number,
    tenor: ExpiryTenor,
    iv: number,
    hoursToExpiry: number
  ): ExpiryBook {
    const expiry = 1_800_000_000;
    let strikes: number[];
    if (underlying === "NVDAB") {
      strikes = generateOccEquityStrikes(spot, 0.3);
    } else {
      const step = underlying === "BTC" ? 500 : 25;
      const center = Math.round(spot / step) * step;
      const half = Math.max(16, Math.ceil((spot * 0.3) / step));
      strikes = [];
      for (let i = -half; i <= half; i++) {
        const k = center + i * step;
        if (k > 0) strikes.push(k);
      }
    }
    const T = hoursToExpiry / (365 * 24);
    const syntheticStrikes: Record<number, OptionStrikeQuote> = {};
    for (const strike of strikes) {
      const cFair = bsOptionPrice(true, spot, strike, T, iv);
      const pFair = bsOptionPrice(false, spot, strike, T, iv);
      const half = Math.max(0.01, spot * 0.0004);
      syntheticStrikes[strike] = {
        strike,
        call: {
          strike,
          instId: `${underlying}-TEST-${strike}-C`,
          bidUsd: Math.max(0.01, cFair - half),
          askUsd: Math.max(0.02, cFair + half),
          markUsd: cFair,
          iv,
          bidSize: 50,
          askSize: 50,
        },
        put: {
          strike,
          instId: `${underlying}-TEST-${strike}-P`,
          bidUsd: Math.max(0.01, pFair - half),
          askUsd: Math.max(0.02, pFair + half),
          markUsd: pFair,
          iv,
          bidSize: 50,
          askSize: 50,
        },
      };
    }
    return {
      underlying,
      tenor,
      expiry,
      expiryIso: new Date(expiry * 1000).toISOString(),
      hoursToExpiry,
      spot,
      atmIv: iv,
      availableStrikes: strikes,
      syntheticStrikes,
    };
  }

  it("densifies Quick mode to native fine steps (BTC $500, ETH $25, NVDA OCC) within width & fair guardrails", () => {
    const cases: Array<{
      underlying: "BTC" | "ETH" | "NVDAB";
      spot: number;
      tenor: ExpiryTenor;
      iv: number;
      hours: number;
      expectedStep?: number;
      minBullCount: number;
      minBearCount: number;
    }> = [
      { underlying: "BTC", spot: 61500, tenor: "DAILY", iv: 0.6, hours: 24, expectedStep: 500, minBullCount: 8, minBearCount: 7 },
      { underlying: "BTC", spot: 61500, tenor: "WEEKLY", iv: 0.6, hours: 144, expectedStep: 500, minBullCount: 12, minBearCount: 12 },
      { underlying: "ETH", spot: 1750, tenor: "DAILY", iv: 0.65, hours: 24, expectedStep: 25, minBullCount: 5, minBearCount: 4 },
      { underlying: "ETH", spot: 1760, tenor: "DAILY", iv: 0.65, hours: 24, expectedStep: 25, minBullCount: 5, minBearCount: 5 },
      { underlying: "ETH", spot: 1750, tenor: "WEEKLY", iv: 0.65, hours: 144, expectedStep: 25, minBullCount: 9, minBearCount: 9 },
      { underlying: "NVDAB", spot: 142.3, tenor: "DAILY", iv: 0.52, hours: 24, minBullCount: 7, minBearCount: 9 },
      { underlying: "NVDAB", spot: 149.41, tenor: "DAILY", iv: 0.52, hours: 24, minBullCount: 4, minBearCount: 9 },
      { underlying: "NVDAB", spot: 149.41, tenor: "WEEKLY", iv: 0.52, hours: 144, minBullCount: 7, minBearCount: 18 },
    ];

    for (const c of cases) {
      resetFixedGridCache();
      const book = buildDenseBook(c.underlying, c.spot, c.tenor, c.iv, c.hours);
      for (const direction of ["BULL", "BEAR"] as const) {
        const shelf = buildFixedGridShelf({
          book,
          direction,
          stakeUsdt: 20,
          protocolFeeBps: 400,
        });

        expect(shelf.tiers).toHaveLength(4);
        const expectedMin = direction === "BULL" ? c.minBullCount : c.minBearCount;
        expect(shelf.quickTiers.length).toBeGreaterThanOrEqual(expectedMin);
        expect(shelf.grid.defaultQuickIndex).toBeDefined();

        // Default Quick tier matches canonical default tier
        const canonicalDefault = shelf.tiers[shelf.grid.defaultIndex]!;
        const quickDefault = shelf.quickTiers[shelf.grid.defaultQuickIndex!]!;
        expect(quickDefault.lowerStrike).toBe(canonicalDefault.lowerStrike);
        expect(quickDefault.upperStrike).toBe(canonicalDefault.upperStrike);

        for (let i = 0; i < shelf.quickTiers.length; i++) {
          const qt = shelf.quickTiers[i]!;
          expect(qt.guardrails.valid).toBe(true);
          expect(qt.guardrails.widthWithinCap).toBe(true);
          expect(qt.guardrails.withinFairBounds).toBe(true);
          expect(qt.tierKind).not.toBe("CUSTOM");
          expect(qt.maxMultiplier).toBeGreaterThanOrEqual(1.15);
          expect(qt.maxMultiplier).toBeLessThanOrEqual(20.0);
          if (direction === "BULL") {
            expect(qt.capPrice).toBeGreaterThan(c.spot);
          } else {
            expect(qt.capPrice).toBeLessThan(c.spot);
          }
          if (i > 0) {
            const prev = shelf.quickTiers[i - 1]!;
            const diff = Math.abs(qt.capPrice - prev.capPrice);
            if (c.expectedStep) {
              expect(diff).toBe(c.expectedStep);
            } else {
              expect([1, 2.5, 5]).toContain(diff);
            }
            if (direction === "BULL") {
              expect(qt.capPrice).toBeGreaterThan(prev.capPrice);
            } else {
              expect(qt.capPrice).toBeLessThan(prev.capPrice);
            }
            expect(qt.maxMultiplier).toBeGreaterThan(prev.maxMultiplier);
          }
        }
      }
    }
  });

  it("keeps Quick-mode Target caps strictly on the directional side of spot while preserving fine directional intermediate strikes", () => {
    // 1. NVDAB:WEEKLY BULL at $149.41 (gridLow=145, gridHigh=150) must exclude [146, 147, 148, 149]
    resetFixedGridCache();
    const nvdaWeekly149 = buildDenseBook("NVDAB", 149.41, "WEEKLY", 0.52, 144);
    const nvdaWeekly149Bull = buildFixedGridShelf({
      book: nvdaWeekly149,
      direction: "BULL",
      stakeUsdt: 20,
      protocolFeeBps: 400,
    });
    expect(nvdaWeekly149Bull.grid.gridLow).toBe(145);
    expect(nvdaWeekly149Bull.grid.gridHigh).toBe(150);
    const nvdaWeekly149Caps = nvdaWeekly149Bull.quickTiers.map((t) => t.capPrice);
    for (const wrongCap of [146, 147, 148, 149]) {
      expect(nvdaWeekly149Caps).not.toContain(wrongCap);
    }
    expect(nvdaWeekly149Caps[0]).toBe(150);
    expect(nvdaWeekly149Caps).toContain(152.5);
    expect(nvdaWeekly149Caps.every((c) => c > 149.41)).toBe(true);

    // 2. NVDAB:DAILY BULL at $149.41 must exclude [148, 149]
    resetFixedGridCache();
    const nvdaDaily149 = buildDenseBook("NVDAB", 149.41, "DAILY", 0.52, 24);
    const nvdaDaily149Bull = buildFixedGridShelf({
      book: nvdaDaily149,
      direction: "BULL",
      stakeUsdt: 20,
      protocolFeeBps: 400,
    });
    const nvdaDaily149Caps = nvdaDaily149Bull.quickTiers.map((t) => t.capPrice);
    expect(nvdaDaily149Caps).not.toContain(148);
    expect(nvdaDaily149Caps).not.toContain(149);
    expect(nvdaDaily149Caps[0]).toBe(150);
    expect(nvdaDaily149Caps.every((c) => c > 149.41)).toBe(true);

    // 3. ETH:WEEKLY at $1,785 (gridLow=1750, gridHigh=1800): BULL excludes $1,775, BEAR preserves $1,775
    resetFixedGridCache();
    const ethWeekly1785 = buildDenseBook("ETH", 1785, "WEEKLY", 0.65, 144);
    const ethWeekly1785Bull = buildFixedGridShelf({
      book: ethWeekly1785,
      direction: "BULL",
      stakeUsdt: 20,
      protocolFeeBps: 400,
    });
    const eth1785BullCaps = ethWeekly1785Bull.quickTiers.map((t) => t.capPrice);
    expect(ethWeekly1785Bull.grid.gridLow).toBe(1750);
    expect(ethWeekly1785Bull.grid.gridHigh).toBe(1800);
    expect(eth1785BullCaps).not.toContain(1775);
    expect(eth1785BullCaps[0]).toBe(1800);
    expect(eth1785BullCaps).toContain(1825);
    expect(eth1785BullCaps.every((c) => c > 1785)).toBe(true);

    const ethWeekly1785Bear = buildFixedGridShelf({
      book: ethWeekly1785,
      direction: "BEAR",
      stakeUsdt: 20,
      protocolFeeBps: 400,
    });
    const eth1785BearCaps = ethWeekly1785Bear.quickTiers.map((t) => t.capPrice);
    expect(eth1785BearCaps[0]).toBe(1775);
    expect(eth1785BearCaps.every((c) => c < 1785)).toBe(true);

    // 4. Fine directional intermediate strikes ARE preserved when on the directional side of spot:
    //    - NVDAB:WEEKLY at $150.5 -> BULL preserves $152.5, BEAR excludes $152.5
    resetFixedGridCache();
    const nvdaWeekly150_5 = buildDenseBook("NVDAB", 150.5, "WEEKLY", 0.52, 144);
    const nvda150_5Bull = buildFixedGridShelf({
      book: nvdaWeekly150_5,
      direction: "BULL",
      stakeUsdt: 20,
      protocolFeeBps: 400,
    });
    const nvda150_5BullCaps = nvda150_5Bull.quickTiers.map((t) => t.capPrice);
    expect(nvda150_5Bull.grid.gridLow).toBe(150);
    expect(nvda150_5Bull.grid.gridHigh).toBe(155);
    expect(nvda150_5BullCaps[0]).toBe(152.5);
    expect(nvda150_5BullCaps.every((c) => c > 150.5)).toBe(true);

    const nvda150_5Bear = buildFixedGridShelf({
      book: nvdaWeekly150_5,
      direction: "BEAR",
      stakeUsdt: 20,
      protocolFeeBps: 400,
    });
    const nvda150_5BearCaps = nvda150_5Bear.quickTiers.map((t) => t.capPrice);
    expect(nvda150_5BearCaps).not.toContain(152.5);
    expect(nvda150_5BearCaps[0]).toBe(150);
    expect(nvda150_5BearCaps.every((c) => c < 150.5)).toBe(true);

    //    - ETH:WEEKLY at $1,760 -> BULL preserves $1,775, BEAR excludes $1,775
    resetFixedGridCache();
    const ethWeekly1760 = buildDenseBook("ETH", 1760, "WEEKLY", 0.65, 144);
    const eth1760Bull = buildFixedGridShelf({
      book: ethWeekly1760,
      direction: "BULL",
      stakeUsdt: 20,
      protocolFeeBps: 400,
    });
    const eth1760BullCaps = eth1760Bull.quickTiers.map((t) => t.capPrice);
    expect(eth1760Bull.grid.gridLow).toBe(1750);
    expect(eth1760Bull.grid.gridHigh).toBe(1800);
    expect(eth1760BullCaps[0]).toBe(1775);
    expect(eth1760BullCaps.every((c) => c > 1760)).toBe(true);

    const eth1760Bear = buildFixedGridShelf({
      book: ethWeekly1760,
      direction: "BEAR",
      stakeUsdt: 20,
      protocolFeeBps: 400,
    });
    const eth1760BearCaps = eth1760Bear.quickTiers.map((t) => t.capPrice);
    expect(eth1760BearCaps).not.toContain(1775);
    expect(eth1760BearCaps[0]).toBe(1750);
    expect(eth1760BearCaps.every((c) => c < 1760)).toBe(true);

    //    - NVDAB:WEEKLY BEAR at $145.5 (gridLow=145, gridHigh=150) excludes [149, 148, 147, 146]
    resetFixedGridCache();
    const nvdaWeekly145_5 = buildDenseBook("NVDAB", 145.5, "WEEKLY", 0.52, 144);
    const nvda145_5Bear = buildFixedGridShelf({
      book: nvdaWeekly145_5,
      direction: "BEAR",
      stakeUsdt: 20,
      protocolFeeBps: 400,
    });
    const nvda145_5BearCaps = nvda145_5Bear.quickTiers.map((t) => t.capPrice);
    for (const wrongCap of [149, 148, 147, 146]) {
      expect(nvda145_5BearCaps).not.toContain(wrongCap);
    }
    expect(nvda145_5BearCaps[0]).toBe(145);
    expect(nvda145_5BearCaps.every((c) => c < 145.5)).toBe(true);

    // 5. Hysteresis drift inside buffer: cached [61000, 61500], spot drifts to 61600 (+100 <= +125 hysteresis)
    resetFixedGridCache();
    const btcBase = buildDenseBook("BTC", 61250, "DAILY", 0.6, 24);
    const baseShelf = buildFixedGridShelf({
      book: btcBase,
      direction: "BULL",
      stakeUsdt: 20,
      protocolFeeBps: 400,
    });
    expect(baseShelf.grid.gridLow).toBe(61000);
    expect(baseShelf.grid.gridHigh).toBe(61500);

    const btcDrifted = buildDenseBook("BTC", 61600, "DAILY", 0.6, 24);
    const driftedBull = buildFixedGridShelf({
      book: btcDrifted,
      direction: "BULL",
      stakeUsdt: 20,
      protocolFeeBps: 400,
    });
    expect(driftedBull.grid.gridLow).toBe(61000);
    expect(driftedBull.grid.gridHigh).toBe(61500);
    expect(driftedBull.quickTiers.map((t) => t.capPrice)).not.toContain(61500);
    expect(driftedBull.quickTiers[0]!.capPrice).toBe(62000);
    expect(driftedBull.quickTiers.every((t) => t.capPrice > 61600)).toBe(true);

    const driftedBear = buildFixedGridShelf({
      book: btcDrifted,
      direction: "BEAR",
      stakeUsdt: 20,
      protocolFeeBps: 400,
    });
    expect(driftedBear.grid.anchorStartPrice).toBe(61500);
    expect(driftedBear.quickTiers[0]!.capPrice).toBe(61000);
    expect(driftedBear.quickTiers.every((t) => t.capPrice < 61500)).toBe(true);

    // 6. Anchor fallback when spot sits outside all available strikes (zero strikes qualify past spot)
    resetFixedGridCache();
    const fullBtc = buildDenseBook("BTC", 61500, "DAILY", 0.6, 24);
    const bullCappedStrikes = fullBtc.availableStrikes.filter((k) => k <= 61000);
    const bullCappedBook: ExpiryBook = {
      ...fullBtc,
      availableStrikes: bullCappedStrikes,
      syntheticStrikes: Object.fromEntries(
        bullCappedStrikes.map((k) => [k, fullBtc.syntheticStrikes[k]!])
      ),
    };
    const bullFallbackShelf = buildFixedGridShelf({
      book: bullCappedBook,
      direction: "BULL",
      stakeUsdt: 20,
      protocolFeeBps: 400,
    });
    expect(bullFallbackShelf.grid.anchorStartPrice).toBe(60500);
    expect(bullFallbackShelf.quickTiers).toHaveLength(1);
    expect(bullFallbackShelf.quickTiers[0]!.lowerStrike).toBe(60500);
    expect(bullFallbackShelf.quickTiers[0]!.upperStrike).toBe(61000);

    resetFixedGridCache();
    const bearFlooredStrikes = fullBtc.availableStrikes.filter((k) => k >= 62000);
    const bearFlooredBook: ExpiryBook = {
      ...fullBtc,
      availableStrikes: bearFlooredStrikes,
      syntheticStrikes: Object.fromEntries(
        bearFlooredStrikes.map((k) => [k, fullBtc.syntheticStrikes[k]!])
      ),
    };
    const bearFallbackShelf = buildFixedGridShelf({
      book: bearFlooredBook,
      direction: "BEAR",
      stakeUsdt: 20,
      protocolFeeBps: 400,
    });
    expect(bearFallbackShelf.grid.anchorStartPrice).toBe(62500);
    expect(bearFallbackShelf.quickTiers).toHaveLength(1);
    expect(bearFallbackShelf.quickTiers[0]!.lowerStrike).toBe(62000);
    expect(bearFallbackShelf.quickTiers[0]!.upperStrike).toBe(62500);
  });

  it("builds valid server-authoritative Custom bounds across ITM/OTM, supports NVDA $170->$190 in high-IV weekly, blocks flat-clamped OTM, and aligns with synchronous client preview", () => {
    resetFixedGridCache();
    // Scenario matching user's NVDA Weekly example (spot $149.41, high IV weekly where $150->$170 is ~3.4x)
    const nvdaHighVol = buildDenseBook("NVDAB", 149.41, "WEEKLY", 0.85, 168);
    const bullShelf = buildFixedGridShelf({
      book: nvdaHighVol,
      direction: "BULL",
      stakeUsdt: 20,
      protocolFeeBps: 400,
    });
    const cfg = bullShelf.customConfig;

    // Valid starts span ITM below spot AND OTM up to >= $170 (never extreme flat-clamped OTM)
    expect(cfg.validStarts[0]).toBeLessThan(145);
    expect(cfg.validStarts).toContain(170);
    expect(cfg.validCapsByStart["170"]).toContain(190);

    // Every single (start, cap) pair in customConfig passes full priceSpreadOnVenue guardrails & stays strictly out of 21.37x clamp
    for (const start of cfg.validStarts) {
      const caps = cfg.validCapsByStart[String(start)]!;
      expect(caps.length).toBeGreaterThan(0);
      for (const cap of caps) {
        const priced = priceSpreadOnVenue({
          book: nvdaHighVol,
          tierKind: "CUSTOM",
          tierLabel: "Custom Range",
          direction: "BULL",
          lowerStrike: start,
          upperStrike: cap,
          stakeUsdt: 20,
          protocolFeeBps: 400,
          mmOpenMarkupBps: 110,
        });
        expect(priced.summary.guardrails.valid).toBe(true);
        expect(priced.summary.guardrails.widthWithinCap).toBe(true);
        expect(priced.summary.guardrails.withinFairBounds).toBe(true);
        expect(priced.summary.maxMultiplier).toBeGreaterThanOrEqual(1.15);
        expect(priced.summary.maxMultiplier).toBeLessThanOrEqual(20.0);
      }
    }

    // Extreme OTM ($180 -> $195) is rejected by fair-pricing OTM guardrail
    const extremeOtm = priceSpreadOnVenue({
      book: nvdaHighVol,
      tierKind: "CUSTOM",
      tierLabel: "Custom Range",
      direction: "BULL",
      lowerStrike: 180,
      upperStrike: 195,
      stakeUsdt: 20,
      protocolFeeBps: 400,
      mmOpenMarkupBps: 110,
    });
    expect(extremeOtm.summary.guardrails.valid).toBe(false);
    expect(extremeOtm.summary.guardrails.withinFairBounds).toBe(false);

    // Client synchronous preview matches server priceSpreadOnVenue within < 1.5% on $170 -> $190
    const server170to190 = priceSpreadOnVenue({
      book: nvdaHighVol,
      tierKind: "CUSTOM",
      tierLabel: "Custom Range",
      direction: "BULL",
      lowerStrike: 170,
      upperStrike: 190,
      stakeUsdt: 20,
      protocolFeeBps: 400,
      mmOpenMarkupBps: 110,
    }).summary;
    const client170to190 = estimateCustomTicketPreview({
      underlying: "NVDAB",
      direction: "BULL",
      tenor: "WEEKLY",
      expiry: nvdaHighVol.expiry,
      availableStrikes: nvdaHighVol.availableStrikes,
      lowerStrike: 170,
      upperStrike: 190,
      stakeUsdt: 20,
      config: cfg,
    });
    const relDiff =
      Math.abs(client170to190.maxPayoutUsdt - server170to190.maxPayoutUsdt) /
      server170to190.maxPayoutUsdt;
    expect(relDiff).toBeLessThan(0.015);

    // Verify BEAR customConfig ordering (ITM high -> OTM low) & auto-clamping
    const bearShelf = buildFixedGridShelf({
      book: nvdaHighVol,
      direction: "BEAR",
      stakeUsdt: 20,
      protocolFeeBps: 400,
    });
    const bearCfg = bearShelf.customConfig;
    expect(bearCfg.validStarts.length).toBeGreaterThan(5);
    expect(bearCfg.validStarts[0]!).toBeGreaterThan(
      bearCfg.validStarts[bearCfg.validStarts.length - 1]!
    );
    const clampedBear = resolveClampedCustomRange({
      config: bearCfg,
      direction: "BEAR",
      desiredStart: bearCfg.validStarts[bearCfg.validStarts.length - 1]!,
      desiredCap: 195, // above Start -> ORDERING clamp
    });
    expect(clampedBear?.clampReason).toBe("ORDERING");
    expect(clampedBear!.lowerStrike).toBeLessThan(clampedBear!.upperStrike);

    // Flat IV book omits strikeIvs payload; skewed NVDA equity smile includes strikeIvs and avoids false invalid previews
    expect(cfg.pricingParams.strikeIvs).toBeUndefined();
    const skewedNvda = buildDenseBook("NVDAB", 149.41, "WEEKLY", 0.55, 144);
    const Tskew = 144 / (365 * 24);
    for (const k of skewedNvda.availableStrikes) {
      const m = Math.log(k / 149.41);
      const siv = Math.max(0.25, Math.min(1.5, 0.55 - 0.65 * m + 1.2 * m * m));
      const cFair = bsOptionPrice(true, 149.41, k, Tskew, siv);
      const pFair = bsOptionPrice(false, 149.41, k, Tskew, siv);
      const half = Math.max(0.01, 149.41 * 0.0004);
      skewedNvda.syntheticStrikes[k] = {
        strike: k,
        call: {
          ...skewedNvda.syntheticStrikes[k]!.call,
          bidUsd: Math.max(0.01, cFair - half),
          askUsd: Math.max(0.02, cFair + half),
          markUsd: cFair,
          iv: siv,
        },
        put: {
          ...skewedNvda.syntheticStrikes[k]!.put,
          bidUsd: Math.max(0.01, pFair - half),
          askUsd: Math.max(0.02, pFair + half),
          markUsd: pFair,
          iv: siv,
        },
      };
    }
    const skewedBearShelf = buildFixedGridShelf({
      book: skewedNvda,
      direction: "BEAR",
      stakeUsdt: 20,
      protocolFeeBps: 400,
    });
    expect(skewedBearShelf.customConfig.pricingParams.strikeIvs).toBeDefined();
    for (const s of skewedBearShelf.customConfig.validStarts) {
      for (const cap of skewedBearShelf.customConfig.validCapsByStart[String(s)]!) {
        const srv = priceSpreadOnVenue({
          book: skewedNvda,
          tierKind: "CUSTOM",
          tierLabel: "Custom Range",
          direction: "BEAR",
          lowerStrike: cap,
          upperStrike: s,
          stakeUsdt: 20,
          protocolFeeBps: 400,
          mmOpenMarkupBps: 110,
        }).summary;
        const cli = estimateCustomTicketPreview({
          underlying: "NVDAB",
          direction: "BEAR",
          tenor: "WEEKLY",
          expiry: skewedNvda.expiry,
          availableStrikes: skewedNvda.availableStrikes,
          lowerStrike: cap,
          upperStrike: s,
          stakeUsdt: 20,
          config: skewedBearShelf.customConfig,
        });
        expect(cli.guardrails.valid).toBe(true);
        const diff =
          Math.abs(cli.maxPayoutUsdt - srv.maxPayoutUsdt) / srv.maxPayoutUsdt;
        expect(diff).toBeLessThan(0.04);
      }
    }
  });
});

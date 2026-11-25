import { describe, expect, it } from "vitest";
import { recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ASSET_BTC_ID,
  ATLAS_FEEDS,
  BSC_TESTNET,
  bsOptionPrice,
  CLOSE_QUOTE_TYPES,
  computeSeriesId,
  getPayoffEip712Domain,
  OPEN_QUOTE_TYPES,
  priceToUnits,
  usdtToUnits,
  type AtlasFeedTelemetry,
  type ExpiryBook,
  type OptionStrikeQuote,
} from "@payoff/shared";
import {
  buildFixedGridShelf,
  computeConsensusRiskAdjustments,
  computeFairSpreadUnitUsd,
  computeMmCloseUnitUsd,
  computeMmOpenUnitUsd,
  ConsensusCircuitBreakerError,
  estimatePositionExitUsdt,
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

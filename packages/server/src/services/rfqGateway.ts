import { randomUUID } from "crypto";
import {
  ConsensusCircuitBreakerError,
  MockMakerSigner,
  ShelfEngine,
} from "@payoff/mock-maker";
import {
  MAX_CLOSE_FEE_BPS,
  MAX_OPEN_FEE_BPS,
  MIN_CLOSE_LEAD_TIME_SEC,
  PAYOFF_VAULT_ABI,
  computeProtocolFee,
  computeTokenId,
  evaluateSpreadHedgeRoutes,
  priceToUnits,
  symbolToAssetId,
  unitsToUsdt,
  usdtToUnits,
  type CloseRfqResponse,
  type CompetingCloseQuote,
  type CompetingOpenQuote,
  type Direction,
  type ExpiryTenor,
  type OpenRfqResponse,
  type TierKind,
  type UnderlyingSymbol,
} from "@payoff/shared";
import type { ServerConfig } from "../config.js";
import type { PayoffDatabase } from "../db/database.js";
import type { AtlasOracleService } from "./atlasOracle.js";
import type { ChainService } from "./chainService.js";
import type { MarketDataService } from "./marketData.js";

const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as const;

export class RfqGateway {
  private nonceCounter = BigInt(Date.now()) * 1000n;
  private readonly makerSigner: MockMakerSigner;

  constructor(
    private config: ServerConfig,
    private db: PayoffDatabase,
    private atlasOracle: AtlasOracleService,
    private marketData: MarketDataService,
    private chain: ChainService,
    private shelfEngine: ShelfEngine
  ) {
    this.makerSigner = new MockMakerSigner({
      chainId: config.chainId,
      verifyingContract: config.vaultAddress,
      makers: config.makers.map((m) => ({
        id: m.id,
        name: m.name,
        privateKey: m.privateKey,
        openMarkupBps: m.openMarkupBps,
        closeCompetitivenessBps: m.closeCompetitivenessBps,
      })),
    });
  }

  private nextNonce(): bigint {
    this.nonceCounter += 1n;
    return this.nonceCounter;
  }

  /**
   * Fail-closed guard: when live Atlas feeds are enabled, never sign Open or Close
   * quotes if the Atlas feed is offline or stale (>60s local age / >90s oracle timestamp).
   */
  private assertLiveAtlasFresh(underlying: UnderlyingSymbol) {
    if (!this.atlasOracle.isLiveModeActive()) return;
    if (!this.atlasOracle.isLiveDataAvailable(underlying, 60_000)) {
      const tel = this.atlasOracle.getTelemetry(underlying);
      throw new ConsensusCircuitBreakerError(
        tel.consensusStatus,
        tel.consensusScore,
        `Atlas live oracle feed for ${underlying} is offline or stale (>60s); RFQ quoting temporarily paused`
      );
    }
  }

  async requestOpenRfq(params: {
    taker: `0x${string}`;
    underlying: UnderlyingSymbol;
    direction: Direction;
    tenor: ExpiryTenor;
    tierKind: TierKind;
    lowerStrike: number;
    upperStrike: number;
    stakeUsdt: number;
  }): Promise<OpenRfqResponse> {
    const {
      taker,
      underlying,
      direction,
      tenor,
      tierKind,
      lowerStrike,
      upperStrike,
      stakeUsdt,
    } = params;

    if (!this.config.vaultAddress || this.config.vaultAddress === ZERO_ADDR) {
      throw new Error(
        "PayoffSpreadVault contract is not deployed on the current network (vaultAddress is zero)"
      );
    }

    if (!Number.isFinite(stakeUsdt) || stakeUsdt < 1 || stakeUsdt > 50_000) {
      throw new Error("Stake must be between 1 and 50,000 USDT");
    }

    // Enforce live Atlas freshness (fail-closed) & Enterprise ConsensusScore quoting guard
    this.assertLiveAtlasFresh(underlying);
    const atlasTelemetry = this.atlasOracle.getTelemetry(underlying);
    const guard = this.atlasOracle.getConsensusGuard(underlying);
    const risk = this.makerSigner.isOpenQuotingAllowed(atlasTelemetry);
    if (!guard.quotingSafe || !risk.quotingAllowed) {
      throw new ConsensusCircuitBreakerError(
        atlasTelemetry.consensusStatus,
        atlasTelemetry.consensusScore,
        guard.reason || risk.reason
      );
    }

    // Reject self-trade: filter out any maker whose address equals taker
    const eligibleMakers = this.makerSigner
      .getMakers()
      .filter((m) => m.address.toLowerCase() !== taker.toLowerCase());
    if (eligibleMakers.length === 0) {
      throw new Error(
        "Self-trade not allowed: taker address matches the only configured market maker"
      );
    }

    const onChainFees = await this.chain.getOnChainProtocolFees();
    const protocolFeeBps = Math.min(MAX_OPEN_FEE_BPS, onChainFees.openFeeBps);

    const book = this.marketData.getExpiryBook(underlying, tenor);
    const tierLabel =
      tierKind === "CONSERVATIVE"
        ? "Protected Tier"
        : tierKind === "STANDARD"
          ? "Standard Tier"
          : tierKind === "BREAKOUT"
            ? "Breakout Tier"
            : "Custom Range";

    const userPayAmount = usdtToUnits(stakeUsdt);
    const protocolFeeUnits = computeProtocolFee(userPayAmount, protocolFeeBps);
    const mmPremiumUnits = userPayAmount - protocolFeeUnits;

    // Query maker whitelist, makerMargin, and makerEpoch on-chain for all eligible makers
    const makerStates = await Promise.all(
      eligibleMakers.map((m) => this.chain.getMakerOnChainState(m.address))
    );

    const makerQuotes = eligibleMakers.map((maker, idx) => {
      const primary = this.shelfEngine.priceSpread({
        book,
        tierKind,
        tierLabel,
        direction,
        lowerStrike,
        upperStrike,
        stakeUsdt,
        protocolFeeBps,
        mmOpenMarkupBps:
          maker.openMarkupBps + (idx === 1 && tenor === "WEEKLY" ? -18 : 0),
        venue: maker.venue,
        atlasTelemetry,
      });

      const maxPayoutUnits = usdtToUnits(primary.summary.maxPayoutUsdt);
      const requiredMargin =
        maxPayoutUnits > mmPremiumUnits ? maxPayoutUnits - mmPremiumUnits : 0n;
      const state = makerStates[idx];
      const isWhitelisted = state === null ? true : state.whitelisted;
      const hasEnoughMargin =
        state === null ? true : state.marginUnits >= requiredMargin;

      return {
        maker,
        priced: primary,
        maxPayoutUnits,
        epoch: state ? state.epoch : 0n,
        isWhitelisted,
        hasEnoughMargin,
      };
    });

    const whitelistedQuotes = makerQuotes.filter((q) => q.isWhitelisted);
    if (whitelistedQuotes.length === 0) {
      throw new Error(
        "No whitelisted market makers are currently available to quote"
      );
    }

    const fundedQuotes = whitelistedQuotes.filter((q) => q.hasEnoughMargin);
    if (fundedQuotes.length === 0) {
      throw new Error(
        "Insufficient market maker margin (makerMargin) for this order size; please reduce stake or retry later"
      );
    }

    const sorted = [...fundedQuotes].sort(
      (a, b) => b.priced.summary.maxPayoutUsdt - a.priced.summary.maxPayoutUsdt
    );
    const winner = sorted[0]!;

    if (!winner.priced.summary.guardrails.valid) {
      throw new Error(
        winner.priced.summary.guardrails.errors[0] ||
          "Selected range does not satisfy spread guardrails"
      );
    }

    const isUp = direction === "BULL";
    const assetId = symbolToAssetId(underlying);
    const lowerStrike8 = priceToUnits(lowerStrike);
    const upperStrike8 = priceToUnits(upperStrike);
    const maxPayout = winner.maxPayoutUnits;
    if (maxPayout <= userPayAmount) {
      throw new Error(
        "Max payout must exceed stake; please adjust strike range"
      );
    }

    const effNow = await this.chain.getEffectiveNow();
    const validUntil = effNow + 45;
    const nonce = this.nextNonce();

    const signed = await this.makerSigner.signOpenQuote({
      quote: {
        taker,
        maker: winner.maker.address,
        assetId,
        isUp,
        lowerStrike: lowerStrike8,
        upperStrike: upperStrike8,
        expiry: book.expiry,
        userPayAmount,
        maxPayout,
        maxProtocolFeeBps: protocolFeeBps,
        makerEpoch: winner.epoch,
        validUntil,
        nonce,
      },
      atlasTelemetry,
    });

    const competingQuotes: CompetingOpenQuote[] = sorted.map((item, idx) => ({
      makerName: item.maker.name,
      makerAddress: item.maker.address,
      venue: item.priced.venue,
      hedgeRoute: item.priced.hedge.route,
      isParityFlip: item.priced.hedge.isParityFlip,
      maxPayoutUsdt: item.priced.summary.maxPayoutUsdt,
      maxMultiplier: item.priced.summary.maxMultiplier,
      mmMarginBps: item.priced.mmMarginBps,
      paritySavedUsd: Number(item.priced.hedge.paritySavedUsd.toFixed(4)),
      isWinner: idx === 0,
    }));

    const protocolFeeUsdt = unitsToUsdt(protocolFeeUnits);
    const quoteId = randomUUID();

    await this.db.saveRfqQuote({
      quoteId,
      kind: "OPEN",
      taker,
      maker: winner.maker.address,
      makerName: winner.maker.name,
      seriesId: signed.seriesId,
      tierKind,
      underlying,
      direction,
      isUp: isUp ? 1 : 0,
      lowerStrike,
      upperStrike,
      expiry: book.expiry,
      stakeUsdt,
      protocolFeeUsdt,
      maxPayoutUsdt: winner.priced.summary.maxPayoutUsdt,
      buybackUsdt: 0,
      nonce: nonce.toString(),
      competingQuotesJson: JSON.stringify(competingQuotes),
      hedgePlanJson: JSON.stringify(winner.priced.hedge),
      status: "QUOTED",
      createdAt: Math.floor(Date.now() / 1000),
    });

    return {
      quoteId,
      seriesId: signed.seriesId,
      verifyingContract: signed.verifyingContract,
      chainId: signed.chainId,
      usdtAddress: this.config.usdtAddress,
      quote: signed.quote,
      signature: signed.signature,
      makerName: signed.makerName,
      ticket: winner.priced.summary,
      competingQuotes,
    };
  }

  async requestCloseRfq(params: {
    taker: `0x${string}`;
    seriesId: `0x${string}`;
    isUp?: boolean;
    closeAmountUsdt?: number;
  }): Promise<CloseRfqResponse> {
    if (!this.config.vaultAddress || this.config.vaultAddress === ZERO_ADDR) {
      throw new Error(
        "PayoffSpreadVault contract is not deployed on the current network"
      );
    }

    const { taker, seriesId, closeAmountUsdt } = params;

    const eligibleMakers = this.makerSigner
      .getMakers()
      .filter((m) => m.address.toLowerCase() !== taker.toLowerCase());
    if (eligibleMakers.length === 0) {
      throw new Error(
        "Self-trade not allowed: taker address matches the only configured market maker"
      );
    }

    const dbTickets = await this.db.getTicketsByTaker(taker);
    const matchingDb = dbTickets.filter(
      (t) =>
        t.seriesId.toLowerCase() === seriesId.toLowerCase() &&
        (params.isUp === undefined || Boolean(t.isUp) === params.isUp)
    );
    let ticket = matchingDb[0];

    if (!ticket) {
      const onChain = await this.chain.getUserActivePositionsOnChain(taker);
      const matchingOc = (onChain || []).filter(
        (p) =>
          p.seriesId.toLowerCase() === seriesId.toLowerCase() &&
          (params.isUp === undefined || p.isUp === params.isUp)
      );
      if (matchingOc.length > 1 && params.isUp === undefined) {
        throw new Error(
          "Both UP and DOWN positions exist on this seriesId; please specify isUp"
        );
      }
      const oc = matchingOc[0];
      if (oc) {
        ticket = {
          seriesId: oc.seriesId,
          isUp: oc.isUp ? 1 : 0,
          taker: taker.toLowerCase(),
          originalMaker: ZERO_ADDR,
          tierKind: "CUSTOM",
          underlying: oc.underlying,
          direction: oc.direction,
          lowerStrike: oc.lowerStrike,
          upperStrike: oc.upperStrike,
          expiry: oc.expiry,
          initialMaxPayout: oc.balanceUsdt,
          remainingBalance: oc.balanceUsdt,
          closedBalance: 0,
          totalStakeUsdt: 0,
          protocolFeeUsdt: 0,
          earlyCloseProceedsUsdt: 0,
          redeemedUsdt: 0,
          status: oc.settled ? "SETTLED_CLAIMABLE" : "ACTIVE",
          openTxHash: "",
          createdAt: Math.floor(Date.now() / 1000),
          updatedAt: Math.floor(Date.now() / 1000),
        };
      }
    } else if (matchingDb.length > 1 && params.isUp === undefined) {
      throw new Error(
        "Both UP and DOWN positions exist on this seriesId; please specify isUp"
      );
    }

    if (!ticket) {
      throw new Error("Position ticket not found for taker");
    }

    const isUp = params.isUp !== undefined ? params.isUp : Boolean(ticket.isUp);
    const takerTokenId = computeTokenId(seriesId, isUp);
    const compTokenId = computeTokenId(seriesId, !isUp);

    const onChainBal = await this.chain.publicClient.readContract({
      address: this.config.vaultAddress,
      abi: PAYOFF_VAULT_ABI,
      functionName: "balanceOf",
      args: [taker, takerTokenId],
    });

    if (onChainBal <= 0n) {
      throw new Error("On-chain closeable token balance is zero");
    }

    const requestedUnits =
      closeAmountUsdt && closeAmountUsdt > 0
        ? usdtToUnits(closeAmountUsdt)
        : onChainBal;
    const amountUnits =
      requestedUnits > onChainBal ? onChainBal : requestedUnits;
    const amountUsdt = unitsToUsdt(amountUnits);

    // Fail-closed if live Atlas feed is offline/stale (protects maker margin from stale buybacks)
    this.assertLiveAtlasFresh(ticket.underlying);

    const effNow = await this.chain.getEffectiveNow();
    if (effNow + MIN_CLOSE_LEAD_TIME_SEC >= ticket.expiry) {
      throw new Error(
        "Less than 30 minutes until expiry (TWAP settlement observation window active); early close is locked"
      );
    }
    const hoursRemaining = Math.max(0.2, (ticket.expiry - effNow) / 3600);

    const snap = this.marketData.getSnapshot(ticket.underlying);
    const atlasTelemetry = this.atlasOracle.getTelemetry(ticket.underlying);
    const book =
      hoursRemaining > 42 && snap.weekly ? snap.weekly : snap.daily!;

    const est = this.shelfEngine.estimatePositionExit({
      book,
      isCall: isUp,
      lowerStrike: ticket.lowerStrike,
      upperStrike: ticket.upperStrike,
      remainingLongUsdt: amountUsdt,
      hoursRemaining,
      atlasTelemetry,
    });

    const onChainFees = await this.chain.getOnChainProtocolFees();
    const closeFeeBps = Math.min(MAX_CLOSE_FEE_BPS, onChainFees.closeFeeBps);

    const [compBalances, makerStates] = await Promise.all([
      Promise.all(
        eligibleMakers.map((m) =>
          this.chain.publicClient.readContract({
            address: this.config.vaultAddress,
            abi: PAYOFF_VAULT_ABI,
            functionName: "balanceOf",
            args: [m.address, compTokenId],
          })
        )
      ),
      Promise.all(
        eligibleMakers.map((m) => this.chain.getMakerOnChainState(m.address))
      ),
    ]);

    const width = ticket.upperStrike - ticket.lowerStrike;
    const notional = width > 0 ? amountUsdt / width : 0;

    const bids = eligibleMakers.map((maker, idx) => {
      const compBalUnits = compBalances[idx]!;
      const compBalUsdt = unitsToUsdt(compBalUnits);

      const bid = this.makerSigner.computeCloseBid({
        amountUnits,
        makerCompBalanceUnits: compBalUnits,
        baseBidUsdt: est.mockMakerBidUsdt,
        closeCompetitivenessBps: maker.closeCompetitivenessBps,
        atlasTelemetry,
      });

      const state = makerStates[idx];
      const isWhitelisted = state === null ? true : state.whitelisted;
      const hasEnoughMargin =
        state === null ? true : state.marginUnits >= bid.requiredTopUpUnits;

      const lq = book.syntheticStrikes[ticket.lowerStrike];
      const uq = book.syntheticStrikes[ticket.upperStrike];
      const hedge =
        lq && uq
          ? evaluateSpreadHedgeRoutes({
              venue: maker.venue,
              spotUsd: book.spot,
              isCall: isUp,
              lowerQuote: lq,
              upperQuote: uq,
              notionalUnderlying: notional,
              side: "CLOSE",
            })
          : undefined;

      return {
        maker,
        buybackUsdt: bid.buybackUsdt,
        buybackUnits: bid.buybackUnits,
        makerCompBalanceUsdt: Number(compBalUsdt.toFixed(2)),
        executionMode: bid.executionMode,
        unlockAmountUsdt: bid.unlockAmountUsdt,
        epoch: state ? state.epoch : 0n,
        isWhitelisted,
        hasEnoughMargin,
        hedge,
      };
    });

    const whitelistedBids = bids.filter((b) => b.isWhitelisted);
    if (whitelistedBids.length === 0) {
      throw new Error(
        "No whitelisted market makers are available to buy back this ticket"
      );
    }

    const fundedBids = whitelistedBids.filter((b) => b.hasEnoughMargin);
    if (fundedBids.length === 0) {
      throw new Error(
        "Insufficient market maker margin available for early close"
      );
    }

    const sorted = [...fundedBids].sort((a, b) =>
      b.buybackUnits > a.buybackUnits
        ? 1
        : b.buybackUnits < a.buybackUnits
          ? -1
          : 0
    );
    const winner = sorted[0]!;
    const buybackUnits = winner.buybackUnits;

    const maxCloseValidUntil = ticket.expiry - MIN_CLOSE_LEAD_TIME_SEC;
    const validUntil = Math.min(effNow + 45, maxCloseValidUntil);
    const nonce = this.nextNonce();

    const signed = await this.makerSigner.signCloseQuote({
      quote: {
        taker,
        maker: winner.maker.address,
        seriesId,
        isUp,
        amount: amountUnits,
        buybackAmount: buybackUnits,
        maxCloseFeeBps: closeFeeBps,
        makerEpoch: winner.epoch,
        validUntil,
        nonce,
      },
      atlasTelemetry,
    });

    const closeFeeUnits = (buybackUnits * BigInt(closeFeeBps)) / 10_000n;
    const netProceedsUsdt = unitsToUsdt(buybackUnits - closeFeeUnits);

    const competingQuotes: CompetingCloseQuote[] = sorted.map((b, idx) => ({
      makerName: b.maker.name,
      makerAddress: b.maker.address,
      venue: b.maker.venue,
      buybackUsdt: Number(b.buybackUsdt.toFixed(2)),
      makerCompBalanceUsdt: b.makerCompBalanceUsdt,
      executionMode: b.executionMode,
      unlockAmountUsdt: b.unlockAmountUsdt,
      isWinner: idx === 0,
    }));

    const quoteId = randomUUID();
    await this.db.saveRfqQuote({
      quoteId,
      kind: "CLOSE",
      taker,
      maker: winner.maker.address,
      makerName: winner.maker.name,
      seriesId,
      tierKind: ticket.tierKind,
      underlying: ticket.underlying,
      direction: isUp ? "BULL" : "BEAR",
      isUp: isUp ? 1 : 0,
      lowerStrike: ticket.lowerStrike,
      upperStrike: ticket.upperStrike,
      expiry: ticket.expiry,
      stakeUsdt: ticket.totalStakeUsdt,
      protocolFeeUsdt: unitsToUsdt(closeFeeUnits),
      maxPayoutUsdt: amountUsdt,
      buybackUsdt: unitsToUsdt(buybackUnits),
      nonce: nonce.toString(),
      competingQuotesJson: JSON.stringify(competingQuotes),
      hedgePlanJson: JSON.stringify(
        winner.hedge ?? {
          venue: winner.maker.venue,
          route: isUp ? "DIRECT_CALL_SPREAD" : "DIRECT_PUT_SPREAD",
          isParityFlip: false,
          longLegInstId: `${ticket.underlying}-CLOSE-LONG`,
          shortLegInstId: `${ticket.underlying}-CLOSE-SHORT`,
          notionalUnderlying: notional,
          rawSpreadUsd: unitsToUsdt(buybackUnits),
          exchangeFeeUsd: 0,
          totalHedgeCostUsd: unitsToUsdt(buybackUnits),
          paritySavedUsd: 0,
        }
      ),
      status: "QUOTED",
      createdAt: Math.floor(Date.now() / 1000),
    });

    return {
      quoteId,
      seriesId,
      isUp,
      verifyingContract: signed.verifyingContract,
      chainId: signed.chainId,
      quote: signed.quote,
      signature: signed.signature,
      makerName: signed.makerName,
      executionMode: winner.executionMode,
      unlockAmountUsdt: winner.unlockAmountUsdt,
      netProceedsUsdt: Number(netProceedsUsdt.toFixed(2)),
      competingQuotes,
    };
  }
}

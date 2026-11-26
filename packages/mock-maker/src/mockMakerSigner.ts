import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import {
  CLOSE_QUOTE_TYPES,
  computeSeriesId,
  getPayoffEip712Domain,
  OPEN_QUOTE_TYPES,
  unitsToUsdt,
  usdtToUnits,
  type AtlasConsensusStatus,
  type AtlasFeedTelemetry,
  type CloseExecutionMode,
  type CloseQuoteStruct,
  type OpenQuoteStruct,
  type RwaAssetTelemetry,
  type VenueName,
} from "@payoff/shared";
import {
  computeCombinedRiskAdjustments,
  DEFAULT_MM_OPEN_MARKUP_BPS,
  type CombinedRiskAdjustment,
  type ConsensusRiskAdjustment,
} from "./shelfEngine.js";

export interface MockMakerAccountConfig {
  id: string;
  name: string;
  privateKey: `0x${string}`;
  openMarkupBps?: number;
  closeCompetitivenessBps?: number;
}

export interface MockMakerInfo {
  id: string;
  name: string;
  address: `0x${string}`;
  venue: VenueName;
  openMarkupBps: number;
  closeCompetitivenessBps: number;
}

export interface MockMakerSignerOptions {
  chainId: number;
  verifyingContract: `0x${string}`;
  makers: MockMakerAccountConfig[];
}

export interface OpenQuoteSignInput {
  taker: `0x${string}`;
  maker: `0x${string}`;
  assetId: `0x${string}`;
  isUp: boolean;
  lowerStrike: bigint | string;
  upperStrike: bigint | string;
  expiry: bigint | number;
  userPayAmount: bigint | string;
  maxPayout: bigint | string;
  maxProtocolFeeBps: number;
  makerEpoch: bigint | string | number;
  validUntil: bigint | number;
  nonce: bigint | string;
}

export interface CloseQuoteSignInput {
  taker: `0x${string}`;
  maker: `0x${string}`;
  seriesId: `0x${string}`;
  isUp: boolean;
  amount: bigint | string;
  buybackAmount: bigint | string;
  maxCloseFeeBps: number;
  makerEpoch: bigint | string | number;
  validUntil: bigint | number;
  nonce: bigint | string;
}

export interface SignOpenQuoteParams {
  quote: OpenQuoteSignInput;
  atlasTelemetry?: AtlasFeedTelemetry;
  rwaTelemetry?: RwaAssetTelemetry;
  chainId?: number;
  verifyingContract?: `0x${string}`;
}

export interface SignedOpenQuoteResult {
  quote: OpenQuoteStruct;
  signature: `0x${string}`;
  seriesId: `0x${string}`;
  verifyingContract: `0x${string}`;
  chainId: number;
  makerName: string;
  consensusRisk: ConsensusRiskAdjustment;
}

export interface SignCloseQuoteParams {
  quote: CloseQuoteSignInput;
  atlasTelemetry?: AtlasFeedTelemetry;
  rwaTelemetry?: RwaAssetTelemetry;
  chainId?: number;
  verifyingContract?: `0x${string}`;
}

export interface SignedCloseQuoteResult {
  quote: CloseQuoteStruct;
  signature: `0x${string}`;
  verifyingContract: `0x${string}`;
  chainId: number;
  makerName: string;
  consensusRisk: ConsensusRiskAdjustment;
  conservativeExitApplied: boolean;
}

export interface ComputeCloseBidParams {
  amountUnits: bigint;
  makerCompBalanceUnits: bigint;
  baseBidUsdt: number;
  closeCompetitivenessBps: number;
  atlasTelemetry?: AtlasFeedTelemetry;
  rwaTelemetry?: RwaAssetTelemetry;
}

export interface CloseBidComputation {
  buybackUnits: bigint;
  buybackUsdt: number;
  mergeUnits: bigint;
  unlockAmountUsdt: number;
  requiredTopUpUnits: bigint;
  executionMode: CloseExecutionMode;
  consensusRisk: ConsensusRiskAdjustment;
}

/**
 * Thrown when the Atlas Enterprise ConsensusScore circuit breaker halts new OpenQuote signing
 * (`CRITICAL` or `SPLIT_MARKET`). Reverse-RFQ CloseQuote exits remain open so takers are never trapped.
 */
export class ConsensusCircuitBreakerError extends Error {
  readonly consensusStatus: AtlasConsensusStatus;
  readonly consensusScore: number | null;
  readonly reason: string;

  constructor(
    consensusStatus: AtlasConsensusStatus,
    consensusScore: number | null,
    reason: string
  ) {
    super(reason);
    this.name = "ConsensusCircuitBreakerError";
    this.consensusStatus = consensusStatus;
    this.consensusScore = consensusScore;
    this.reason = reason;
  }
}

interface InternalMakerEntry {
  info: MockMakerInfo;
  account: PrivateKeyAccount;
}

function normalizePrivateKey(pk: string): `0x${string}` {
  const trimmed = pk.trim();
  const hex = trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("Invalid mock maker private key format");
  }
  return hex as `0x${string}`;
}

/**
 * Encapsulates Reference / Mock Market Maker EIP-712 quote signing and Atlas ConsensusScore
 * quoting circuit-breaker enforcement. Private keys are injected via options/env and never exposed.
 */
export class MockMakerSigner {
  private chainId: number;
  private verifyingContract: `0x${string}`;
  private makersByAddress = new Map<string, InternalMakerEntry>();
  private makerOrder: InternalMakerEntry[] = [];

  constructor(options: MockMakerSignerOptions) {
    this.chainId = options.chainId;
    this.verifyingContract = options.verifyingContract;

    for (const cfg of options.makers) {
      const pk = normalizePrivateKey(cfg.privateKey);
      const account = privateKeyToAccount(pk);
      const info: MockMakerInfo = {
        id: cfg.id,
        name: cfg.name,
        address: account.address,
        venue: "MOCK_MAKER",
        openMarkupBps: cfg.openMarkupBps ?? DEFAULT_MM_OPEN_MARKUP_BPS,
        closeCompetitivenessBps: cfg.closeCompetitivenessBps ?? 15,
      };
      const entry: InternalMakerEntry = { info, account };
      const key = account.address.toLowerCase();
      if (!this.makersByAddress.has(key)) {
        this.makersByAddress.set(key, entry);
        this.makerOrder.push(entry);
      }
    }
  }

  /**
   * Builds a `MockMakerSigner` from environment variables (`MM1_PRIVATE_KEY`, `MM2_PRIVATE_KEY`, `MM3_PRIVATE_KEY`).
   */
  static fromEnv(
    env: Record<string, string | undefined>,
    opts: { chainId: number; verifyingContract: `0x${string}` }
  ): MockMakerSigner {
    const definitions: Array<{
      envKey: string;
      id: string;
      name: string;
      openMarkupBps: number;
      closeCompetitivenessBps: number;
    }> = [
      {
        envKey: "MM1_PRIVATE_KEY",
        id: "mm1",
        name: "Payoff Reference MM #1",
        openMarkupBps: 110,
        closeCompetitivenessBps: 15,
      },
      {
        envKey: "MM2_PRIVATE_KEY",
        id: "mm2",
        name: "Payoff Reference MM #2",
        openMarkupBps: 120,
        closeCompetitivenessBps: 25,
      },
      {
        envKey: "MM3_PRIVATE_KEY",
        id: "mm3",
        name: "Payoff Reference MM #3",
        openMarkupBps: 130,
        closeCompetitivenessBps: 35,
      },
    ];

    const makers: MockMakerAccountConfig[] = [];
    for (const def of definitions) {
      const raw = env[def.envKey]?.trim();
      if (raw) {
        makers.push({
          id: def.id,
          name: def.name,
          privateKey: normalizePrivateKey(raw),
          openMarkupBps: def.openMarkupBps,
          closeCompetitivenessBps: def.closeCompetitivenessBps,
        });
      }
    }

    return new MockMakerSigner({
      chainId: opts.chainId,
      verifyingContract: opts.verifyingContract,
      makers,
    });
  }

  getMakers(): MockMakerInfo[] {
    return this.makerOrder.map((entry) => ({ ...entry.info }));
  }

  getMaker(addressOrId: string): MockMakerInfo | undefined {
    const lower = addressOrId.toLowerCase();
    const byAddr = this.makersByAddress.get(lower);
    if (byAddr) return { ...byAddr.info };
    const byId = this.makerOrder.find((e) => e.info.id.toLowerCase() === lower);
    return byId ? { ...byId.info } : undefined;
  }

  hasMaker(address: string): boolean {
    return this.makersByAddress.has(address.toLowerCase());
  }

  setVerifyingContract(verifyingContract: `0x${string}`, chainId?: number): void {
    this.verifyingContract = verifyingContract;
    if (chainId !== undefined) {
      this.chainId = chainId;
    }
  }

  /**
   * Evaluates whether new OpenQuote signing is permitted under current Atlas & RWA telemetry.
   */
  isOpenQuotingAllowed(
    telemetry?: AtlasFeedTelemetry,
    rwaTelemetry?: RwaAssetTelemetry
  ): CombinedRiskAdjustment {
    return computeCombinedRiskAdjustments(telemetry, rwaTelemetry);
  }

  /**
   * Computes a competitive reverse-RFQ early-exit buyback bid incorporating
   * atomic-merge unlock edge (`UP + DOWN -> 1 USDT` instant collateral release)
   * and conservative spread adjustment when Atlas ConsensusScore or RWA risk is elevated.
   */
  computeCloseBid(params: ComputeCloseBidParams): CloseBidComputation {
    const {
      amountUnits,
      makerCompBalanceUnits,
      baseBidUsdt,
      closeCompetitivenessBps,
      atlasTelemetry,
      rwaTelemetry,
    } = params;

    const consensusRisk = computeCombinedRiskAdjustments(
      atlasTelemetry,
      rwaTelemetry
    );
    const amountUsdt = unitsToUsdt(amountUnits);
    const mergeUnits =
      amountUnits <= makerCompBalanceUnits ? amountUnits : makerCompBalanceUnits;
    const unlockAmountUsdt = unitsToUsdt(mergeUnits);

    const executionMode: CloseExecutionMode =
      mergeUnits === amountUnits
        ? "ATOMIC_MERGE_UNLOCK"
        : mergeUnits === 0n
          ? "EXTERNAL_TAKEOVER"
          : "HYBRID";

    const spreadPenalty =
      (closeCompetitivenessBps / 10_000) *
      baseBidUsdt *
      0.2 *
      consensusRisk.spreadMultiplier;
    const mergeUnlockEdge = mergeUnits > 0n ? amountUsdt * 0.0025 : 0;
    const floorBid = Math.min(0.01, amountUsdt * 0.01);
    const rawBid = Math.min(
      amountUsdt * 0.99,
      Math.max(floorBid, baseBidUsdt - spreadPenalty + mergeUnlockEdge)
    );

    let buybackUnits = usdtToUnits(rawBid);
    if (buybackUnits <= 0n) buybackUnits = 1n;
    if (buybackUnits > amountUnits) buybackUnits = amountUnits;

    const requiredTopUpUnits =
      buybackUnits > mergeUnits ? buybackUnits - mergeUnits : 0n;

    return {
      buybackUnits,
      buybackUsdt: Number(unitsToUsdt(buybackUnits).toFixed(4)),
      mergeUnits,
      unlockAmountUsdt: Number(unlockAmountUsdt.toFixed(2)),
      requiredTopUpUnits,
      executionMode,
      consensusRisk,
    };
  }

  /**
   * Signs an EIP-712 `OpenQuote` for a configured mock maker.
   * Refuses to sign (throws `ConsensusCircuitBreakerError`) if Atlas `consensusStatus`
   * is `CRITICAL` / `SPLIT_MARKET`, or if RWA `splitGuardTriggered` / `corporateActionBlackout` is active.
   */
  async signOpenQuote(
    params: SignOpenQuoteParams
  ): Promise<SignedOpenQuoteResult> {
    const consensusRisk = computeCombinedRiskAdjustments(
      params.atlasTelemetry,
      params.rwaTelemetry
    );
    if (!consensusRisk.quotingAllowed) {
      throw new ConsensusCircuitBreakerError(
        params.atlasTelemetry?.consensusStatus ?? "CRITICAL",
        params.atlasTelemetry?.consensusScore ?? null,
        consensusRisk.reason
      );
    }

    const q = params.quote;
    if (q.taker.toLowerCase() === q.maker.toLowerCase()) {
      throw new Error("Self-trade not allowed: taker cannot equal maker");
    }

    const entry = this.makersByAddress.get(q.maker.toLowerCase());
    if (!entry) {
      throw new Error(`Maker ${q.maker} is not configured in MockMakerSigner`);
    }

    const chainId = params.chainId ?? this.chainId;
    const verifyingContract = params.verifyingContract ?? this.verifyingContract;

    const lowerStrike = BigInt(q.lowerStrike);
    const upperStrike = BigInt(q.upperStrike);
    const expiry = BigInt(q.expiry);
    const userPayAmount = BigInt(q.userPayAmount);
    const maxPayout = BigInt(q.maxPayout);
    const makerEpoch = BigInt(q.makerEpoch);
    const validUntil = BigInt(q.validUntil);
    const nonce = BigInt(q.nonce);

    const message = {
      taker: q.taker,
      maker: entry.info.address,
      assetId: q.assetId,
      isUp: q.isUp,
      lowerStrike,
      upperStrike,
      expiry,
      userPayAmount,
      maxPayout,
      maxProtocolFeeBps: q.maxProtocolFeeBps,
      makerEpoch,
      validUntil,
      nonce,
    };

    const signature = await entry.account.signTypedData({
      domain: getPayoffEip712Domain(chainId, verifyingContract),
      types: OPEN_QUOTE_TYPES,
      primaryType: "OpenQuote",
      message,
    });

    const seriesId = computeSeriesId(
      q.assetId,
      lowerStrike,
      upperStrike,
      expiry
    );

    return {
      quote: {
        taker: q.taker,
        maker: entry.info.address,
        assetId: q.assetId,
        isUp: q.isUp,
        lowerStrike: lowerStrike.toString(),
        upperStrike: upperStrike.toString(),
        expiry: Number(expiry),
        userPayAmount: userPayAmount.toString(),
        maxPayout: maxPayout.toString(),
        maxProtocolFeeBps: q.maxProtocolFeeBps,
        makerEpoch: makerEpoch.toString(),
        validUntil: Number(validUntil),
        nonce: nonce.toString(),
      },
      signature,
      seriesId,
      verifyingContract,
      chainId,
      makerName: entry.info.name,
      consensusRisk,
    };
  }

  /**
   * Signs an EIP-712 `CloseQuote` for a configured mock maker.
   * Intentionally remains available during `CRITICAL` / `SPLIT_MARKET` and RWA split/blackout
   * circuit breakers so existing ticket holders can still exit early (with conservative spreads).
   */
  async signCloseQuote(
    params: SignCloseQuoteParams
  ): Promise<SignedCloseQuoteResult> {
    const consensusRisk = computeCombinedRiskAdjustments(
      params.atlasTelemetry,
      params.rwaTelemetry
    );
    const q = params.quote;

    if (q.taker.toLowerCase() === q.maker.toLowerCase()) {
      throw new Error("Self-trade not allowed: taker cannot equal maker");
    }

    const entry = this.makersByAddress.get(q.maker.toLowerCase());
    if (!entry) {
      throw new Error(`Maker ${q.maker} is not configured in MockMakerSigner`);
    }

    const chainId = params.chainId ?? this.chainId;
    const verifyingContract = params.verifyingContract ?? this.verifyingContract;

    const amount = BigInt(q.amount);
    const buybackAmount = BigInt(q.buybackAmount);
    const makerEpoch = BigInt(q.makerEpoch);
    const validUntil = BigInt(q.validUntil);
    const nonce = BigInt(q.nonce);

    const message = {
      taker: q.taker,
      maker: entry.info.address,
      seriesId: q.seriesId,
      isUp: q.isUp,
      amount,
      buybackAmount,
      maxCloseFeeBps: q.maxCloseFeeBps,
      makerEpoch,
      validUntil,
      nonce,
    };

    const signature = await entry.account.signTypedData({
      domain: getPayoffEip712Domain(chainId, verifyingContract),
      types: CLOSE_QUOTE_TYPES,
      primaryType: "CloseQuote",
      message,
    });

    return {
      quote: {
        taker: q.taker,
        maker: entry.info.address,
        seriesId: q.seriesId,
        isUp: q.isUp,
        amount: amount.toString(),
        buybackAmount: buybackAmount.toString(),
        maxCloseFeeBps: q.maxCloseFeeBps,
        makerEpoch: makerEpoch.toString(),
        validUntil: Number(validUntil),
        nonce: nonce.toString(),
      },
      signature,
      verifyingContract,
      chainId,
      makerName: entry.info.name,
      consensusRisk,
      conservativeExitApplied:
        !consensusRisk.quotingAllowed || consensusRisk.spreadMultiplier > 1.0,
    };
  }
}

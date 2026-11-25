import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  fallback,
  http,
  parseEventLogs,
  parseUnits,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ATLAS_FEEDS,
  ATLAS_SETTLEMENT_ORACLE_ABI,
  BSC_TESTNET,
  MOCK_USDT_ABI,
  PAYOFF_LENS_ABI,
  PAYOFF_VAULT_ABI,
  SETTLEMENT_UTC_HOUR,
  assetIdToSymbol,
  priceToUnits,
  symbolToAssetId,
  unitsToPrice,
  unitsToUsdt,
  type Direction,
  type HedgeEvaluation,
  type SettlementSource,
  type UnderlyingSymbol,
} from "@payoff/shared";
import type { ServerConfig } from "../config.js";
import type { PayoffDatabase } from "../db/database.js";
import {
  buildSignedAtlasProofWithKey,
  type AtlasOracleService,
  type AtlasSignedProofResult,
  type ConsensusGuardState,
} from "./atlasOracle.js";
import type { MarketDataService } from "./marketData.js";

const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as const;
const BSC_TESTNET_FALLBACK_RPC = "https://bsc-testnet-rpc.publicnode.com";

export interface SettlementMeta {
  source?: SettlementSource;
  feedId?: string;
  feedIdHex?: Hex;
  oracleTimestamp?: number;
  submitter?: Hex;
}

export interface SettlementKeeperResult {
  underlying: UnderlyingSymbol;
  expiry: number;
  priceUsd: number;
  txHash: Hex | "ALREADY_SETTLED_ONCHAIN";
  source: SettlementSource;
  feedId?: string;
  feedIdHex?: Hex;
  oracleTimestamp?: number;
}

export interface OnChainActivePosition {
  tokenId: string;
  seriesId: Hex;
  assetId: Hex;
  underlying: UnderlyingSymbol;
  direction: Direction;
  isUp: boolean;
  lowerStrike: number;
  upperStrike: number;
  expiry: number;
  balanceUsdt: number;
  settled: boolean;
  settlementPrice: number;
  claimableUsdt: number;
}

export interface OnChainSeriesSummary {
  seriesId: Hex;
  assetId: Hex;
  underlying: UnderlyingSymbol;
  lowerStrike: number;
  upperStrike: number;
  expiry: number;
}

export interface VaultHealthSnapshot {
  usdtBalanceUsdt: number;
  lockedUsdt: number;
  makerMarginUsdt: number;
  accruedProtocolFeesUsdt: number;
  isSolvent: boolean;
}

export interface MakerOnChainState {
  whitelisted: boolean;
  marginUnits: bigint;
  epoch: bigint;
}

function tryAssetIdToSymbol(assetId: Hex): UnderlyingSymbol | null {
  try {
    return assetIdToSymbol(assetId);
  } catch {
    return null;
  }
}

function decodeFeedIdHexToDecimal(feedIdHex?: string): string | null {
  if (!feedIdHex || !feedIdHex.startsWith("0x")) return null;
  const parsed = parseInt(feedIdHex.slice(2), 16);
  return Number.isInteger(parsed) && parsed > 0 ? String(parsed) : null;
}

export class ChainService {
  public readonly publicClient: PublicClient;
  private readonly logsClient: PublicClient;
  private oracleAccount;
  private resolvedOracleAddress: Hex | null = null;
  private resolvedOracleFetchedAt = 0;
  private cachedProtocolFees: { openFeeBps: number; closeFeeBps: number } | null =
    null;
  private cachedProtocolFeesFetchedAt = 0;
  private syncPromise: Promise<void> | null = null;
  private keeperPromise: Promise<SettlementKeeperResult[]> | null = null;
  private pendingSettlementMeta = new Map<string, SettlementMeta>();
  private lastWaitingLogAt = new Map<string, number>();
  private lastBreakerLogAt = new Map<string, number>();
  private lastBackfillAt = new Map<string, number>();
  private timer?: NodeJS.Timeout;
  private cachedEffectiveNow = Math.floor(Date.now() / 1000);

  constructor(
    private config: ServerConfig,
    private db: PayoffDatabase,
    private atlasOracle: AtlasOracleService,
    private marketData?: MarketDataService
  ) {
    if (this.config.chainId === BSC_TESTNET.chainId) {
      const primary = http(this.config.rpcUrl);
      const isAlreadyFallback =
        this.config.rpcUrl.replace(/\/+$/, "").toLowerCase() ===
        BSC_TESTNET_FALLBACK_RPC;
      const publicTransports = isAlreadyFallback
        ? [primary]
        : [primary, http(BSC_TESTNET_FALLBACK_RPC)];
      this.publicClient = createPublicClient({
        transport: fallback(publicTransports, { rank: false }),
      });
      // BNB Chain public dataseed nodes reject eth_getLogs (-32005 limit exceeded);
      // prefer publicnode for eth_getLogs with automatic failover to configured rpcUrl.
      const logTransports = isAlreadyFallback
        ? [primary]
        : [http(BSC_TESTNET_FALLBACK_RPC), primary];
      this.logsClient = createPublicClient({
        transport: fallback(logTransports, { rank: false }),
      });
    } else {
      this.publicClient = createPublicClient({
        transport: http(this.config.rpcUrl),
      });
      this.logsClient = this.publicClient;
    }
    this.oracleAccount = privateKeyToAccount(this.config.oraclePrivateKey);
    if (
      this.config.settlementOracleAddress &&
      this.config.settlementOracleAddress !== ZERO_ADDR
    ) {
      this.resolvedOracleAddress = this.config.settlementOracleAddress;
    }
  }

  getOracleAddress(): Hex {
    return this.oracleAccount.address;
  }

  getSettlementCircuitBreaker(): Record<UnderlyingSymbol, ConsensusGuardState> {
    return this.atlasOracle.getAllConsensusGuards();
  }

  getCachedSettlementOracleContract(): Hex {
    return (
      this.resolvedOracleAddress ||
      this.config.settlementOracleAddress ||
      ZERO_ADDR
    );
  }

  async getSettlementOracleContract(forceRefresh = false): Promise<Hex> {
    const ORACLE_CACHE_TTL_MS = 30_000;
    const nowMs = Date.now();
    if (
      !forceRefresh &&
      this.resolvedOracleAddress &&
      this.resolvedOracleAddress !== ZERO_ADDR &&
      this.resolvedOracleFetchedAt > 0 &&
      nowMs - this.resolvedOracleFetchedAt < ORACLE_CACHE_TTL_MS
    ) {
      return this.resolvedOracleAddress;
    }
    if (this.isConfigured()) {
      try {
        const addr = await this.publicClient.readContract({
          address: this.config.vaultAddress,
          abi: PAYOFF_VAULT_ABI,
          functionName: "settlementOracle",
        });
        if (addr && addr !== ZERO_ADDR) {
          this.resolvedOracleAddress = addr;
          this.resolvedOracleFetchedAt = nowMs;
          return addr;
        }
      } catch {
        this.resolvedOracleFetchedAt = nowMs - ORACLE_CACHE_TTL_MS + 5_000;
      }
    }
    return this.getCachedSettlementOracleContract();
  }

  getCachedEffectiveNow(): number {
    return Math.max(Math.floor(Date.now() / 1000), this.cachedEffectiveNow);
  }

  setMarketData(md: MarketDataService) {
    this.marketData = md;
  }

  isConfigured(): boolean {
    return (
      this.config.vaultAddress !== ZERO_ADDR &&
      this.config.usdtAddress !== ZERO_ADDR
    );
  }

  start() {
    const tick = async () => {
      await this.syncEvents();
      await this.runSettlementKeeper();
    };
    void tick();
    this.timer = setInterval(() => {
      void tick();
    }, 5000);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async getEffectiveNow(): Promise<number> {
    const wallNow = Math.floor(Date.now() / 1000);
    try {
      const block = await this.publicClient.getBlock({ blockTag: "latest" });
      this.cachedEffectiveNow = Math.max(
        this.cachedEffectiveNow,
        wallNow,
        Number(block.timestamp)
      );
      return this.cachedEffectiveNow;
    } catch {
      this.cachedEffectiveNow = Math.max(this.cachedEffectiveNow, wallNow);
      return this.cachedEffectiveNow;
    }
  }

  async getVaultHealth(): Promise<VaultHealthSnapshot> {
    if (!this.isConfigured()) {
      return {
        usdtBalanceUsdt: 0,
        lockedUsdt: 0,
        makerMarginUsdt: 0,
        accruedProtocolFeesUsdt: 0,
        isSolvent: true,
      };
    }
    try {
      const [bal, locked, margin, fees, solvent] =
        await this.publicClient.readContract({
          address: this.config.vaultAddress,
          abi: PAYOFF_VAULT_ABI,
          functionName: "vaultHealth",
        });
      return {
        usdtBalanceUsdt: unitsToUsdt(bal),
        lockedUsdt: unitsToUsdt(locked),
        makerMarginUsdt: unitsToUsdt(margin),
        accruedProtocolFeesUsdt: unitsToUsdt(fees),
        isSolvent: solvent,
      };
    } catch {
      return {
        usdtBalanceUsdt: 0,
        lockedUsdt: 0,
        makerMarginUsdt: 0,
        accruedProtocolFeesUsdt: 0,
        isSolvent: true,
      };
    }
  }

  async getOnChainProtocolFees(forceRefresh = false): Promise<{
    openFeeBps: number;
    closeFeeBps: number;
  }> {
    if (!this.isConfigured()) {
      return {
        openFeeBps: this.config.protocolFeeBps,
        closeFeeBps: this.config.closeFeeBps,
      };
    }
    const FEES_CACHE_TTL_MS = 30_000;
    const nowMs = Date.now();
    if (
      !forceRefresh &&
      this.cachedProtocolFees &&
      nowMs - this.cachedProtocolFeesFetchedAt < FEES_CACHE_TTL_MS
    ) {
      return this.cachedProtocolFees;
    }
    try {
      const [openFeeBps, closeFeeBps] = await Promise.all([
        this.publicClient.readContract({
          address: this.config.vaultAddress,
          abi: PAYOFF_VAULT_ABI,
          functionName: "protocolOpenFeeBps",
        }),
        this.publicClient.readContract({
          address: this.config.vaultAddress,
          abi: PAYOFF_VAULT_ABI,
          functionName: "protocolCloseFeeBps",
        }),
      ]);
      this.cachedProtocolFees = {
        openFeeBps: Number(openFeeBps),
        closeFeeBps: Number(closeFeeBps),
      };
      this.cachedProtocolFeesFetchedAt = nowMs;
      return this.cachedProtocolFees;
    } catch {
      const fallback = this.cachedProtocolFees ?? {
        openFeeBps: this.config.protocolFeeBps,
        closeFeeBps: this.config.closeFeeBps,
      };
      this.cachedProtocolFees = fallback;
      this.cachedProtocolFeesFetchedAt = nowMs - FEES_CACHE_TTL_MS + 5_000;
      return fallback;
    }
  }

  async getMakerOnChainState(maker: Hex): Promise<MakerOnChainState | null> {
    if (!this.isConfigured()) return null;
    try {
      if (this.config.lensAddress && this.config.lensAddress !== ZERO_ADDR) {
        const [whitelisted, marginUnits, epoch] =
          await this.publicClient.readContract({
            address: this.config.lensAddress,
            abi: PAYOFF_LENS_ABI,
            functionName: "getMakerOverview",
            args: [this.config.vaultAddress, maker],
          });
        return {
          whitelisted: Boolean(whitelisted),
          marginUnits,
          epoch: BigInt(epoch),
        };
      }
      const [whitelisted, marginUnits, epoch] = await Promise.all([
        this.publicClient.readContract({
          address: this.config.vaultAddress,
          abi: PAYOFF_VAULT_ABI,
          functionName: "whitelistedMakers",
          args: [maker],
        }),
        this.publicClient.readContract({
          address: this.config.vaultAddress,
          abi: PAYOFF_VAULT_ABI,
          functionName: "makerMargin",
          args: [maker],
        }),
        this.publicClient.readContract({
          address: this.config.vaultAddress,
          abi: PAYOFF_VAULT_ABI,
          functionName: "makerEpoch",
          args: [maker],
        }),
      ]);
      return {
        whitelisted: Boolean(whitelisted),
        marginUnits,
        epoch: BigInt(epoch),
      };
    } catch {
      return null;
    }
  }

  async getUserActivePositionsOnChain(
    address: Hex
  ): Promise<OnChainActivePosition[] | null> {
    if (!this.isConfigured()) return null;
    try {
      const out: OnChainActivePosition[] = [];
      if (this.config.lensAddress && this.config.lensAddress !== ZERO_ADDR) {
        const pageSize = 50n;
        let offset = 0n;
        let total = 1n;

        while (offset < total) {
          const [items, totalCount] = await this.publicClient.readContract({
            address: this.config.lensAddress,
            abi: PAYOFF_LENS_ABI,
            functionName: "getUserActivePositions",
            args: [this.config.vaultAddress, address, offset, pageSize],
          });
          total = totalCount;
          for (const item of items) {
            const underlying = tryAssetIdToSymbol(item.assetId);
            if (!underlying) continue;
            out.push({
              tokenId: item.tokenId.toString(),
              seriesId: item.seriesId,
              assetId: item.assetId,
              underlying,
              direction: item.isUp ? "BULL" : "BEAR",
              isUp: item.isUp,
              lowerStrike: unitsToPrice(item.lowerStrike),
              upperStrike: unitsToPrice(item.upperStrike),
              expiry: Number(item.expiry),
              balanceUsdt: unitsToUsdt(item.balance),
              settled: item.settled,
              settlementPrice: unitsToPrice(item.settlementPrice),
              claimableUsdt: unitsToUsdt(item.claimableUsdt),
            });
          }
          if (items.length === 0) break;
          offset += BigInt(items.length);
        }

        return out;
      }

      const total = await this.publicClient.readContract({
        address: this.config.vaultAddress,
        abi: PAYOFF_VAULT_ABI,
        functionName: "getUserActiveTokenCount",
        args: [address],
      });
      const oracleAddr = await this.getSettlementOracleContract();
      for (let i = 0n; i < total; i++) {
        const tokenId = await this.publicClient.readContract({
          address: this.config.vaultAddress,
          abi: PAYOFF_VAULT_ABI,
          functionName: "getUserActiveTokenAt",
          args: [address, i],
        });
        const sid = await this.publicClient.readContract({
          address: this.config.vaultAddress,
          abi: PAYOFF_VAULT_ABI,
          functionName: "getSeriesIdByToken",
          args: [tokenId],
        });
        const isUp = (tokenId & 1n) === 0n;
        const [series, bal] = await Promise.all([
          this.publicClient.readContract({
            address: this.config.vaultAddress,
            abi: PAYOFF_VAULT_ABI,
            functionName: "seriesById",
            args: [sid],
          }),
          this.publicClient.readContract({
            address: this.config.vaultAddress,
            abi: PAYOFF_VAULT_ABI,
            functionName: "balanceOf",
            args: [address, tokenId],
          }),
        ]);
        const [assetId, lowerStrike, upperStrike, expiry] = series;
        const underlying = tryAssetIdToSymbol(assetId);
        if (!underlying) continue;
        let settlementPrice = 0n;
        let settled = false;
        if (oracleAddr !== ZERO_ADDR) {
          [settlementPrice, settled] = await this.publicClient.readContract({
            address: oracleAddr,
            abi: ATLAS_SETTLEMENT_ORACLE_ABI,
            functionName: "getSettlementPrice",
            args: [assetId, expiry],
          });
        }
        let claimable = 0n;
        if (settled && bal > 0n) {
          const [upPay, downPay] = await this.publicClient.readContract({
            address: this.config.vaultAddress,
            abi: PAYOFF_VAULT_ABI,
            functionName: "previewPayout",
            args: [sid, isUp ? bal : 0n, isUp ? 0n : bal],
          });
          claimable = isUp ? upPay : downPay;
        }
        out.push({
          tokenId: tokenId.toString(),
          seriesId: sid,
          assetId,
          underlying,
          direction: isUp ? "BULL" : "BEAR",
          isUp,
          lowerStrike: unitsToPrice(lowerStrike),
          upperStrike: unitsToPrice(upperStrike),
          expiry: Number(expiry),
          balanceUsdt: unitsToUsdt(bal),
          settled,
          settlementPrice: unitsToPrice(settlementPrice),
          claimableUsdt: unitsToUsdt(claimable),
        });
      }

      return out;
    } catch {
      return null;
    }
  }

  async getAllSeriesOnChain(): Promise<OnChainSeriesSummary[] | null> {
    if (!this.isConfigured()) return null;
    try {
      const out: OnChainSeriesSummary[] = [];
      if (this.config.lensAddress && this.config.lensAddress !== ZERO_ADDR) {
        const pageSize = 100n;
        let offset = 0n;
        let total = 1n;

        while (offset < total) {
          const [items, totalCount] = await this.publicClient.readContract({
            address: this.config.lensAddress,
            abi: PAYOFF_LENS_ABI,
            functionName: "getAllSeries",
            args: [this.config.vaultAddress, offset, pageSize],
          });
          total = totalCount;
          for (const s of items) {
            const underlying = tryAssetIdToSymbol(s.assetId);
            if (!underlying) continue;
            out.push({
              seriesId: s.seriesId,
              assetId: s.assetId,
              underlying,
              lowerStrike: unitsToPrice(s.lowerStrike),
              upperStrike: unitsToPrice(s.upperStrike),
              expiry: Number(s.expiry),
            });
          }
          if (items.length === 0) break;
          offset += BigInt(items.length);
        }

        return out;
      }

      const total = await this.publicClient.readContract({
        address: this.config.vaultAddress,
        abi: PAYOFF_VAULT_ABI,
        functionName: "getAllSeriesCount",
      });
      for (let i = 0n; i < total; i++) {
        const sid = await this.publicClient.readContract({
          address: this.config.vaultAddress,
          abi: PAYOFF_VAULT_ABI,
          functionName: "getSeriesIdAt",
          args: [i],
        });
        const [assetId, lowerStrike, upperStrike, expiry] =
          await this.publicClient.readContract({
            address: this.config.vaultAddress,
            abi: PAYOFF_VAULT_ABI,
            functionName: "seriesById",
            args: [sid],
          });
        const underlying = tryAssetIdToSymbol(assetId);
        if (!underlying) continue;
        out.push({
          seriesId: sid,
          assetId,
          underlying,
          lowerStrike: unitsToPrice(lowerStrike),
          upperStrike: unitsToPrice(upperStrike),
          expiry: Number(expiry),
        });
      }

      return out;
    } catch {
      return null;
    }
  }

  async ingestTransaction(
    txHash: Hex
  ): Promise<{ processedEvents: number; blockNumber: number }> {
    if (!this.isConfigured()) {
      return { processedEvents: 0, blockNumber: 0 };
    }

    const receipt = await this.publicClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: 30_000,
    });
    if (receipt.status === "reverted") {
      throw new Error(`On-chain transaction reverted: ${txHash}`);
    }

    const oracleContract = await this.getSettlementOracleContract();
    const vaultAddrLower = this.config.vaultAddress.toLowerCase();
    const oracleAddrLower = oracleContract.toLowerCase();

    const vaultRawLogs = receipt.logs.filter(
      (l) => l.address.toLowerCase() === vaultAddrLower
    );
    const oracleRawLogs =
      oracleAddrLower !== ZERO_ADDR
        ? receipt.logs.filter(
            (l) => l.address.toLowerCase() === oracleAddrLower
          )
        : [];

    const vaultDecoded = parseEventLogs({
      abi: PAYOFF_VAULT_ABI,
      logs: vaultRawLogs,
      strict: false,
    });
    const oracleDecoded = parseEventLogs({
      abi: ATLAS_SETTLEMENT_ORACLE_ABI,
      logs: oracleRawLogs,
      strict: false,
    });

    const block = await this.publicClient.getBlock({
      blockNumber: receipt.blockNumber,
    });
    const ts = Number(block.timestamp);

    let processedEvents = 0;
    for (const log of vaultDecoded) {
      const applied = await this.processVaultLog(log, async () => ts);
      if (applied) processedEvents += 1;
    }
    for (const log of oracleDecoded) {
      const applied = await this.processOracleLog(log, async () => ts);
      if (applied) processedEvents += 1;
    }

    return {
      processedEvents,
      blockNumber: Number(receipt.blockNumber),
    };
  }

  private async processOracleLog(
    log: any,
    getTs: (bn: bigint) => Promise<number>
  ): Promise<boolean> {
    const txHash = log.transactionHash as Hex | undefined;
    const logIndex = Number(log.logIndex ?? 0);
    if (txHash && (await this.db.hasProcessedLog(txHash, logIndex))) {
      return false;
    }
    if (log.eventName !== "ExpirySettled") return false;

    const ts = await getTs(log.blockNumber);
    const args = log.args as {
      assetId: Hex;
      expiry: bigint;
      settlementPrice: bigint;
      submitter: Hex;
      feedId: Hex;
      oracleTimestamp: bigint;
    };
    const underlying = tryAssetIdToSymbol(args.assetId);
    if (!underlying) return false;

    const expiry = Number(args.expiry);
    const metaKey = `${underlying}-${expiry}`;
    const meta = this.pendingSettlementMeta.get(metaKey);
    this.pendingSettlementMeta.delete(metaKey);

    const feedIdHex = args.feedId || meta?.feedIdHex || ATLAS_FEEDS[underlying].feedIdHex;
    const feedId =
      meta?.feedId ??
      decodeFeedIdHexToDecimal(feedIdHex) ??
      ATLAS_FEEDS[underlying].feedId;

    await this.db.recordSettlement({
      underlying,
      expiry,
      settlementPrice: unitsToPrice(args.settlementPrice),
      txHash: txHash ?? "0x",
      settledAt: ts,
      source: meta?.source ?? "ONCHAIN_SYNCED",
      feedId,
      feedIdHex,
      oracleTimestamp: Number(args.oracleTimestamp ?? meta?.oracleTimestamp ?? expiry),
      submitter: args.submitter ?? meta?.submitter ?? null,
    });

    if (txHash) {
      await this.db.markLogProcessed(txHash, logIndex);
    }
    return true;
  }

  private async processVaultLog(
    log: any,
    getTs: (bn: bigint) => Promise<number>
  ): Promise<boolean> {
    const txHash = log.transactionHash as Hex | undefined;
    const logIndex = Number(log.logIndex ?? 0);
    if (txHash && (await this.db.hasProcessedLog(txHash, logIndex))) {
      return false;
    }
    const ts = await getTs(log.blockNumber);

    if (log.eventName === "TicketOpened") {
      const args = log.args as {
        seriesId: Hex;
        taker: Hex;
        maker: Hex;
        assetId: Hex;
        isUp: boolean;
        lowerStrike: bigint;
        upperStrike: bigint;
        expiry: bigint;
        userPayAmount: bigint;
        protocolFee: bigint;
        maxPayout: bigint;
        nonce: bigint;
      };
      const underlying = tryAssetIdToSymbol(args.assetId);
      if (!underlying) return false;

      const direction: Direction = args.isUp ? "BULL" : "BEAR";
      const lowerStrike = unitsToPrice(args.lowerStrike);
      const upperStrike = unitsToPrice(args.upperStrike);
      const stakeUsdt = unitsToUsdt(args.userPayAmount);
      const protocolFeeUsdt = unitsToUsdt(args.protocolFee);
      const maxPayout = unitsToUsdt(args.maxPayout);

      const storedQuote = await this.db.findQuoteByMakerNonce(
        args.maker,
        args.nonce.toString()
      );
      if (storedQuote) {
        await this.db.markQuoteFilled(storedQuote.quoteId);
      }

      const makerCfg = this.config.makers.find(
        (m) => m.address.toLowerCase() === args.maker.toLowerCase()
      );
      const makerName =
        storedQuote?.makerName || makerCfg?.name || "Whitelisted MM";

      await this.db.upsertTicketOnOpen({
        seriesId: args.seriesId,
        isUp: args.isUp ? 1 : 0,
        taker: args.taker,
        maker: args.maker,
        tierKind: storedQuote?.tierKind ?? "CUSTOM",
        underlying,
        direction,
        lowerStrike,
        upperStrike,
        expiry: Number(args.expiry),
        maxPayout,
        stakeUsdt,
        protocolFeeUsdt,
        openTxHash: txHash ?? "0x",
        timestamp: ts,
      });

      let hedgePlan: Partial<HedgeEvaluation> = {};
      if (storedQuote?.hedgePlanJson) {
        try {
          hedgePlan = JSON.parse(storedQuote.hedgePlanJson);
        } catch {
          hedgePlan = {};
        }
      }

      const rawCost =
        hedgePlan.rawSpreadUsd ?? (stakeUsdt - protocolFeeUsdt) * 0.96;
      const exchFee = hedgePlan.exchangeFeeUsd ?? 0;
      const totalHedge = hedgePlan.totalHedgeCostUsd ?? rawCost + exchFee;
      const mmNetMarginUsd = stakeUsdt - protocolFeeUsdt - totalHedge;

      await this.db.insertHedgeLedger({
        txHash: txHash ?? "0x",
        action: "OPEN",
        seriesId: args.seriesId,
        underlying,
        direction,
        lowerStrike,
        upperStrike,
        makerName,
        venue: hedgePlan.venue ?? makerCfg?.preferredVenue ?? "MOCK_MAKER",
        hedgeRoute:
          hedgePlan.route ??
          (args.isUp ? "DIRECT_CALL_SPREAD" : "DIRECT_PUT_SPREAD"),
        isParityFlip: Boolean(hedgePlan.isParityFlip),
        longLegInstId: hedgePlan.longLegInstId ?? `${underlying}-${lowerStrike}`,
        shortLegInstId:
          hedgePlan.shortLegInstId ?? `${underlying}-${upperStrike}`,
        notionalUnderlying:
          hedgePlan.notionalUnderlying ??
          maxPayout / Math.max(1, upperStrike - lowerStrike),
        rawExchangeCostUsd: Number(rawCost.toFixed(4)),
        exchangeFeeUsd: Number(exchFee.toFixed(4)),
        paritySavedUsd: Number((hedgePlan.paritySavedUsd ?? 0).toFixed(4)),
        userCashflowUsd: -stakeUsdt,
        protocolFeeUsd: protocolFeeUsdt,
        mmNetMarginUsd: Number(mmNetMarginUsd.toFixed(4)),
        capitalUnlockedUsdt: 0,
        executionMode: "RFQ_OPEN_LOCKED",
        createdAt: ts,
      });
    } else if (log.eventName === "TicketClosedEarly") {
      const args = log.args as {
        seriesId: Hex;
        taker: Hex;
        maker: Hex;
        isUp: boolean;
        amount: bigint;
        buybackAmount: bigint;
        closeFee: bigint;
        mergedAmount: bigint;
        transferredAmount: bigint;
        nonce: bigint;
      };

      const closedAmount = unitsToUsdt(args.amount);
      const buybackGross = unitsToUsdt(args.buybackAmount);
      const closeFee = unitsToUsdt(args.closeFee);
      const buybackNet = buybackGross - closeFee;
      const mergedUsdt = unitsToUsdt(args.mergedAmount);
      const transferredUsdt = unitsToUsdt(args.transferredAmount);

      await this.db.updateTicketOnClose({
        seriesId: args.seriesId,
        isUp: args.isUp ? 1 : 0,
        taker: args.taker,
        closedAmount,
        buybackNetUsdt: buybackNet,
        timestamp: ts,
      });

      const storedQuote = await this.db.findQuoteByMakerNonce(
        args.maker,
        args.nonce.toString()
      );
      if (storedQuote) {
        await this.db.markQuoteFilled(storedQuote.quoteId);
      }

      const makerCfg = this.config.makers.find(
        (m) => m.address.toLowerCase() === args.maker.toLowerCase()
      );
      const makerName =
        storedQuote?.makerName || makerCfg?.name || "Whitelisted MM";

      let hedgePlan: Partial<HedgeEvaluation> = {};
      if (storedQuote?.hedgePlanJson) {
        try {
          hedgePlan = JSON.parse(storedQuote.hedgePlanJson);
        } catch {
          hedgePlan = {};
        }
      }

      const executionMode =
        mergedUsdt > 0 && transferredUsdt === 0
          ? "ATOMIC_MERGE_UNLOCK"
          : mergedUsdt === 0
            ? "EXTERNAL_TAKEOVER"
            : "HYBRID";

      const hedgeUnwindUsd =
        hedgePlan.totalHedgeCostUsd ?? buybackGross * 1.008;
      const exchFee = hedgePlan.exchangeFeeUsd ?? 0;
      const mmNetMarginUsd = Math.max(0, hedgeUnwindUsd - buybackGross);

      let seriesMeta = storedQuote
        ? {
            underlying: storedQuote.underlying,
            lowerStrike: storedQuote.lowerStrike,
            upperStrike: storedQuote.upperStrike,
          }
        : await this.db.getSeriesTicketMeta(args.seriesId);
      if (!seriesMeta) {
        try {
          const [assetId, lowerStrike8, upperStrike8] =
            await this.publicClient.readContract({
              address: this.config.vaultAddress,
              abi: PAYOFF_VAULT_ABI,
              functionName: "seriesById",
              args: [args.seriesId],
            });
          const sym = tryAssetIdToSymbol(assetId);
          if (sym) {
            seriesMeta = {
              underlying: sym,
              lowerStrike: unitsToPrice(lowerStrike8),
              upperStrike: unitsToPrice(upperStrike8),
            };
          }
        } catch {
          // RPC unavailable
        }
      }

      await this.db.insertHedgeLedger({
        txHash: txHash ?? "0x",
        action: "CLOSE",
        seriesId: args.seriesId,
        underlying: seriesMeta?.underlying ?? "BTC",
        direction: storedQuote?.direction ?? (args.isUp ? "BULL" : "BEAR"),
        lowerStrike: seriesMeta?.lowerStrike ?? 0,
        upperStrike: seriesMeta?.upperStrike ?? 0,
        makerName,
        venue: hedgePlan.venue ?? makerCfg?.preferredVenue ?? "MOCK_MAKER",
        hedgeRoute:
          hedgePlan.route ??
          (args.isUp ? "DIRECT_CALL_SPREAD" : "DIRECT_PUT_SPREAD"),
        isParityFlip: Boolean(hedgePlan.isParityFlip),
        longLegInstId: hedgePlan.longLegInstId ?? "",
        shortLegInstId: hedgePlan.shortLegInstId ?? "",
        notionalUnderlying: hedgePlan.notionalUnderlying ?? 0,
        rawExchangeCostUsd: Number(
          (hedgePlan.rawSpreadUsd ?? hedgeUnwindUsd).toFixed(4)
        ),
        exchangeFeeUsd: Number(exchFee.toFixed(4)),
        paritySavedUsd: Number((hedgePlan.paritySavedUsd ?? 0).toFixed(4)),
        userCashflowUsd: buybackNet,
        protocolFeeUsd: closeFee,
        mmNetMarginUsd: Number(mmNetMarginUsd.toFixed(4)),
        capitalUnlockedUsdt: Number(mergedUsdt.toFixed(2)),
        executionMode,
        createdAt: ts,
      });
    } else if (log.eventName === "PositionMerged") {
      const args = log.args as {
        seriesId: Hex;
        account: Hex;
        amount: bigint;
        creditedToMargin: boolean;
      };
      await this.db.updateTicketOnMerge({
        seriesId: args.seriesId,
        account: args.account,
        mergedAmount: unitsToUsdt(args.amount),
        timestamp: ts,
      });
    } else if (log.eventName === "ProtocolFeesUpdated") {
      const args = log.args as {
        openFeeBps: number | bigint;
        closeFeeBps: number | bigint;
      };
      this.cachedProtocolFees = {
        openFeeBps: Number(args.openFeeBps),
        closeFeeBps: Number(args.closeFeeBps),
      };
      this.cachedProtocolFeesFetchedAt = Date.now();
    } else if (log.eventName === "SettlementOracleUpdated") {
      const args = log.args as { newOracle: Hex };
      if (args.newOracle && args.newOracle !== ZERO_ADDR) {
        this.resolvedOracleAddress = args.newOracle;
        this.resolvedOracleFetchedAt = Date.now();
      }
    } else if (log.eventName === "TicketRedeemed") {
      const args = log.args as {
        seriesId: Hex;
        account: Hex;
        upBurned: bigint;
        downBurned: bigint;
        upPayoutUsdt: bigint;
        downPayoutUsdt: bigint;
        creditedToMargin: boolean;
      };
      if (args.upBurned > 0n) {
        await this.db.updateTicketOnRedeem({
          seriesId: args.seriesId,
          isUp: 1,
          account: args.account,
          burnedAmount: unitsToUsdt(args.upBurned),
          payoutUsdt: unitsToUsdt(args.upPayoutUsdt),
          timestamp: ts,
        });
      }
      if (args.downBurned > 0n) {
        await this.db.updateTicketOnRedeem({
          seriesId: args.seriesId,
          isUp: 0,
          account: args.account,
          burnedAmount: unitsToUsdt(args.downBurned),
          payoutUsdt: unitsToUsdt(args.downPayoutUsdt),
          timestamp: ts,
        });
      }
    } else {
      return false;
    }

    if (txHash) {
      await this.db.markLogProcessed(txHash, logIndex);
    }
    return true;
  }

  async syncEvents(): Promise<void> {
    if (!this.isConfigured()) return;
    if (this.syncPromise) return this.syncPromise;
    this.syncPromise = this._doSyncEvents().finally(() => {
      this.syncPromise = null;
    });
    return this.syncPromise;
  }

  private async fetchRangeEvents(
    address: Hex,
    abi: any,
    start: bigint,
    end: bigint
  ): Promise<any[]> {
    try {
      return await this.logsClient.getContractEvents({
        address,
        abi,
        fromBlock: start,
        toBlock: end,
      });
    } catch (err) {
      // Resiliently split range in half if BSC Testnet public RPC rejects wide block spans
      const span = end - start;
      if (span >= 10n) {
        const mid = start + span / 2n;
        const left = await this.fetchRangeEvents(address, abi, start, mid);
        const right = await this.fetchRangeEvents(address, abi, mid + 1n, end);
        return [...left, ...right];
      }
      throw err;
    }
  }

  private async _doSyncEvents(): Promise<void> {
    try {
      const latestBlock = await this.logsClient.getBlockNumber();
      const oracleContract = await this.getSettlementOracleContract();
      const lastSyncedStr = await this.db.getSyncState("lastSyncedBlock");
      let fromBlock = lastSyncedStr
        ? BigInt(lastSyncedStr) + 1n
        : this.config.deploymentBlock > 0
          ? BigInt(this.config.deploymentBlock)
          : latestBlock > 100n
            ? latestBlock - 100n
            : 0n;
      if (fromBlock <= latestBlock) {
        const CHUNK = 200n;
        const WAVE_SIZE = 1;
        const MAX_CHUNKS_PER_TICK = 25;
        const ranges: Array<{ start: bigint; end: bigint }> = [];
        for (
          let start = fromBlock;
          start <= latestBlock && ranges.length < MAX_CHUNKS_PER_TICK;
          start += CHUNK
        ) {
          const end =
            start + CHUNK - 1n < latestBlock ? start + CHUNK - 1n : latestBlock;
          ranges.push({ start, end });
        }

        const blockTimestamps = new Map<bigint, number>();
        const getTs = async (bn: bigint): Promise<number> => {
          if (blockTimestamps.has(bn)) return blockTimestamps.get(bn)!;
          const b = await this.logsClient.getBlock({ blockNumber: bn });
          const ts = Number(b.timestamp);
          blockTimestamps.set(bn, ts);
          return ts;
        };

        for (let i = 0; i < ranges.length; i += WAVE_SIZE) {
          const wave = ranges.slice(i, i + WAVE_SIZE);
          const vaultBatches = await Promise.all(
            wave.map(({ start, end }) =>
              this.fetchRangeEvents(
                this.config.vaultAddress,
                PAYOFF_VAULT_ABI,
                start,
                end
              )
            )
          );
          const oracleBatches =
            oracleContract !== ZERO_ADDR
              ? await Promise.all(
                  wave.map(({ start, end }) =>
                    this.fetchRangeEvents(
                      oracleContract,
                      ATLAS_SETTLEMENT_ORACLE_ABI,
                      start,
                      end
                    )
                  )
                )
              : [];

          const combined: Array<{ kind: "vault" | "oracle"; log: any }> = [
            ...vaultBatches.flat().map((log) => ({ kind: "vault" as const, log })),
            ...oracleBatches
              .flat()
              .map((log) => ({ kind: "oracle" as const, log })),
          ].sort((a, b) => {
            const bnDiff = Number(
              (a.log.blockNumber ?? 0n) - (b.log.blockNumber ?? 0n)
            );
            if (bnDiff !== 0) return bnDiff;
            return Number((a.log.logIndex ?? 0) - (b.log.logIndex ?? 0));
          });

          for (const item of combined) {
            if (item.kind === "vault") {
              await this.processVaultLog(item.log, getTs);
            } else {
              await this.processOracleLog(item.log, getTs);
            }
          }

          await this.db.setSyncState(
            "lastSyncedBlock",
            wave[wave.length - 1]!.end.toString()
          );
        }
      }

      // Belt-and-suspenders eth_call backfill for recent 08:00 UTC expiries
      await this.backfillRecentSettlements();
    } catch (err: any) {
      console.warn(
        "[ChainService] syncEvents error:",
        err?.shortMessage || err?.details || err?.message || err
      );
    }
  }

  /**
   * Backfills recent past 08:00 UTC expiries via `eth_call` (`getSettlement` + `getSettlementMeta`)
   * so `/api/market/settlement-history` stays resilient even if an RPC throttles `eth_getLogs`.
   * Never overwrites an existing DB record that already carries a real on-chain `0x...` txHash.
   */
  async backfillRecentSettlements(
    underlying?: UnderlyingSymbol,
    days = 7,
    force = false
  ): Promise<number> {
    if (!this.isConfigured()) return 0;
    const throttleKey = underlying ?? "ALL";
    const nowMs = Date.now();
    if (
      !force &&
      nowMs - (this.lastBackfillAt.get(throttleKey) ?? 0) < 30_000
    ) {
      return 0;
    }
    this.lastBackfillAt.set(throttleKey, nowMs);

    const effNow = await this.getEffectiveNow();
    const daySec = 86400;
    const offset = SETTLEMENT_UTC_HOUR * 3600;
    const latestDayIdx = Math.floor((effNow - offset) / daySec);
    const expiries: number[] = [];
    for (let i = 0; i < days; i++) {
      const exp = (latestDayIdx - i) * daySec + offset;
      if (exp > 0 && exp <= effNow) {
        expiries.push(exp);
      }
    }

    const targets: UnderlyingSymbol[] = underlying
      ? [underlying]
      : ["BTC", "ETH"];
    let backfilled = 0;

    for (const sym of targets) {
      for (const expiry of expiries) {
        const existing = await this.db.getSettlement(sym, expiry);
        if (existing && /^0x[0-9a-fA-F]{64}$/.test(existing.txHash)) {
          continue;
        }
        const onChain = await this.readOnChainSettlement(sym, expiry);
        if (onChain?.settled && onChain.settlementPrice > 0) {
          const feedIdHex =
            onChain.feedIdHex ?? ATLAS_FEEDS[sym].feedIdHex;
          await this.db.recordSettlement({
            underlying: sym,
            expiry,
            settlementPrice: onChain.settlementPrice,
            txHash: existing?.txHash || "onchain-verified",
            settledAt: onChain.settledAt || effNow,
            source: existing?.source || "ONCHAIN_SYNCED",
            feedId:
              decodeFeedIdHexToDecimal(feedIdHex) ?? ATLAS_FEEDS[sym].feedId,
            feedIdHex,
            oracleTimestamp: onChain.oracleTimestamp ?? expiry,
            submitter: onChain.submitter,
          });
          backfilled += 1;
        }
      }
    }

    return backfilled;
  }

  /**
   * Reads on-chain settlement status + Atlas proof metadata from `AtlasPullSettlementOracle`.
   */
  async readOnChainSettlement(
    underlying: UnderlyingSymbol,
    expiry: number
  ): Promise<{
    settlementPrice: number;
    settledAt: number;
    settled: boolean;
    feedIdHex: Hex | null;
    oracleTimestamp: number | null;
    submitter: Hex | null;
  } | null> {
    if (!this.isConfigured()) return null;
    try {
      const oracleContract = await this.getSettlementOracleContract();
      if (oracleContract === ZERO_ADDR) return null;
      const assetId = symbolToAssetId(underlying);
      const data = await this.publicClient.readContract({
        address: oracleContract,
        abi: ATLAS_SETTLEMENT_ORACLE_ABI,
        functionName: "getSettlement",
        args: [assetId, BigInt(expiry)],
      });
      if (!data.settled) {
        return {
          settlementPrice: 0,
          settledAt: 0,
          settled: false,
          feedIdHex: null,
          oracleTimestamp: null,
          submitter: null,
        };
      }
      let feedIdHex: Hex | null = null;
      let oracleTimestamp: number | null = null;
      let submitter: Hex | null = null;
      try {
        const [fId, oTs, sub] = await this.publicClient.readContract({
          address: oracleContract,
          abi: ATLAS_SETTLEMENT_ORACLE_ABI,
          functionName: "getSettlementMeta",
          args: [assetId, BigInt(expiry)],
        });
        feedIdHex = fId;
        oracleTimestamp = Number(oTs);
        submitter = sub;
      } catch {
        // optional metadata view fallback
      }
      return {
        settlementPrice: unitsToPrice(data.price),
        settledAt: Number(data.settledAt),
        settled: data.settled,
        feedIdHex,
        oracleTimestamp,
        submitter,
      };
    } catch {
      return null;
    }
  }

  /**
   * Atlas Permissionless Settlement Keeper:
   * 1. Finds expired unsettled `(underlying, expiry)` pairs from DB + PayoffVaultLens.
   * 2. Enforces Atlas Enterprise ConsensusScore Circuit Breaker (`getConsensusGuard`).
   * 3. Fetches & cryptographically pre-verifies expiry-pinned signed Atlas Pull proof.
   * 4. Encodes `settleWithAtlasProof(assetId, expiry)` + trailing `extraData` bytes and
   *    submits transaction to `AtlasPullSettlementOracle`.
   */
  async runSettlementKeeper(): Promise<SettlementKeeperResult[]> {
    if (!this.isConfigured()) return [];
    if (this.keeperPromise) return this.keeperPromise;
    this.keeperPromise = this._doRunSettlementKeeper().finally(() => {
      this.keeperPromise = null;
    });
    return this.keeperPromise;
  }

  private async _doRunSettlementKeeper(): Promise<SettlementKeeperResult[]> {
    const results: SettlementKeeperResult[] = [];

    try {
      const effNow = await this.getEffectiveNow();
      const [dbTickets, onChainSeries] = await Promise.all([
        this.db.getAllTickets(),
        this.getAllSeriesOnChain(),
      ]);

      const candidates: Array<{ underlying: UnderlyingSymbol; expiry: number }> =
        [];
      for (const t of dbTickets) {
        if (t.status === "ACTIVE" && t.expiry <= effNow) {
          candidates.push({ underlying: t.underlying, expiry: t.expiry });
        }
      }
      if (onChainSeries) {
        for (const s of onChainSeries) {
          if (s.expiry <= effNow) {
            candidates.push({ underlying: s.underlying, expiry: s.expiry });
          }
        }
      }

      const checkedPairs = new Set<string>();
      for (const c of candidates) {
        const pairKey = `${c.underlying}-${c.expiry}`;
        if (checkedPairs.has(pairKey)) continue;
        checkedPairs.add(pairKey);

        if (await this.db.getSettlement(c.underlying, c.expiry)) continue;

        const onChain = await this.readOnChainSettlement(
          c.underlying,
          c.expiry
        );
        if (onChain?.settled && onChain.settlementPrice > 0) {
          const feedIdHex =
            onChain.feedIdHex ?? ATLAS_FEEDS[c.underlying].feedIdHex;
          await this.db.recordSettlement({
            underlying: c.underlying,
            expiry: c.expiry,
            settlementPrice: onChain.settlementPrice,
            txHash: "onchain-backfill",
            settledAt: onChain.settledAt || effNow,
            source: "ONCHAIN_SYNCED",
            feedId:
              decodeFeedIdHexToDecimal(feedIdHex) ??
              ATLAS_FEEDS[c.underlying].feedId,
            feedIdHex,
            oracleTimestamp: onChain.oracleTimestamp ?? c.expiry,
            submitter: onChain.submitter,
          });
          results.push({
            underlying: c.underlying,
            expiry: c.expiry,
            priceUsd: onChain.settlementPrice,
            txHash: "ALREADY_SETTLED_ONCHAIN",
            source: "ONCHAIN_SYNCED",
            feedId:
              decodeFeedIdHexToDecimal(feedIdHex) ??
              ATLAS_FEEDS[c.underlying].feedId,
            feedIdHex,
            oracleTimestamp: onChain.oracleTimestamp ?? c.expiry,
          });
          continue;
        }

        // Enforce Atlas Enterprise ConsensusScore Settlement Circuit Breaker
        const guard = this.atlasOracle.getConsensusGuard(c.underlying);
        if (!guard.settlementSafe) {
          const lastLog = this.lastBreakerLogAt.get(pairKey) ?? 0;
          if (Date.now() - lastLog > 60_000) {
            this.lastBreakerLogAt.set(pairKey, Date.now());
            console.warn(
              `[SettlementKeeper] Circuit breaker paused settlement for ${c.underlying} expiry=${c.expiry}: ${guard.reason}`
            );
          }
          continue;
        }

        let proof: AtlasSignedProofResult | null = null;
        try {
          proof = await this.atlasOracle.fetchSignedExpiryProof(
            c.underlying,
            c.expiry,
            { nowSec: effNow }
          );
        } catch (err: any) {
          console.warn(
            `[SettlementKeeper] Atlas proof validation failed for ${c.underlying} expiry=${c.expiry}:`,
            err?.message || err
          );
          continue;
        }

        if (!proof || !(proof.priceUsd > 0)) {
          const lastLog = this.lastWaitingLogAt.get(pairKey) ?? 0;
          if (Date.now() - lastLog > 60_000) {
            this.lastWaitingLogAt.set(pairKey, Date.now());
            console.info(
              `[SettlementKeeper] Waiting for signed Atlas historical proof for ${c.underlying} expiry=${c.expiry} (${new Date(c.expiry * 1000).toISOString()})`
            );
          }
          continue;
        }

        try {
          const txHash = await this.submitAtlasSettlementProofOnChain(
            c.underlying,
            c.expiry,
            proof
          );
          this.lastWaitingLogAt.delete(pairKey);
          console.info(
            `[SettlementKeeper] Settled ${c.underlying} expiry=${c.expiry} via AtlasPullSettlementOracle at $${proof.priceUsd} (feed=#${proof.feedId}, oracleTs=${proof.timestampSeconds}, source=${proof.source}) tx=${txHash}`
          );
          results.push({
            underlying: c.underlying,
            expiry: c.expiry,
            priceUsd: proof.priceUsd,
            txHash,
            source: proof.source,
            feedId: proof.feedId,
            feedIdHex: proof.feedIdHex,
            oracleTimestamp: proof.timestampSeconds,
          });
        } catch (err: any) {
          console.warn(
            `[SettlementKeeper] Failed to submit Atlas settlement proof for ${c.underlying} expiry=${c.expiry}:`,
            err?.shortMessage || err?.details || err?.message || err
          );
        }
      }
    } catch (err: any) {
      console.warn(
        "[SettlementKeeper] keeper cycle error:",
        err?.shortMessage || err?.details || err?.message || err
      );
    }

    return results;
  }

  /**
   * Encodes `settleWithAtlasProof(assetId, expiry)` and appends signed Atlas
   * `extraData` bytes directly onto trailing calldata before sending the transaction.
   */
  encodeSettleWithAtlasProofData(
    underlying: UnderlyingSymbol,
    expiry: number,
    extraData: Hex
  ): Hex {
    const calldata = encodeFunctionData({
      abi: ATLAS_SETTLEMENT_ORACLE_ABI,
      functionName: "settleWithAtlasProof",
      args: [symbolToAssetId(underlying), BigInt(expiry)],
    });
    const suffix = extraData.startsWith("0x") ? extraData.slice(2) : extraData;
    return `${calldata}${suffix}` as Hex;
  }

  async submitAtlasSettlementProofOnChain(
    underlying: UnderlyingSymbol,
    expiry: number,
    proof: Pick<
      AtlasSignedProofResult,
      "extraData" | "feedId" | "feedIdHex" | "timestampSeconds"
    > & { source: SettlementSource }
  ): Promise<Hex> {
    const oracleContract = await this.getSettlementOracleContract();
    if (oracleContract === ZERO_ADDR) {
      throw new Error("AtlasPullSettlementOracle contract address not configured");
    }

    const metaKey = `${underlying}-${expiry}`;
    this.pendingSettlementMeta.set(metaKey, {
      source: proof.source,
      feedId: proof.feedId,
      feedIdHex: proof.feedIdHex,
      oracleTimestamp: proof.timestampSeconds,
      submitter: this.oracleAccount.address,
    });

    const data = this.encodeSettleWithAtlasProofData(
      underlying,
      expiry,
      proof.extraData
    );

    const wallet = createWalletClient({
      account: this.oracleAccount,
      transport: http(this.config.rpcUrl),
    });
    const hash = await wallet.sendTransaction({
      to: oracleContract,
      data,
      chain: null,
    });
    await this.ingestTransaction(hash);
    return hash;
  }

  async mintFaucetLocal(targetAddress: Hex): Promise<Hex> {
    if (!this.config.isLocalDev) {
      throw new Error("Faucet endpoint is only available on local devnet");
    }
    const wallet = createWalletClient({
      account: this.oracleAccount,
      transport: http(this.config.rpcUrl),
    });

    const ethBal = await this.publicClient.getBalance({
      address: targetAddress,
    });
    if (ethBal < parseUnits("0.2", 18)) {
      await wallet.sendTransaction({
        to: targetAddress,
        value: parseUnits("1", 18),
        chain: null,
      });
    }

    const hash = await wallet.writeContract({
      address: this.config.usdtAddress,
      abi: MOCK_USDT_ABI,
      functionName: "mint",
      args: [targetAddress, parseUnits("1000", 6)],
      chain: null,
    });
    await this.publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }

  /**
   * Local Hardhat devnet only: advances EVM block timestamp past `expiry`,
   * signs a local Atlas Pull proof with the devnet signer, and calls `settleWithAtlasProof`.
   */
  async simulateExpiryAndSettleLocal(params: {
    underlying: UnderlyingSymbol;
    expiry: number;
    settlementPrice: number;
  }): Promise<{ txHash: Hex; newBlockTimestamp: number }> {
    if (!this.config.isLocalDev) {
      throw new Error(
        "Expiry time-travel simulation is only available on local devnet"
      );
    }
    const { underlying, expiry, settlementPrice } = params;
    const effNow = await this.getEffectiveNow();
    const targetTs = Math.max(effNow + 5, expiry + 60);

    await this.publicClient.request({
      method: "evm_setNextBlockTimestamp" as any,
      params: [targetTs] as any,
    });
    await this.publicClient.request({
      method: "evm_mine" as any,
      params: [] as any,
    });
    this.cachedEffectiveNow = Math.max(this.cachedEffectiveNow, targetTs);

    const feedCfg = ATLAS_FEEDS[underlying];
    const price18 = priceToUnits(settlementPrice) * 10n ** 10n;
    const built = await buildSignedAtlasProofWithKey({
      privateKey: this.config.oraclePrivateKey,
      packages: [
        {
          feedIdHex: feedCfg.feedIdHex,
          price18,
          timestampSeconds: expiry,
        },
      ],
    });

    const txHash = await this.submitAtlasSettlementProofOnChain(
      underlying,
      expiry,
      {
        extraData: built.extraData,
        feedId: feedCfg.feedId,
        feedIdHex: feedCfg.feedIdHex,
        timestampSeconds: expiry,
        source: "DEV_SIMULATED",
      }
    );
    return { txHash, newBlockTimestamp: targetTs };
  }
}

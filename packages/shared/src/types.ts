import type { UnderlyingSymbol } from "./chains.js";

export type Direction = "BULL" | "BEAR";
export type ExpiryTenor = "DAILY" | "WEEKLY";
export type TierKind = "CONSERVATIVE" | "STANDARD" | "BREAKOUT" | "CUSTOM";
export type VenueName = "MOCK_MAKER";
export type DataSourceStatus = "LIVE_ATLAS" | "SYNTHETIC_FALLBACK";
export type SettlementSource =
  | "ATLAS_TWAP_30M"
  | "ADMIN_EMERGENCY_SETTLED"
  | "ATLAS_PULL_HISTORY"
  | "ATLAS_PULL_LATEST"
  | "ONCHAIN_SYNCED"
  | "DEV_SIMULATED";

export interface TwapSampleObservation {
  underlying: UnderlyingSymbol;
  expiry: number;
  sampleTs: number;
  priceUsd: number;
  avgConsensusScore: number;
  minConsensusScore: number;
  consensusStatus: AtlasConsensusStatus;
  tickCount: number;
  observedAt: number;
}

export interface TwapWindowHealthSummary {
  underlying: UnderlyingSymbol;
  expiry: number;
  expiryIso: string;
  sampleCountTarget: number;
  observedMinutes: number;
  avgConsensusScore: number | null;
  minConsensusScore: number | null;
  indicativeTwapUsd: number | null;
  threshold: number;
  healthy: boolean;
  mathematicallyIrrecoverable: boolean;
  status: "HEALTHY" | "DISPUTED_LOW_HEALTH" | "INSUFFICIENT_DATA";
  onChainPaused: boolean;
  onChainSettled: boolean;
}

export type AtlasConsensusStatus =
  | "HEALTHY"
  | "DEGRADED"
  | "WARNING"
  | "CRITICAL"
  | "SPLIT_MARKET"
  | "UNKNOWN";

export interface AtlasFeedTelemetry {
  underlying: UnderlyingSymbol;
  feedId: string;
  feedIdHex: `0x${string}`;
  price: number;
  timestampSeconds: number;
  consensusScore: number | null;
  consensusStatus: AtlasConsensusStatus;
  twapPrice: number | null;
  medianPrice: number | null;
  priceChangePct: number | null;
  priceVolatility: number | null;
  updatedAtMs: number;
}

export type RwaMarketSession = "RTH" | "EXTENDED" | "WEEKEND";

export type RwaIvSource =
  | "THETADATA_LIVE"
  | "THETADATA_CACHED"
  | "SYNTHETIC_BASELINE";

export interface RwaAssetTelemetry {
  underlying: UnderlyingSymbol;
  session: RwaMarketSession;
  shareMultiplier: number;
  baselineShareMultiplier: number;
  multiplierDriftPct: number;
  crossVenueMultiplierGapPct: number;
  splitGuardTriggered: boolean;
  corporateActionBlackout: boolean;
  blackoutReason: string | null;
  perpSymbol: string;
  perpPriceUsd: number | null;
  spotPerpBasisBps: number | null;
  ivSource: RwaIvSource;
  thetaAtmIv: number | null;
  thetaExpiration: string | null;
  thetaStrikeCount: number;
  thetaUpdatedAtMs: number | null;
  settlementUtcHour: number;
  updatedAtMs: number;
}

export interface OfficialSettlementPrice {
  underlying: UnderlyingSymbol;
  feedId: string;
  feedIdHex: `0x${string}`;
  expiry: number; // unix seconds (asset settlement UTC hour, e.g. 08:00 or 21:00 UTC)
  expiryIso: string;
  priceUsd: number;
  oracleTimestamp: number; // unix seconds signed by Atlas
  submitter?: `0x${string}`;
  txHash?: `0x${string}`;
  source: SettlementSource;
}

export type CandleBar = "5m" | "15m" | "1H" | "4H" | "1D";

export interface CandlePoint {
  time: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
}

export type HedgeRoute =
  | "DIRECT_CALL_SPREAD"
  | "PARITY_PUT_SPREAD"
  | "DIRECT_PUT_SPREAD"
  | "PARITY_CALL_SPREAD";

export interface OptionLegQuote {
  strike: number;
  instId: string;
  bidUsd: number;
  askUsd: number;
  markUsd: number;
  iv: number;
  bidSize: number;
  askSize: number;
}

export interface OptionStrikeQuote {
  strike: number;
  call: OptionLegQuote;
  put: OptionLegQuote;
}

export interface ExpiryBook {
  underlying: UnderlyingSymbol;
  tenor: ExpiryTenor;
  expiry: number; // unix seconds (asset settlement UTC hour, e.g. 08:00 or 21:00 UTC)
  expiryIso: string;
  hoursToExpiry: number;
  spot: number;
  atmIv: number;
  availableStrikes: number[];
  syntheticStrikes: Record<number, OptionStrikeQuote>;
  rwaTelemetry?: RwaAssetTelemetry;
}

export interface MarketSnapshot {
  underlying: UnderlyingSymbol;
  spot: number;
  change24hPct: number;
  dataSource: DataSourceStatus;
  updatedAt: number;
  atlasTelemetry?: AtlasFeedTelemetry;
  rwaTelemetry?: RwaAssetTelemetry;
  daily?: ExpiryBook;
  weekly?: ExpiryBook;
}

export interface GuardrailResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  strikeAligned: boolean;
  widthWithinCap: boolean;
  widthPct: number;
  maxAllowedWidthPct: number;
  shortLegSubsidyRatio: number;
  lowMultiplierWarning: boolean;
  /** True when unclamped fair value & multiplier sit strictly inside fair OTM/ITM bounds (~1.15x–20x) */
  withinFairBounds?: boolean;
  /** Unclamped Black-Scholes fair value as a fraction of spread width in [0, 1] */
  rawFairRatio?: number;
}

/**
 * The 5 mandatory numbers (plus savings & perp comparison) shown on every ticket.
 * Strictly avoids option jargon on the retail surface.
 */
export interface TicketSummary {
  tierKind: TierKind;
  tierLabel: string;
  underlying: UnderlyingSymbol;
  direction: Direction;
  tenor: ExpiryTenor;
  expiry: number;
  expiryIso: string;
  hoursToExpiry: number;
  spot: number;
  /** Start price (for BULL: lowerStrike, for BEAR: upperStrike) */
  startPrice: number;
  /** Cap price (for BULL: upperStrike, for BEAR: lowerStrike) */
  capPrice: number;
  lowerStrike: number;
  upperStrike: number;
  /** 1. Ticket stake (also maximum possible loss) */
  stakeUsdt: number;
  /** 2. Breakeven price at expiry */
  breakevenPrice: number;
  breakevenPct: number;
  /** Payout if spot finishes unchanged (relevant for shallow ITM protection tier) */
  flatPayoutUsdt: number;
  flatReturnPct: number;
  /** 3. Full payout price & capped max payout */
  fullPayoutPrice: number;
  maxPayoutUsdt: number;
  maxMultiplier: number;
  /** 4. Expiry settlement label */
  settlementLabel: string;
  /** 5. Indicative early exit amount and mid-life reference */
  indicativeExitUsdt: number;
  midLifeReferenceUsdt: number;
  /** Ticket savings vs naked single-leg option */
  spreadSavingsPct: number;
  nakedSingleLegCostUsdt: number;
  /** Equivalent 50x perp liquidation benchmark */
  perp50xLiqPrice: number;
  /** Reference hedge evaluation (for ops / mock-maker analytics) */
  recommendedHedge?: HedgeEvaluation;
  guardrails: GuardrailResult;
  /** Identifies [gridLow, gridHigh] shared center pool */
  isSharedCenterPool?: boolean;
  /** Distance from start strike in grid steps (e.g. 1 / 2 / 4 / 6) */
  stepSteps?: number;
}

export interface FixedGridMeta {
  gridStep: number;
  hysteresisBuffer: number;
  gridLow: number;
  gridHigh: number;
  anchorStartPrice: number;
  defaultIndex: number;
  /** Default selected index within fine-grained `quickTiers` */
  defaultQuickIndex?: number;
}

export interface CustomRangePricingParams {
  spot: number;
  hoursToExpiry: number;
  baseIv: number;
  effectiveIv: number;
  /** Optional additive IV floor boost from Atlas/RWA risk adjustments */
  ivFloorBoost?: number;
  /** Optional per-strike symmetric IV map (keyed by String(strike)) when skew is non-flat */
  strikeIvs?: Record<string, number>;
  varianceTimeScale: number;
  spreadMultiplier: number;
  protocolFeeBps: number;
  mmOpenMarkupBps: number;
}

export interface CustomRangeConfig {
  /** Valid Start strikes ordered from conservative (ITM) -> ATM -> aggressive (OTM) */
  validStarts: number[];
  /** Valid Target cap strikes per Start strike (keyed by String(start)), ordered closest-to-start -> furthest-from-start */
  validCapsByStart: Record<string, number[]>;
  /** Default Start strike for Custom mode (matches Quick anchorStartPrice when valid) */
  defaultStart: number;
  /** Default Target cap strike for Custom mode */
  defaultCap: number;
  /** Tenor-dependent max spread width (% of spot) */
  maxAllowedWidthPct: number;
  /** Selectable Custom multiplier lower bound (ITM fair floor) */
  minMultiplier: number;
  /** Selectable Custom multiplier upper bound (OTM fair ceiling) */
  maxMultiplier: number;
  /** Exact server pricing inputs for zero-latency client preview while dragging */
  pricingParams: CustomRangePricingParams;
}

export type CustomClampReason =
  | "NONE"
  | "ORDERING"
  | "WIDTH_CAP"
  | "OTM_FAIR_LIMIT"
  | "ITM_FAIR_LIMIT"
  | "STRIKE_ALIGN";

export interface ClampedCustomSelection {
  startPrice: number;
  capPrice: number;
  lowerStrike: number;
  upperStrike: number;
  validCaps: number[];
  startClamped: boolean;
  capClamped: boolean;
  clampReason: CustomClampReason;
}

export interface HedgeEvaluation {
  venue: VenueName;
  route: HedgeRoute;
  isParityFlip: boolean;
  longLegInstId: string;
  shortLegInstId: string;
  notionalUnderlying: number;
  rawSpreadUsd: number;
  exchangeFeeUsd: number;
  totalHedgeCostUsd: number;
  directCostUsd: number;
  parityCostUsd: number;
  paritySavedUsd: number;
  paritySavedPct: number;
  shortLegSubsidyRatio: number;
}

export interface OpenQuoteStruct {
  taker: `0x${string}`;
  maker: `0x${string}`;
  assetId: `0x${string}`;
  isUp: boolean;
  lowerStrike: string; // 8-dec uint64 as string
  upperStrike: string; // 8-dec uint64 as string
  expiry: number;
  userPayAmount: string; // 6-dec uint256 as string
  maxPayout: string; // 6-dec uint256 as string
  maxProtocolFeeBps: number;
  makerEpoch: string; // uint64 as string
  validUntil: number;
  nonce: string;
}

export interface CloseQuoteStruct {
  taker: `0x${string}`;
  maker: `0x${string}`;
  seriesId: `0x${string}`;
  isUp: boolean;
  amount: string; // 6-dec UP or DOWN token amount to close
  buybackAmount: string; // 6-dec gross USDT paid by maker/pool
  maxCloseFeeBps: number;
  makerEpoch: string; // uint64 as string
  validUntil: number;
  nonce: string;
}

export interface CompetingOpenQuote {
  makerName: string;
  makerAddress: `0x${string}`;
  venue: VenueName;
  hedgeRoute: HedgeRoute;
  isParityFlip: boolean;
  maxPayoutUsdt: number;
  maxMultiplier: number;
  mmMarginBps: number;
  paritySavedUsd: number;
  isWinner: boolean;
}

export interface OpenRfqResponse {
  quoteId: string;
  seriesId: `0x${string}`;
  verifyingContract: `0x${string}`;
  chainId: number;
  usdtAddress: `0x${string}`;
  quote: OpenQuoteStruct;
  signature: `0x${string}`;
  makerName: string;
  ticket: TicketSummary;
  competingQuotes: CompetingOpenQuote[];
}

export type CloseExecutionMode =
  | "ATOMIC_MERGE_UNLOCK"
  | "EXTERNAL_TAKEOVER"
  | "HYBRID";

export interface CompetingCloseQuote {
  makerName: string;
  makerAddress: `0x${string}`;
  venue: VenueName;
  buybackUsdt: number;
  makerCompBalanceUsdt: number;
  executionMode: CloseExecutionMode;
  unlockAmountUsdt: number;
  isWinner: boolean;
}

export interface CloseRfqResponse {
  quoteId: string;
  seriesId: `0x${string}`;
  isUp: boolean;
  verifyingContract: `0x${string}`;
  chainId: number;
  quote: CloseQuoteStruct;
  signature: `0x${string}`;
  makerName: string;
  executionMode: CloseExecutionMode;
  unlockAmountUsdt: number;
  netProceedsUsdt: number;
  competingQuotes: CompetingCloseQuote[];
}

export interface PositionView {
  tokenId: string;
  seriesId: `0x${string}`;
  assetId: `0x${string}`;
  taker: `0x${string}`;
  originalMaker: `0x${string}`;
  tierKind: TierKind;
  underlying: UnderlyingSymbol;
  direction: Direction;
  isUp: boolean;
  lowerStrike: number;
  upperStrike: number;
  startPrice: number;
  capPrice: number;
  expiry: number;
  expiryIso: string;
  initialMaxPayoutUsdt: number;
  remainingBalanceUsdt: number;
  closedBalanceUsdt: number;
  totalStakeUsdt: number;
  remainingStakeUsdt?: number;
  protocolFeeUsdt: number;
  earlyCloseProceedsUsdt: number;
  redeemedUsdt: number;
  status: "ACTIVE" | "CLOSED_EARLY" | "SETTLED_CLAIMABLE" | "SETTLED_CLAIMED";
  breakevenPrice: number;
  flatPayoutUsdt: number;
  indicativeExitUsdt: number;
  indicativeExitPct: number;
  unrealizedPnlUsdt: number;
  unrealizedPnlPct: number;
  settlementPrice?: number;
  claimableUsdt: number;
  inTwapWindow?: boolean;
  awaitingSettlement?: boolean;
  expiryPaused?: boolean;
  canPermissionlessSettle?: boolean;
  spotPrice?: number;
  openTxHash: string;
  closeTxHash?: string;
  redeemTxHash?: string;
  createdAt: number;
  updatedAt?: number;
}

export interface HedgeLedgerEntry {
  id: number;
  txHash: string;
  action: "OPEN" | "CLOSE";
  seriesId: string;
  underlying: UnderlyingSymbol;
  direction: Direction;
  lowerStrike: number;
  upperStrike: number;
  makerName: string;
  venue: VenueName;
  hedgeRoute: HedgeRoute;
  isParityFlip: boolean;
  longLegInstId: string;
  shortLegInstId: string;
  notionalUnderlying: number;
  rawExchangeCostUsd: number;
  exchangeFeeUsd: number;
  paritySavedUsd: number;
  userCashflowUsd: number;
  protocolFeeUsd: number;
  mmNetMarginUsd: number;
  capitalUnlockedUsdt: number;
  executionMode: string;
  createdAt: number;
}

export interface Phase1Metrics {
  // 1. Order volume & repeat rate
  totalOrders: number;
  uniqueBuyers: number;
  repeatBuyers: number;
  repeatPurchaseRatePct: number;
  totalVolumeUsdt: number;
  // 2. Shelf vs custom distribution
  defaultShelfOrders: number;
  customRangeOrders: number;
  defaultShelfSharePct: number;
  tierDistribution: Record<TierKind, number>;
  // 3. Early close & atomic merge unlock efficiency
  earlyClosedTickets: number;
  earlyCloseRatePct: number;
  atomicMergeUnlocks: number;
  externalTakeovers: number;
  totalCapitalUnlockedUsdt: number;
  capitalTurnoverBoostPct: number;
  // 4. Per-order protocol & maker economics
  avgProtocolFeeBps: number;
  totalProtocolFeeUsd: number;
  totalExchangeFeeUsd: number;
  totalMmNetMarginUsd: number;
  avgNetMarginPerOrderUsd: number;
  parityFlipCount: number;
  totalParitySavedUsd: number;
  // Solvency & Maker Margin Breakdown
  vaultBalanceUsdt: number;
  vaultLockedUsdt: number;
  vaultMakerMarginUsdt: number;
  vaultAccruedProtocolFeesUsdt: number;
  isVaultSolvent: boolean;
}

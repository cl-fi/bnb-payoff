import * as fs from "fs";
import * as path from "path";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import type {
  AtlasConsensusStatus,
  Direction,
  HedgeLedgerEntry,
  SettlementSource,
  TierKind,
  TwapSampleObservation,
  UnderlyingSymbol,
} from "@payoff/shared";

export interface StoredSettlement {
  underlying: UnderlyingSymbol;
  expiry: number;
  settlementPrice: number;
  txHash: string;
  settledAt: number;
  source: SettlementSource;
  feedId: string | null;
  feedIdHex: string | null;
  oracleTimestamp: number | null;
  submitter: string | null;
  sampleCount: number | null;
  isManualOverride: boolean;
  overrideReason: string | null;
}

export interface UpsertTwapHealthSampleInput {
  underlying: UnderlyingSymbol;
  expiry: number;
  sampleTs: number;
  priceUsd: number;
  consensusScore: number;
  consensusStatus: AtlasConsensusStatus;
  observedAt: number;
}

export interface StoredRfqQuote {
  quoteId: string;
  kind: "OPEN" | "CLOSE";
  taker: string;
  maker: string;
  makerName: string;
  seriesId: string;
  tierKind: TierKind;
  underlying: UnderlyingSymbol;
  direction: Direction;
  isUp: number;
  lowerStrike: number;
  upperStrike: number;
  expiry: number;
  stakeUsdt: number;
  protocolFeeUsdt: number;
  maxPayoutUsdt: number;
  buybackUsdt: number;
  nonce: string;
  competingQuotesJson: string;
  hedgePlanJson: string;
  status: string;
  createdAt: number;
}

export interface StoredTicket {
  seriesId: string;
  isUp: number;
  taker: string;
  originalMaker: string;
  tierKind: TierKind;
  underlying: UnderlyingSymbol;
  direction: Direction;
  lowerStrike: number;
  upperStrike: number;
  expiry: number;
  initialMaxPayout: number;
  remainingBalance: number;
  closedBalance: number;
  totalStakeUsdt: number;
  protocolFeeUsdt: number;
  earlyCloseProceedsUsdt: number;
  redeemedUsdt: number;
  status: "ACTIVE" | "CLOSED_EARLY" | "SETTLED_CLAIMABLE" | "SETTLED_CLAIMED";
  openTxHash: string;
  closeTxHash?: string;
  redeemTxHash?: string;
  createdAt: number;
  updatedAt: number;
}

export interface UpsertTicketOpenInput {
  seriesId: string;
  isUp: number;
  taker: string;
  maker: string;
  tierKind: TierKind;
  underlying: UnderlyingSymbol;
  direction: Direction;
  lowerStrike: number;
  upperStrike: number;
  expiry: number;
  maxPayout: number;
  stakeUsdt: number;
  protocolFeeUsdt: number;
  openTxHash: string;
  timestamp: number;
}

export interface UpdateTicketCloseInput {
  seriesId: string;
  isUp: number;
  taker: string;
  closedAmount: number;
  buybackNetUsdt: number;
  txHash?: string;
  timestamp: number;
}

export interface RecordSettlementInput {
  underlying: UnderlyingSymbol;
  expiry: number;
  settlementPrice: number;
  txHash: string;
  settledAt: number;
  source?: SettlementSource;
  feedId?: string | null;
  feedIdHex?: string | null;
  oracleTimestamp?: number | null;
  submitter?: string | null;
  sampleCount?: number | null;
  isManualOverride?: boolean;
  overrideReason?: string | null;
}

export interface UpdateTicketRedeemInput {
  seriesId: string;
  isUp: number;
  account: string;
  burnedAmount: number;
  payoutUsdt: number;
  txHash?: string;
  timestamp: number;
}

export interface UpdateTicketMergeInput {
  seriesId: string;
  account: string;
  mergedAmount: number;
  txHash?: string;
  timestamp: number;
}

export interface SeriesTicketMeta {
  underlying: UnderlyingSymbol;
  lowerStrike: number;
  upperStrike: number;
}

export interface StoredWelcomeAirdrop {
  privyUserId: string;
  walletAddress: string;
  amountUsdt: number;
  txHash: string;
  status: "PENDING" | "COMPLETED" | "FAILED";
  createdAt: number;
  updatedAt: number;
}

export interface ReserveWelcomeAirdropInput {
  privyUserId: string;
  walletAddress: string;
  amountUsdt: number;
  timestamp: number;
}

function computeMergeProceedsSplit(
  upRow: StoredTicket | undefined,
  downRow: StoredTicket | undefined,
  mergedAmount: number
): { upProceeds: number; downProceeds: number } {
  if (upRow && downRow) {
    const cUp =
      upRow.initialMaxPayout > 0
        ? upRow.totalStakeUsdt / upRow.initialMaxPayout
        : 0;
    const cDown =
      downRow.initialMaxPayout > 0
        ? downRow.totalStakeUsdt / downRow.initialMaxPayout
        : 0;
    const weight = cUp + cDown > 0 ? cUp / (cUp + cDown) : 0.5;
    const upProceeds = mergedAmount * weight;
    return { upProceeds, downProceeds: mergedAmount - upProceeds };
  }
  return {
    upProceeds: upRow ? mergedAmount * 0.5 : 0,
    downProceeds: downRow ? mergedAmount * 0.5 : 0,
  };
}

export interface PayoffDatabase {
  readonly engine: "postgres" | "sqlite";
  init(): Promise<void>;
  close(): Promise<void>;
  hasProcessedLog(txHash: string, logIndex: number): Promise<boolean>;
  markLogProcessed(txHash: string, logIndex: number): Promise<void>;
  saveRfqQuote(q: StoredRfqQuote): Promise<void>;
  findQuoteByMakerNonce(
    maker: string,
    nonce: string
  ): Promise<StoredRfqQuote | undefined>;
  markQuoteFilled(quoteId: string): Promise<void>;
  upsertTicketOnOpen(input: UpsertTicketOpenInput): Promise<void>;
  updateTicketOnClose(input: UpdateTicketCloseInput): Promise<void>;
  updateTicketOnMerge(input: UpdateTicketMergeInput): Promise<void>;
  recordSettlement(input: RecordSettlementInput): Promise<void>;
  updateTicketOnRedeem(input: UpdateTicketRedeemInput): Promise<void>;
  insertHedgeLedger(entry: Omit<HedgeLedgerEntry, "id">): Promise<void>;
  getTicketsByTaker(taker: string): Promise<StoredTicket[]>;
  getSeriesTicketMeta(seriesId: string): Promise<SeriesTicketMeta | undefined>;
  getAllTickets(): Promise<StoredTicket[]>;
  getSettlement(
    underlying: UnderlyingSymbol,
    expiry: number
  ): Promise<StoredSettlement | undefined>;
  getAllSettlements(
    underlying?: UnderlyingSymbol,
    limit?: number
  ): Promise<StoredSettlement[]>;
  getHedgeLedger(limit?: number): Promise<HedgeLedgerEntry[]>;
  getAllHedgeLedger(): Promise<HedgeLedgerEntry[]>;
  getSyncState(key: string): Promise<string | undefined>;
  setSyncState(key: string, value: string): Promise<void>;
  upsertTwapHealthSample(input: UpsertTwapHealthSampleInput): Promise<void>;
  getTwapHealthSamples(
    underlying: UnderlyingSymbol,
    expiry: number
  ): Promise<TwapSampleObservation[]>;
  getWelcomeAirdropByUserId(
    privyUserId: string
  ): Promise<StoredWelcomeAirdrop | undefined>;
  getWelcomeAirdropByWallet(
    walletAddress: string
  ): Promise<StoredWelcomeAirdrop | undefined>;
  tryReserveWelcomeAirdrop(
    input: ReserveWelcomeAirdropInput
  ): Promise<{ reserved: boolean; existing?: StoredWelcomeAirdrop }>;
  completeWelcomeAirdrop(input: {
    privyUserId: string;
    txHash: string;
    timestamp: number;
  }): Promise<void>;
  failWelcomeAirdrop(input: {
    privyUserId: string;
    timestamp: number;
  }): Promise<void>;
}

// ============================================================================
// PostgreSQL Implementation (Production & Local Docker)
// ============================================================================

export class PostgresDatabase implements PayoffDatabase {
  public readonly engine = "postgres" as const;
  private readonly pool: Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool({
      connectionString: databaseUrl,
      max: 10,
      idleTimeoutMillis: 30_000,
    });
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS rfq_quotes (
        quote_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        taker TEXT NOT NULL,
        maker TEXT NOT NULL,
        maker_name TEXT NOT NULL,
        series_id TEXT NOT NULL,
        tier_kind TEXT NOT NULL,
        underlying TEXT NOT NULL,
        direction TEXT NOT NULL,
        is_up INTEGER NOT NULL,
        lower_strike DOUBLE PRECISION NOT NULL,
        upper_strike DOUBLE PRECISION NOT NULL,
        expiry BIGINT NOT NULL,
        stake_usdt DOUBLE PRECISION NOT NULL,
        protocol_fee_usdt DOUBLE PRECISION NOT NULL,
        max_payout_usdt DOUBLE PRECISION NOT NULL,
        buyback_usdt DOUBLE PRECISION NOT NULL,
        nonce TEXT NOT NULL,
        competing_quotes_json TEXT NOT NULL,
        hedge_plan_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at BIGINT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_rfq_nonce ON rfq_quotes(maker, nonce);
      CREATE INDEX IF NOT EXISTS idx_rfq_series ON rfq_quotes(series_id);

      CREATE TABLE IF NOT EXISTS tickets (
        series_id TEXT NOT NULL,
        is_up INTEGER NOT NULL,
        taker TEXT NOT NULL,
        original_maker TEXT NOT NULL,
        tier_kind TEXT NOT NULL,
        underlying TEXT NOT NULL,
        direction TEXT NOT NULL,
        lower_strike DOUBLE PRECISION NOT NULL,
        upper_strike DOUBLE PRECISION NOT NULL,
        expiry BIGINT NOT NULL,
        initial_max_payout DOUBLE PRECISION NOT NULL,
        remaining_balance DOUBLE PRECISION NOT NULL,
        closed_balance DOUBLE PRECISION NOT NULL,
        total_stake_usdt DOUBLE PRECISION NOT NULL,
        protocol_fee_usdt DOUBLE PRECISION NOT NULL,
        early_close_proceeds_usdt DOUBLE PRECISION NOT NULL,
        redeemed_usdt DOUBLE PRECISION NOT NULL,
        status TEXT NOT NULL,
        open_tx_hash TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (series_id, is_up, taker)
      );

      CREATE INDEX IF NOT EXISTS idx_tickets_taker ON tickets(taker);

      CREATE TABLE IF NOT EXISTS hedge_ledger (
        id SERIAL PRIMARY KEY,
        tx_hash TEXT NOT NULL,
        action TEXT NOT NULL,
        series_id TEXT NOT NULL,
        underlying TEXT NOT NULL,
        direction TEXT NOT NULL,
        lower_strike DOUBLE PRECISION NOT NULL,
        upper_strike DOUBLE PRECISION NOT NULL,
        maker_name TEXT NOT NULL,
        venue TEXT NOT NULL,
        hedge_route TEXT NOT NULL,
        is_parity_flip INTEGER NOT NULL,
        long_leg_inst_id TEXT NOT NULL,
        short_leg_inst_id TEXT NOT NULL,
        notional_underlying DOUBLE PRECISION NOT NULL,
        raw_exchange_cost_usd DOUBLE PRECISION NOT NULL,
        exchange_fee_usd DOUBLE PRECISION NOT NULL,
        parity_saved_usd DOUBLE PRECISION NOT NULL,
        user_cashflow_usd DOUBLE PRECISION NOT NULL,
        protocol_fee_usd DOUBLE PRECISION NOT NULL,
        mm_net_margin_usd DOUBLE PRECISION NOT NULL,
        capital_unlocked_usdt DOUBLE PRECISION NOT NULL,
        execution_mode TEXT NOT NULL,
        created_at BIGINT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_tx_action ON hedge_ledger(tx_hash, action);

      CREATE TABLE IF NOT EXISTS settlements (
        underlying TEXT NOT NULL,
        expiry BIGINT NOT NULL,
        settlement_price DOUBLE PRECISION NOT NULL,
        tx_hash TEXT NOT NULL,
        settled_at BIGINT NOT NULL,
        source TEXT NOT NULL DEFAULT 'ONCHAIN_SYNCED',
        feed_id TEXT,
        feed_id_hex TEXT,
        oracle_timestamp BIGINT,
        submitter TEXT,
        sample_count INTEGER,
        is_manual_override INTEGER NOT NULL DEFAULT 0,
        override_reason TEXT,
        PRIMARY KEY (underlying, expiry)
      );

      ALTER TABLE settlements ADD COLUMN IF NOT EXISTS sample_count INTEGER;
      ALTER TABLE settlements ADD COLUMN IF NOT EXISTS is_manual_override INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE settlements ADD COLUMN IF NOT EXISTS override_reason TEXT;
      ALTER TABLE tickets ADD COLUMN IF NOT EXISTS close_tx_hash TEXT;
      ALTER TABLE tickets ADD COLUMN IF NOT EXISTS redeem_tx_hash TEXT;

      CREATE TABLE IF NOT EXISTS twap_health_samples (
        underlying TEXT NOT NULL,
        expiry BIGINT NOT NULL,
        sample_ts BIGINT NOT NULL,
        price_usd DOUBLE PRECISION NOT NULL,
        avg_consensus_score DOUBLE PRECISION NOT NULL,
        min_consensus_score DOUBLE PRECISION NOT NULL,
        consensus_status TEXT NOT NULL,
        tick_count INTEGER NOT NULL DEFAULT 1,
        observed_at BIGINT NOT NULL,
        PRIMARY KEY (underlying, expiry, sample_ts)
      );

      CREATE INDEX IF NOT EXISTS idx_twap_health_expiry ON twap_health_samples(underlying, expiry);

      CREATE TABLE IF NOT EXISTS sync_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS processed_logs (
        tx_hash TEXT NOT NULL,
        log_index INTEGER NOT NULL,
        PRIMARY KEY (tx_hash, log_index)
      );

      CREATE TABLE IF NOT EXISTS welcome_airdrops (
        privy_user_id TEXT PRIMARY KEY,
        wallet_address TEXT NOT NULL UNIQUE,
        amount_usdt DOUBLE PRECISION NOT NULL,
        tx_hash TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );
    `);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private mapQuote(r: any): StoredRfqQuote {
    return {
      quoteId: r.quote_id,
      kind: r.kind,
      taker: r.taker,
      maker: r.maker,
      makerName: r.maker_name,
      seriesId: r.series_id,
      tierKind: r.tier_kind,
      underlying: r.underlying,
      direction: r.direction,
      isUp: Number(r.is_up),
      lowerStrike: Number(r.lower_strike),
      upperStrike: Number(r.upper_strike),
      expiry: Number(r.expiry),
      stakeUsdt: Number(r.stake_usdt),
      protocolFeeUsdt: Number(r.protocol_fee_usdt),
      maxPayoutUsdt: Number(r.max_payout_usdt),
      buybackUsdt: Number(r.buyback_usdt),
      nonce: r.nonce,
      competingQuotesJson: r.competing_quotes_json,
      hedgePlanJson: r.hedge_plan_json,
      status: r.status,
      createdAt: Number(r.created_at),
    };
  }

  private mapTicket(r: any): StoredTicket {
    return {
      seriesId: r.series_id,
      isUp: Number(r.is_up),
      taker: r.taker,
      originalMaker: r.original_maker,
      tierKind: r.tier_kind,
      underlying: r.underlying,
      direction: r.direction,
      lowerStrike: Number(r.lower_strike),
      upperStrike: Number(r.upper_strike),
      expiry: Number(r.expiry),
      initialMaxPayout: Number(r.initial_max_payout),
      remainingBalance: Number(r.remaining_balance),
      closedBalance: Number(r.closed_balance),
      totalStakeUsdt: Number(r.total_stake_usdt),
      protocolFeeUsdt: Number(r.protocol_fee_usdt),
      earlyCloseProceedsUsdt: Number(r.early_close_proceeds_usdt),
      redeemedUsdt: Number(r.redeemed_usdt),
      status: r.status,
      openTxHash: r.open_tx_hash,
      closeTxHash: r.close_tx_hash || undefined,
      redeemTxHash: r.redeem_tx_hash || undefined,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    };
  }

  private mapSettlement(r: any): StoredSettlement {
    return {
      underlying: r.underlying,
      expiry: Number(r.expiry),
      settlementPrice: Number(r.settlement_price),
      txHash: r.tx_hash,
      settledAt: Number(r.settled_at),
      source: r.source,
      feedId: r.feed_id ?? null,
      feedIdHex: r.feed_id_hex ?? null,
      oracleTimestamp:
        r.oracle_timestamp !== null && r.oracle_timestamp !== undefined
          ? Number(r.oracle_timestamp)
          : null,
      submitter: r.submitter ?? null,
      sampleCount:
        r.sample_count !== null && r.sample_count !== undefined
          ? Number(r.sample_count)
          : null,
      isManualOverride: Boolean(Number(r.is_manual_override ?? 0)),
      overrideReason: r.override_reason ?? null,
    };
  }

  private mapLedger(r: any): HedgeLedgerEntry {
    return {
      id: Number(r.id),
      txHash: r.tx_hash,
      action: r.action,
      seriesId: r.series_id,
      underlying: r.underlying,
      direction: r.direction,
      lowerStrike: Number(r.lower_strike),
      upperStrike: Number(r.upper_strike),
      makerName: r.maker_name,
      venue: r.venue,
      hedgeRoute: r.hedge_route,
      isParityFlip: Boolean(Number(r.is_parity_flip)),
      longLegInstId: r.long_leg_inst_id,
      shortLegInstId: r.short_leg_inst_id,
      notionalUnderlying: Number(r.notional_underlying),
      rawExchangeCostUsd: Number(r.raw_exchange_cost_usd),
      exchangeFeeUsd: Number(r.exchange_fee_usd),
      paritySavedUsd: Number(r.parity_saved_usd),
      userCashflowUsd: Number(r.user_cashflow_usd),
      protocolFeeUsd: Number(r.protocol_fee_usd),
      mmNetMarginUsd: Number(r.mm_net_margin_usd),
      capitalUnlockedUsdt: Number(r.capital_unlocked_usdt),
      executionMode: r.execution_mode,
      createdAt: Number(r.created_at),
    };
  }

  async hasProcessedLog(txHash: string, logIndex: number): Promise<boolean> {
    const res = await this.pool.query(
      `SELECT 1 AS ok FROM processed_logs WHERE tx_hash = $1 AND log_index = $2`,
      [txHash.toLowerCase(), logIndex]
    );
    return res.rowCount !== null && res.rowCount > 0;
  }

  async markLogProcessed(txHash: string, logIndex: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO processed_logs (tx_hash, log_index) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [txHash.toLowerCase(), logIndex]
    );
  }

  async saveRfqQuote(q: StoredRfqQuote): Promise<void> {
    await this.pool.query(
      `INSERT INTO rfq_quotes (
        quote_id, kind, taker, maker, maker_name, series_id, tier_kind,
        underlying, direction, is_up, lower_strike, upper_strike, expiry,
        stake_usdt, protocol_fee_usdt, max_payout_usdt, buyback_usdt, nonce,
        competing_quotes_json, hedge_plan_json, status, created_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22
      )
      ON CONFLICT (quote_id) DO UPDATE SET
        status = EXCLUDED.status,
        competing_quotes_json = EXCLUDED.competing_quotes_json,
        hedge_plan_json = EXCLUDED.hedge_plan_json`,
      [
        q.quoteId,
        q.kind,
        q.taker.toLowerCase(),
        q.maker.toLowerCase(),
        q.makerName,
        q.seriesId.toLowerCase(),
        q.tierKind,
        q.underlying,
        q.direction,
        q.isUp,
        q.lowerStrike,
        q.upperStrike,
        q.expiry,
        q.stakeUsdt,
        q.protocolFeeUsdt,
        q.maxPayoutUsdt,
        q.buybackUsdt,
        q.nonce,
        q.competingQuotesJson,
        q.hedgePlanJson,
        q.status,
        q.createdAt,
      ]
    );
  }

  async findQuoteByMakerNonce(
    maker: string,
    nonce: string
  ): Promise<StoredRfqQuote | undefined> {
    const res = await this.pool.query(
      `SELECT * FROM rfq_quotes WHERE maker = $1 AND nonce = $2 ORDER BY created_at DESC LIMIT 1`,
      [maker.toLowerCase(), nonce]
    );
    return res.rows[0] ? this.mapQuote(res.rows[0]) : undefined;
  }

  async markQuoteFilled(quoteId: string): Promise<void> {
    await this.pool.query(
      `UPDATE rfq_quotes SET status = 'FILLED' WHERE quote_id = $1`,
      [quoteId]
    );
  }

  async upsertTicketOnOpen(input: UpsertTicketOpenInput): Promise<void> {
    const sid = input.seriesId.toLowerCase();
    const taker = input.taker.toLowerCase();
    const isUp = input.isUp ? 1 : 0;
    await this.pool.query(
      `INSERT INTO tickets (
        series_id, is_up, taker, original_maker, tier_kind, underlying, direction,
        lower_strike, upper_strike, expiry, initial_max_payout,
        remaining_balance, closed_balance, total_stake_usdt, protocol_fee_usdt,
        early_close_proceeds_usdt, redeemed_usdt, status, open_tx_hash, created_at, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,0,$12,$13,0,0,'ACTIVE',$14,$15,$15
      )
      ON CONFLICT (series_id, is_up, taker) DO UPDATE SET
        initial_max_payout = tickets.initial_max_payout + EXCLUDED.initial_max_payout,
        remaining_balance = tickets.remaining_balance + EXCLUDED.remaining_balance,
        total_stake_usdt = tickets.total_stake_usdt + EXCLUDED.total_stake_usdt,
        protocol_fee_usdt = tickets.protocol_fee_usdt + EXCLUDED.protocol_fee_usdt,
        status = 'ACTIVE',
        open_tx_hash = EXCLUDED.open_tx_hash,
        updated_at = EXCLUDED.updated_at`,
      [
        sid,
        isUp,
        taker,
        input.maker.toLowerCase(),
        input.tierKind,
        input.underlying,
        input.direction,
        input.lowerStrike,
        input.upperStrike,
        input.expiry,
        input.maxPayout,
        input.stakeUsdt,
        input.protocolFeeUsdt,
        input.openTxHash,
        input.timestamp,
      ]
    );
  }

  async updateTicketOnClose(input: UpdateTicketCloseInput): Promise<void> {
    const sid = input.seriesId.toLowerCase();
    const taker = input.taker.toLowerCase();
    const isUp = input.isUp ? 1 : 0;
    const res = await this.pool.query(
      `SELECT * FROM tickets WHERE series_id = $1 AND is_up = $2 AND taker = $3`,
      [sid, isUp, taker]
    );
    if (!res.rows[0]) return;
    const existing = this.mapTicket(res.rows[0]);
    const newRemaining = Math.max(
      0,
      existing.remainingBalance - input.closedAmount
    );
    const newStatus = newRemaining <= 1e-6 ? "CLOSED_EARLY" : existing.status;

    await this.pool.query(
      `UPDATE tickets SET
        remaining_balance = $1,
        closed_balance = closed_balance + $2,
        early_close_proceeds_usdt = early_close_proceeds_usdt + $3,
        status = $4,
        close_tx_hash = COALESCE(NULLIF($5, ''), close_tx_hash),
        updated_at = $6
      WHERE series_id = $7 AND is_up = $8 AND taker = $9`,
      [
        newRemaining,
        input.closedAmount,
        input.buybackNetUsdt,
        newStatus,
        input.txHash ?? "",
        input.timestamp,
        sid,
        isUp,
        taker,
      ]
    );
  }

  async updateTicketOnMerge(input: UpdateTicketMergeInput): Promise<void> {
    if (input.mergedAmount <= 0) return;
    const sid = input.seriesId.toLowerCase();
    const account = input.account.toLowerCase();
    const res = await this.pool.query(
      `SELECT * FROM tickets WHERE series_id = $1 AND taker = $2`,
      [sid, account]
    );
    if (res.rows.length === 0) return;
    const rows = res.rows.map((r) => this.mapTicket(r));
    const upRow = rows.find((r) => Boolean(r.isUp));
    const downRow = rows.find((r) => !Boolean(r.isUp));
    const { upProceeds, downProceeds } = computeMergeProceedsSplit(
      upRow,
      downRow,
      input.mergedAmount
    );

    for (const [row, proceeds] of [
      [upRow, upProceeds],
      [downRow, downProceeds],
    ] as const) {
      if (!row) continue;
      const newRemaining = Math.max(
        0,
        row.remainingBalance - input.mergedAmount
      );
      const newStatus = newRemaining <= 1e-6 ? "CLOSED_EARLY" : row.status;
      await this.pool.query(
        `UPDATE tickets SET
          remaining_balance = $1,
          closed_balance = closed_balance + $2,
          early_close_proceeds_usdt = early_close_proceeds_usdt + $3,
          status = $4,
          close_tx_hash = COALESCE(NULLIF($5, ''), close_tx_hash),
          updated_at = $6
        WHERE series_id = $7 AND is_up = $8 AND taker = $9`,
        [
          newRemaining,
          input.mergedAmount,
          proceeds,
          newStatus,
          input.txHash ?? "",
          input.timestamp,
          sid,
          row.isUp ? 1 : 0,
          account,
        ]
      );
    }
  }

  async recordSettlement(input: RecordSettlementInput): Promise<void> {
    const existing = await this.getSettlement(input.underlying, input.expiry);
    const resolvedSource: SettlementSource =
      input.source && input.source !== "ONCHAIN_SYNCED"
        ? input.source
        : existing?.source ?? input.source ?? "ONCHAIN_SYNCED";
    const resolvedFeedId =
      input.feedId !== undefined ? input.feedId : existing?.feedId ?? null;
    const resolvedFeedIdHex =
      input.feedIdHex !== undefined
        ? input.feedIdHex
        : existing?.feedIdHex ?? null;
    const resolvedOracleTs =
      input.oracleTimestamp !== undefined
        ? input.oracleTimestamp
        : existing?.oracleTimestamp ?? null;
    const resolvedSubmitter =
      input.submitter !== undefined
        ? input.submitter
        : existing?.submitter ?? null;
    const resolvedSampleCount =
      input.sampleCount !== undefined
        ? input.sampleCount
        : existing?.sampleCount ?? null;
    const resolvedIsManualOverride =
      input.isManualOverride !== undefined
        ? input.isManualOverride
        : existing?.isManualOverride ?? false;
    const resolvedOverrideReason =
      input.overrideReason !== undefined
        ? input.overrideReason
        : existing?.overrideReason ?? null;

    await this.pool.query(
      `INSERT INTO settlements (
        underlying, expiry, settlement_price, tx_hash, settled_at,
        source, feed_id, feed_id_hex, oracle_timestamp, submitter,
        sample_count, is_manual_override, override_reason
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT (underlying, expiry) DO UPDATE SET
        settlement_price = EXCLUDED.settlement_price,
        tx_hash = EXCLUDED.tx_hash,
        settled_at = EXCLUDED.settled_at,
        source = EXCLUDED.source,
        feed_id = EXCLUDED.feed_id,
        feed_id_hex = EXCLUDED.feed_id_hex,
        oracle_timestamp = EXCLUDED.oracle_timestamp,
        submitter = EXCLUDED.submitter,
        sample_count = EXCLUDED.sample_count,
        is_manual_override = EXCLUDED.is_manual_override,
        override_reason = EXCLUDED.override_reason`,
      [
        input.underlying,
        input.expiry,
        input.settlementPrice,
        input.txHash,
        input.settledAt,
        resolvedSource,
        resolvedFeedId,
        resolvedFeedIdHex,
        resolvedOracleTs,
        resolvedSubmitter,
        resolvedSampleCount,
        resolvedIsManualOverride ? 1 : 0,
        resolvedOverrideReason,
      ]
    );

    await this.pool.query(
      `UPDATE tickets SET status = 'SETTLED_CLAIMABLE', updated_at = $1
       WHERE underlying = $2 AND expiry = $3 AND remaining_balance > 1e-6 AND status = 'ACTIVE'`,
      [input.settledAt, input.underlying, input.expiry]
    );
  }

  async updateTicketOnRedeem(input: UpdateTicketRedeemInput): Promise<void> {
    if (input.burnedAmount <= 0) return;
    await this.pool.query(
      `UPDATE tickets SET
        remaining_balance = 0,
        redeemed_usdt = redeemed_usdt + $1,
        status = 'SETTLED_CLAIMED',
        redeem_tx_hash = COALESCE(NULLIF($2, ''), redeem_tx_hash),
        updated_at = $3
      WHERE series_id = $4 AND is_up = $5 AND taker = $6`,
      [
        input.payoutUsdt,
        input.txHash ?? "",
        input.timestamp,
        input.seriesId.toLowerCase(),
        input.isUp ? 1 : 0,
        input.account.toLowerCase(),
      ]
    );
  }

  async insertHedgeLedger(entry: Omit<HedgeLedgerEntry, "id">): Promise<void> {
    await this.pool.query(
      `INSERT INTO hedge_ledger (
        tx_hash, action, series_id, underlying, direction,
        lower_strike, upper_strike, maker_name, venue, hedge_route,
        is_parity_flip, long_leg_inst_id, short_leg_inst_id, notional_underlying,
        raw_exchange_cost_usd, exchange_fee_usd, parity_saved_usd,
        user_cashflow_usd, protocol_fee_usd, mm_net_margin_usd,
        capital_unlocked_usdt, execution_mode, created_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23
      )
      ON CONFLICT (tx_hash, action) DO NOTHING`,
      [
        entry.txHash,
        entry.action,
        entry.seriesId.toLowerCase(),
        entry.underlying,
        entry.direction,
        entry.lowerStrike,
        entry.upperStrike,
        entry.makerName,
        entry.venue,
        entry.hedgeRoute,
        entry.isParityFlip ? 1 : 0,
        entry.longLegInstId,
        entry.shortLegInstId,
        entry.notionalUnderlying,
        entry.rawExchangeCostUsd,
        entry.exchangeFeeUsd,
        entry.paritySavedUsd,
        entry.userCashflowUsd,
        entry.protocolFeeUsd,
        entry.mmNetMarginUsd,
        entry.capitalUnlockedUsdt,
        entry.executionMode,
        entry.createdAt,
      ]
    );
  }

  async getTicketsByTaker(taker: string): Promise<StoredTicket[]> {
    const res = await this.pool.query(
      `SELECT * FROM tickets WHERE taker = $1 ORDER BY created_at DESC`,
      [taker.toLowerCase()]
    );
    return res.rows.map((r) => this.mapTicket(r));
  }

  async getSeriesTicketMeta(
    seriesId: string
  ): Promise<SeriesTicketMeta | undefined> {
    const res = await this.pool.query(
      `SELECT underlying, lower_strike, upper_strike FROM tickets WHERE series_id = $1 LIMIT 1`,
      [seriesId.toLowerCase()]
    );
    if (!res.rows[0]) return undefined;
    return {
      underlying: res.rows[0].underlying,
      lowerStrike: Number(res.rows[0].lower_strike),
      upperStrike: Number(res.rows[0].upper_strike),
    };
  }

  async getAllTickets(): Promise<StoredTicket[]> {
    const res = await this.pool.query(
      `SELECT * FROM tickets ORDER BY created_at DESC`
    );
    return res.rows.map((r) => this.mapTicket(r));
  }

  async getSettlement(
    underlying: UnderlyingSymbol,
    expiry: number
  ): Promise<StoredSettlement | undefined> {
    const res = await this.pool.query(
      `SELECT * FROM settlements WHERE underlying = $1 AND expiry = $2`,
      [underlying, expiry]
    );
    return res.rows[0] ? this.mapSettlement(res.rows[0]) : undefined;
  }

  async getAllSettlements(
    underlying?: UnderlyingSymbol,
    limit = 50
  ): Promise<StoredSettlement[]> {
    if (underlying) {
      const res = await this.pool.query(
        `SELECT * FROM settlements WHERE underlying = $1 ORDER BY expiry DESC LIMIT $2`,
        [underlying, limit]
      );
      return res.rows.map((r) => this.mapSettlement(r));
    }
    const res = await this.pool.query(
      `SELECT * FROM settlements ORDER BY expiry DESC LIMIT $1`,
      [limit]
    );
    return res.rows.map((r) => this.mapSettlement(r));
  }

  async getHedgeLedger(limit = 50): Promise<HedgeLedgerEntry[]> {
    const res = await this.pool.query(
      `SELECT * FROM hedge_ledger ORDER BY id DESC LIMIT $1`,
      [limit]
    );
    return res.rows.map((r) => this.mapLedger(r));
  }

  async getAllHedgeLedger(): Promise<HedgeLedgerEntry[]> {
    const res = await this.pool.query(
      `SELECT * FROM hedge_ledger ORDER BY id DESC`
    );
    return res.rows.map((r) => this.mapLedger(r));
  }

  async getSyncState(key: string): Promise<string | undefined> {
    const res = await this.pool.query(
      `SELECT value FROM sync_state WHERE key = $1`,
      [key]
    );
    return res.rows[0]?.value;
  }

  async setSyncState(key: string, value: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO sync_state (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value]
    );
  }

  async upsertTwapHealthSample(input: UpsertTwapHealthSampleInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO twap_health_samples (
        underlying, expiry, sample_ts, price_usd,
        avg_consensus_score, min_consensus_score, consensus_status,
        tick_count, observed_at
      ) VALUES ($1,$2,$3,$4,$5,$5,$6,1,$7)
      ON CONFLICT (underlying, expiry, sample_ts) DO UPDATE SET
        price_usd = EXCLUDED.price_usd,
        avg_consensus_score = (
          twap_health_samples.avg_consensus_score * twap_health_samples.tick_count + EXCLUDED.avg_consensus_score
        ) / (twap_health_samples.tick_count + 1),
        min_consensus_score = LEAST(twap_health_samples.min_consensus_score, EXCLUDED.min_consensus_score),
        consensus_status = EXCLUDED.consensus_status,
        tick_count = twap_health_samples.tick_count + 1,
        observed_at = EXCLUDED.observed_at`,
      [
        input.underlying,
        input.expiry,
        input.sampleTs,
        input.priceUsd,
        input.consensusScore,
        input.consensusStatus,
        input.observedAt,
      ]
    );
  }

  async getTwapHealthSamples(
    underlying: UnderlyingSymbol,
    expiry: number
  ): Promise<TwapSampleObservation[]> {
    const res = await this.pool.query(
      `SELECT * FROM twap_health_samples WHERE underlying = $1 AND expiry = $2 ORDER BY sample_ts ASC`,
      [underlying, expiry]
    );
    return res.rows.map((r) => ({
      underlying: r.underlying,
      expiry: Number(r.expiry),
      sampleTs: Number(r.sample_ts),
      priceUsd: Number(r.price_usd),
      avgConsensusScore: Number(r.avg_consensus_score),
      minConsensusScore: Number(r.min_consensus_score),
      consensusStatus: r.consensus_status as AtlasConsensusStatus,
      tickCount: Number(r.tick_count),
      observedAt: Number(r.observed_at),
    }));
  }

  private mapWelcomeAirdrop(r: any): StoredWelcomeAirdrop {
    return {
      privyUserId: r.privy_user_id,
      walletAddress: r.wallet_address,
      amountUsdt: Number(r.amount_usdt),
      txHash: r.tx_hash || "",
      status: r.status as StoredWelcomeAirdrop["status"],
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    };
  }

  async getWelcomeAirdropByUserId(
    privyUserId: string
  ): Promise<StoredWelcomeAirdrop | undefined> {
    const res = await this.pool.query(
      `SELECT * FROM welcome_airdrops WHERE privy_user_id = $1`,
      [privyUserId]
    );
    return res.rows[0] ? this.mapWelcomeAirdrop(res.rows[0]) : undefined;
  }

  async getWelcomeAirdropByWallet(
    walletAddress: string
  ): Promise<StoredWelcomeAirdrop | undefined> {
    const res = await this.pool.query(
      `SELECT * FROM welcome_airdrops WHERE wallet_address = $1`,
      [walletAddress.toLowerCase()]
    );
    return res.rows[0] ? this.mapWelcomeAirdrop(res.rows[0]) : undefined;
  }

  async tryReserveWelcomeAirdrop(
    input: ReserveWelcomeAirdropInput
  ): Promise<{ reserved: boolean; existing?: StoredWelcomeAirdrop }> {
    const wallet = input.walletAddress.toLowerCase();
    const byUser = await this.getWelcomeAirdropByUserId(input.privyUserId);
    if (byUser) {
      if (byUser.status !== "FAILED") {
        return { reserved: false, existing: byUser };
      }
      const byWallet = await this.getWelcomeAirdropByWallet(wallet);
      if (byWallet && byWallet.privyUserId !== input.privyUserId) {
        return { reserved: false, existing: byWallet };
      }
      const updated = await this.pool.query(
        `UPDATE welcome_airdrops
         SET wallet_address = $1, amount_usdt = $2, tx_hash = '', status = 'PENDING', updated_at = $3
         WHERE privy_user_id = $4 AND status = 'FAILED'`,
        [wallet, input.amountUsdt, input.timestamp, input.privyUserId]
      );
      if (updated.rowCount && updated.rowCount > 0) {
        return { reserved: true };
      }
      return {
        reserved: false,
        existing: await this.getWelcomeAirdropByUserId(input.privyUserId),
      };
    }

    const byWallet = await this.getWelcomeAirdropByWallet(wallet);
    if (byWallet) {
      return { reserved: false, existing: byWallet };
    }

    const inserted = await this.pool.query(
      `INSERT INTO welcome_airdrops (
        privy_user_id, wallet_address, amount_usdt, tx_hash, status, created_at, updated_at
      ) VALUES ($1, $2, $3, '', 'PENDING', $4, $4)
      ON CONFLICT DO NOTHING`,
      [input.privyUserId, wallet, input.amountUsdt, input.timestamp]
    );
    if (inserted.rowCount && inserted.rowCount > 0) {
      return { reserved: true };
    }
    const existing =
      (await this.getWelcomeAirdropByUserId(input.privyUserId)) ??
      (await this.getWelcomeAirdropByWallet(wallet));
    return { reserved: false, existing };
  }

  async completeWelcomeAirdrop(input: {
    privyUserId: string;
    txHash: string;
    timestamp: number;
  }): Promise<void> {
    await this.pool.query(
      `UPDATE welcome_airdrops
       SET status = 'COMPLETED', tx_hash = $1, updated_at = $2
       WHERE privy_user_id = $3`,
      [input.txHash, input.timestamp, input.privyUserId]
    );
  }

  async failWelcomeAirdrop(input: {
    privyUserId: string;
    timestamp: number;
  }): Promise<void> {
    await this.pool.query(
      `UPDATE welcome_airdrops
       SET status = 'FAILED', updated_at = $1
       WHERE privy_user_id = $2 AND status = 'PENDING'`,
      [input.timestamp, input.privyUserId]
    );
  }
}

// ============================================================================
// SQLite Implementation (Zero-dependency Unit Tests & Local Fallback)
// ============================================================================

export class SqliteDatabase implements PayoffDatabase {
  public readonly engine = "sqlite" as const;
  public readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
  }

  async init(): Promise<void> {
    this.db.exec(`
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS rfq_quotes (
        quoteId TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        taker TEXT NOT NULL,
        maker TEXT NOT NULL,
        makerName TEXT NOT NULL,
        seriesId TEXT NOT NULL,
        tierKind TEXT NOT NULL,
        underlying TEXT NOT NULL,
        direction TEXT NOT NULL,
        isUp INTEGER NOT NULL,
        lowerStrike REAL NOT NULL,
        upperStrike REAL NOT NULL,
        expiry INTEGER NOT NULL,
        stakeUsdt REAL NOT NULL,
        protocolFeeUsdt REAL NOT NULL,
        maxPayoutUsdt REAL NOT NULL,
        buybackUsdt REAL NOT NULL,
        nonce TEXT NOT NULL,
        competingQuotesJson TEXT NOT NULL,
        hedgePlanJson TEXT NOT NULL,
        status TEXT NOT NULL,
        createdAt INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_rfq_nonce ON rfq_quotes(maker, nonce);
      CREATE INDEX IF NOT EXISTS idx_rfq_series ON rfq_quotes(seriesId);

      CREATE TABLE IF NOT EXISTS tickets (
        seriesId TEXT NOT NULL,
        isUp INTEGER NOT NULL,
        taker TEXT NOT NULL,
        originalMaker TEXT NOT NULL,
        tierKind TEXT NOT NULL,
        underlying TEXT NOT NULL,
        direction TEXT NOT NULL,
        lowerStrike REAL NOT NULL,
        upperStrike REAL NOT NULL,
        expiry INTEGER NOT NULL,
        initialMaxPayout REAL NOT NULL,
        remainingBalance REAL NOT NULL,
        closedBalance REAL NOT NULL,
        totalStakeUsdt REAL NOT NULL,
        protocolFeeUsdt REAL NOT NULL,
        earlyCloseProceedsUsdt REAL NOT NULL,
        redeemedUsdt REAL NOT NULL,
        status TEXT NOT NULL,
        openTxHash TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        PRIMARY KEY (seriesId, isUp, taker)
      );

      CREATE INDEX IF NOT EXISTS idx_tickets_taker ON tickets(taker);

      CREATE TABLE IF NOT EXISTS hedge_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        txHash TEXT NOT NULL,
        action TEXT NOT NULL,
        seriesId TEXT NOT NULL,
        underlying TEXT NOT NULL,
        direction TEXT NOT NULL,
        lowerStrike REAL NOT NULL,
        upperStrike REAL NOT NULL,
        makerName TEXT NOT NULL,
        venue TEXT NOT NULL,
        hedgeRoute TEXT NOT NULL,
        isParityFlip INTEGER NOT NULL,
        longLegInstId TEXT NOT NULL,
        shortLegInstId TEXT NOT NULL,
        notionalUnderlying REAL NOT NULL,
        rawExchangeCostUsd REAL NOT NULL,
        exchangeFeeUsd REAL NOT NULL,
        paritySavedUsd REAL NOT NULL,
        userCashflowUsd REAL NOT NULL,
        protocolFeeUsd REAL NOT NULL,
        mmNetMarginUsd REAL NOT NULL,
        capitalUnlockedUsdt REAL NOT NULL,
        executionMode TEXT NOT NULL,
        createdAt INTEGER NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_tx_action ON hedge_ledger(txHash, action);

      CREATE TABLE IF NOT EXISTS settlements (
        underlying TEXT NOT NULL,
        expiry INTEGER NOT NULL,
        settlementPrice REAL NOT NULL,
        txHash TEXT NOT NULL,
        settledAt INTEGER NOT NULL,
        source TEXT NOT NULL DEFAULT 'ONCHAIN_SYNCED',
        feedId TEXT,
        feedIdHex TEXT,
        oracleTimestamp INTEGER,
        submitter TEXT,
        sampleCount INTEGER,
        isManualOverride INTEGER NOT NULL DEFAULT 0,
        overrideReason TEXT,
        PRIMARY KEY (underlying, expiry)
      );

      CREATE TABLE IF NOT EXISTS twap_health_samples (
        underlying TEXT NOT NULL,
        expiry INTEGER NOT NULL,
        sampleTs INTEGER NOT NULL,
        priceUsd REAL NOT NULL,
        avgConsensusScore REAL NOT NULL,
        minConsensusScore REAL NOT NULL,
        consensusStatus TEXT NOT NULL,
        tickCount INTEGER NOT NULL DEFAULT 1,
        observedAt INTEGER NOT NULL,
        PRIMARY KEY (underlying, expiry, sampleTs)
      );

      CREATE INDEX IF NOT EXISTS idx_twap_health_expiry ON twap_health_samples(underlying, expiry);

      CREATE TABLE IF NOT EXISTS sync_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS processed_logs (
        txHash TEXT NOT NULL,
        logIndex INTEGER NOT NULL,
        PRIMARY KEY (txHash, logIndex)
      );

      CREATE TABLE IF NOT EXISTS welcome_airdrops (
        privyUserId TEXT PRIMARY KEY,
        walletAddress TEXT NOT NULL UNIQUE,
        amountUsdt REAL NOT NULL,
        txHash TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );
    `);

    // Safe migration for pre-existing local SQLite databases
    for (const stmt of [
      `ALTER TABLE settlements ADD COLUMN sampleCount INTEGER`,
      `ALTER TABLE settlements ADD COLUMN isManualOverride INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE settlements ADD COLUMN overrideReason TEXT`,
      `ALTER TABLE tickets ADD COLUMN closeTxHash TEXT`,
      `ALTER TABLE tickets ADD COLUMN redeemTxHash TEXT`,
    ]) {
      try {
        this.db.exec(stmt);
      } catch {
        // column already exists
      }
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }

  async hasProcessedLog(txHash: string, logIndex: number): Promise<boolean> {
    const row = this.db
      .prepare(
        `SELECT 1 AS ok FROM processed_logs WHERE txHash = ? AND logIndex = ?`
      )
      .get(txHash.toLowerCase(), logIndex) as { ok: number } | undefined;
    return Boolean(row);
  }

  async markLogProcessed(txHash: string, logIndex: number): Promise<void> {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO processed_logs (txHash, logIndex) VALUES (?, ?)`
      )
      .run(txHash.toLowerCase(), logIndex);
  }

  async saveRfqQuote(q: StoredRfqQuote): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO rfq_quotes (
          quoteId, kind, taker, maker, makerName, seriesId, tierKind,
          underlying, direction, isUp, lowerStrike, upperStrike, expiry,
          stakeUsdt, protocolFeeUsdt, maxPayoutUsdt, buybackUsdt, nonce,
          competingQuotesJson, hedgePlanJson, status, createdAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        q.quoteId,
        q.kind,
        q.taker.toLowerCase(),
        q.maker.toLowerCase(),
        q.makerName,
        q.seriesId.toLowerCase(),
        q.tierKind,
        q.underlying,
        q.direction,
        q.isUp,
        q.lowerStrike,
        q.upperStrike,
        q.expiry,
        q.stakeUsdt,
        q.protocolFeeUsdt,
        q.maxPayoutUsdt,
        q.buybackUsdt,
        q.nonce,
        q.competingQuotesJson,
        q.hedgePlanJson,
        q.status,
        q.createdAt
      );
  }

  async findQuoteByMakerNonce(
    maker: string,
    nonce: string
  ): Promise<StoredRfqQuote | undefined> {
    return this.db
      .prepare(
        `SELECT * FROM rfq_quotes WHERE maker = ? AND nonce = ? ORDER BY createdAt DESC LIMIT 1`
      )
      .get(maker.toLowerCase(), nonce) as StoredRfqQuote | undefined;
  }

  async markQuoteFilled(quoteId: string): Promise<void> {
    this.db
      .prepare(`UPDATE rfq_quotes SET status = 'FILLED' WHERE quoteId = ?`)
      .run(quoteId);
  }

  async upsertTicketOnOpen(input: UpsertTicketOpenInput): Promise<void> {
    const sid = input.seriesId.toLowerCase();
    const taker = input.taker.toLowerCase();
    const isUp = input.isUp ? 1 : 0;
    const existing = this.db
      .prepare(
        `SELECT * FROM tickets WHERE seriesId = ? AND isUp = ? AND taker = ?`
      )
      .get(sid, isUp, taker) as StoredTicket | undefined;

    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO tickets (
            seriesId, isUp, taker, originalMaker, tierKind, underlying, direction,
            lowerStrike, upperStrike, expiry, initialMaxPayout,
            remainingBalance, closedBalance, totalStakeUsdt, protocolFeeUsdt,
            earlyCloseProceedsUsdt, redeemedUsdt, status, openTxHash, createdAt, updatedAt
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0, 0, 'ACTIVE', ?, ?, ?)`
        )
        .run(
          sid,
          isUp,
          taker,
          input.maker.toLowerCase(),
          input.tierKind,
          input.underlying,
          input.direction,
          input.lowerStrike,
          input.upperStrike,
          input.expiry,
          input.maxPayout,
          input.maxPayout,
          input.stakeUsdt,
          input.protocolFeeUsdt,
          input.openTxHash,
          input.timestamp,
          input.timestamp
        );
    } else {
      this.db
        .prepare(
          `UPDATE tickets SET
            initialMaxPayout = initialMaxPayout + ?,
            remainingBalance = remainingBalance + ?,
            totalStakeUsdt = totalStakeUsdt + ?,
            protocolFeeUsdt = protocolFeeUsdt + ?,
            status = 'ACTIVE',
            openTxHash = ?,
            updatedAt = ?
          WHERE seriesId = ? AND isUp = ? AND taker = ?`
        )
        .run(
          input.maxPayout,
          input.maxPayout,
          input.stakeUsdt,
          input.protocolFeeUsdt,
          input.openTxHash,
          input.timestamp,
          sid,
          isUp,
          taker
        );
    }
  }

  async updateTicketOnClose(input: UpdateTicketCloseInput): Promise<void> {
    const sid = input.seriesId.toLowerCase();
    const taker = input.taker.toLowerCase();
    const isUp = input.isUp ? 1 : 0;
    const existing = this.db
      .prepare(
        `SELECT * FROM tickets WHERE seriesId = ? AND isUp = ? AND taker = ?`
      )
      .get(sid, isUp, taker) as StoredTicket | undefined;
    if (!existing) return;

    const newRemaining = Math.max(
      0,
      existing.remainingBalance - input.closedAmount
    );
    const newStatus = newRemaining <= 1e-6 ? "CLOSED_EARLY" : existing.status;
    this.db
      .prepare(
        `UPDATE tickets SET
          remainingBalance = ?,
          closedBalance = closedBalance + ?,
          earlyCloseProceedsUsdt = earlyCloseProceedsUsdt + ?,
          status = ?,
          closeTxHash = COALESCE(NULLIF(?, ''), closeTxHash),
          updatedAt = ?
        WHERE seriesId = ? AND isUp = ? AND taker = ?`
      )
      .run(
        newRemaining,
        input.closedAmount,
        input.buybackNetUsdt,
        newStatus,
        input.txHash ?? "",
        input.timestamp,
        sid,
        isUp,
        taker
      );
  }

  async updateTicketOnMerge(input: UpdateTicketMergeInput): Promise<void> {
    if (input.mergedAmount <= 0) return;
    const sid = input.seriesId.toLowerCase();
    const account = input.account.toLowerCase();
    const rows = this.db
      .prepare(`SELECT * FROM tickets WHERE seriesId = ? AND taker = ?`)
      .all(sid, account) as unknown as StoredTicket[];
    if (rows.length === 0) return;

    const upRow = rows.find((r) => Boolean(r.isUp));
    const downRow = rows.find((r) => !Boolean(r.isUp));
    const { upProceeds, downProceeds } = computeMergeProceedsSplit(
      upRow,
      downRow,
      input.mergedAmount
    );

    const stmt = this.db.prepare(
      `UPDATE tickets SET
        remainingBalance = ?,
        closedBalance = closedBalance + ?,
        earlyCloseProceedsUsdt = earlyCloseProceedsUsdt + ?,
        status = ?,
        closeTxHash = COALESCE(NULLIF(?, ''), closeTxHash),
        updatedAt = ?
      WHERE seriesId = ? AND isUp = ? AND taker = ?`
    );

    for (const [row, proceeds] of [
      [upRow, upProceeds],
      [downRow, downProceeds],
    ] as const) {
      if (!row) continue;
      const newRemaining = Math.max(
        0,
        row.remainingBalance - input.mergedAmount
      );
      const newStatus = newRemaining <= 1e-6 ? "CLOSED_EARLY" : row.status;
      stmt.run(
        newRemaining,
        input.mergedAmount,
        proceeds,
        newStatus,
        input.txHash ?? "",
        input.timestamp,
        sid,
        row.isUp ? 1 : 0,
        account
      );
    }
  }

  async recordSettlement(input: RecordSettlementInput): Promise<void> {
    const existing = await this.getSettlement(input.underlying, input.expiry);
    const resolvedSource: SettlementSource =
      input.source && input.source !== "ONCHAIN_SYNCED"
        ? input.source
        : existing?.source ?? input.source ?? "ONCHAIN_SYNCED";
    const resolvedFeedId =
      input.feedId !== undefined ? input.feedId : existing?.feedId ?? null;
    const resolvedFeedIdHex =
      input.feedIdHex !== undefined
        ? input.feedIdHex
        : existing?.feedIdHex ?? null;
    const resolvedOracleTs =
      input.oracleTimestamp !== undefined
        ? input.oracleTimestamp
        : existing?.oracleTimestamp ?? null;
    const resolvedSubmitter =
      input.submitter !== undefined
        ? input.submitter
        : existing?.submitter ?? null;
    const resolvedSampleCount =
      input.sampleCount !== undefined
        ? input.sampleCount
        : existing?.sampleCount ?? null;
    const resolvedIsManualOverride =
      input.isManualOverride !== undefined
        ? input.isManualOverride
        : existing?.isManualOverride ?? false;
    const resolvedOverrideReason =
      input.overrideReason !== undefined
        ? input.overrideReason
        : existing?.overrideReason ?? null;

    this.db
      .prepare(
        `INSERT OR REPLACE INTO settlements (
          underlying, expiry, settlementPrice, txHash, settledAt,
          source, feedId, feedIdHex, oracleTimestamp, submitter,
          sampleCount, isManualOverride, overrideReason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.underlying,
        input.expiry,
        input.settlementPrice,
        input.txHash,
        input.settledAt,
        resolvedSource,
        resolvedFeedId,
        resolvedFeedIdHex,
        resolvedOracleTs,
        resolvedSubmitter,
        resolvedSampleCount,
        resolvedIsManualOverride ? 1 : 0,
        resolvedOverrideReason
      );

    this.db
      .prepare(
        `UPDATE tickets SET status = 'SETTLED_CLAIMABLE', updatedAt = ?
         WHERE underlying = ? AND expiry = ? AND remainingBalance > 1e-6 AND status = 'ACTIVE'`
      )
      .run(input.settledAt, input.underlying, input.expiry);
  }

  async updateTicketOnRedeem(input: UpdateTicketRedeemInput): Promise<void> {
    if (input.burnedAmount <= 0) return;
    const sid = input.seriesId.toLowerCase();
    const taker = input.account.toLowerCase();
    const isUp = input.isUp ? 1 : 0;
    this.db
      .prepare(
        `UPDATE tickets SET
          remainingBalance = 0,
          redeemedUsdt = redeemedUsdt + ?,
          status = 'SETTLED_CLAIMED',
          redeemTxHash = COALESCE(NULLIF(?, ''), redeemTxHash),
          updatedAt = ?
        WHERE seriesId = ? AND isUp = ? AND taker = ?`
      )
      .run(
        input.payoutUsdt,
        input.txHash ?? "",
        input.timestamp,
        sid,
        isUp,
        taker
      );
  }

  async insertHedgeLedger(entry: Omit<HedgeLedgerEntry, "id">): Promise<void> {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO hedge_ledger (
          txHash, action, seriesId, underlying, direction,
          lowerStrike, upperStrike, makerName, venue, hedgeRoute,
          isParityFlip, longLegInstId, shortLegInstId, notionalUnderlying,
          rawExchangeCostUsd, exchangeFeeUsd, paritySavedUsd,
          userCashflowUsd, protocolFeeUsd, mmNetMarginUsd,
          capitalUnlockedUsdt, executionMode, createdAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        entry.txHash,
        entry.action,
        entry.seriesId.toLowerCase(),
        entry.underlying,
        entry.direction,
        entry.lowerStrike,
        entry.upperStrike,
        entry.makerName,
        entry.venue,
        entry.hedgeRoute,
        entry.isParityFlip ? 1 : 0,
        entry.longLegInstId,
        entry.shortLegInstId,
        entry.notionalUnderlying,
        entry.rawExchangeCostUsd,
        entry.exchangeFeeUsd,
        entry.paritySavedUsd,
        entry.userCashflowUsd,
        entry.protocolFeeUsd,
        entry.mmNetMarginUsd,
        entry.capitalUnlockedUsdt,
        entry.executionMode,
        entry.createdAt
      );
  }

  async getTicketsByTaker(taker: string): Promise<StoredTicket[]> {
    return this.db
      .prepare(
        `SELECT * FROM tickets WHERE taker = ? ORDER BY createdAt DESC`
      )
      .all(taker.toLowerCase()) as unknown as StoredTicket[];
  }

  async getSeriesTicketMeta(
    seriesId: string
  ): Promise<SeriesTicketMeta | undefined> {
    const row = this.db
      .prepare(
        `SELECT underlying, lowerStrike, upperStrike FROM tickets WHERE seriesId = ? LIMIT 1`
      )
      .get(seriesId.toLowerCase()) as SeriesTicketMeta | undefined;
    return row;
  }

  async getAllTickets(): Promise<StoredTicket[]> {
    return this.db
      .prepare(`SELECT * FROM tickets ORDER BY createdAt DESC`)
      .all() as unknown as StoredTicket[];
  }

  private mapSqliteSettlement(r: any): StoredSettlement {
    return {
      underlying: r.underlying,
      expiry: Number(r.expiry),
      settlementPrice: Number(r.settlementPrice),
      txHash: r.txHash,
      settledAt: Number(r.settledAt),
      source: r.source,
      feedId: r.feedId ?? null,
      feedIdHex: r.feedIdHex ?? null,
      oracleTimestamp:
        r.oracleTimestamp !== null && r.oracleTimestamp !== undefined
          ? Number(r.oracleTimestamp)
          : null,
      submitter: r.submitter ?? null,
      sampleCount:
        r.sampleCount !== null && r.sampleCount !== undefined
          ? Number(r.sampleCount)
          : null,
      isManualOverride: Boolean(Number(r.isManualOverride ?? 0)),
      overrideReason: r.overrideReason ?? null,
    };
  }

  async getSettlement(
    underlying: UnderlyingSymbol,
    expiry: number
  ): Promise<StoredSettlement | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM settlements WHERE underlying = ? AND expiry = ?`
      )
      .get(underlying, expiry);
    return row ? this.mapSqliteSettlement(row) : undefined;
  }

  async getAllSettlements(
    underlying?: UnderlyingSymbol,
    limit = 50
  ): Promise<StoredSettlement[]> {
    if (underlying) {
      const rows = this.db
        .prepare(
          `SELECT * FROM settlements WHERE underlying = ? ORDER BY expiry DESC LIMIT ?`
        )
        .all(underlying, limit);
      return rows.map((r) => this.mapSqliteSettlement(r));
    }
    const rows = this.db
      .prepare(`SELECT * FROM settlements ORDER BY expiry DESC LIMIT ?`)
      .all(limit);
    return rows.map((r) => this.mapSqliteSettlement(r));
  }

  async getHedgeLedger(limit = 50): Promise<HedgeLedgerEntry[]> {
    const rows = this.db
      .prepare(`SELECT * FROM hedge_ledger ORDER BY id DESC LIMIT ?`)
      .all(limit) as Array<
      Omit<HedgeLedgerEntry, "isParityFlip"> & { isParityFlip: number }
    >;
    return rows.map((r) => ({
      ...r,
      isParityFlip: Boolean(r.isParityFlip),
    }));
  }

  async getAllHedgeLedger(): Promise<HedgeLedgerEntry[]> {
    const rows = this.db
      .prepare(`SELECT * FROM hedge_ledger ORDER BY id DESC`)
      .all() as Array<
      Omit<HedgeLedgerEntry, "isParityFlip"> & { isParityFlip: number }
    >;
    return rows.map((r) => ({
      ...r,
      isParityFlip: Boolean(r.isParityFlip),
    }));
  }

  async getSyncState(key: string): Promise<string | undefined> {
    const row = this.db
      .prepare(`SELECT value FROM sync_state WHERE key = ?`)
      .get(key) as { value: string } | undefined;
    return row?.value;
  }

  async setSyncState(key: string, value: string): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO sync_state (key, value) VALUES (?, ?)`
      )
      .run(key, value);
  }

  async upsertTwapHealthSample(input: UpsertTwapHealthSampleInput): Promise<void> {
    const existing = this.db
      .prepare(
        `SELECT avgConsensusScore, minConsensusScore, tickCount FROM twap_health_samples
         WHERE underlying = ? AND expiry = ? AND sampleTs = ?`
      )
      .get(input.underlying, input.expiry, input.sampleTs) as
      | { avgConsensusScore: number; minConsensusScore: number; tickCount: number }
      | undefined;

    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO twap_health_samples (
            underlying, expiry, sampleTs, priceUsd,
            avgConsensusScore, minConsensusScore, consensusStatus, tickCount, observedAt
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`
        )
        .run(
          input.underlying,
          input.expiry,
          input.sampleTs,
          input.priceUsd,
          input.consensusScore,
          input.consensusScore,
          input.consensusStatus,
          input.observedAt
        );
    } else {
      const nextCount = existing.tickCount + 1;
      const nextAvg =
        (existing.avgConsensusScore * existing.tickCount + input.consensusScore) /
        nextCount;
      const nextMin = Math.min(existing.minConsensusScore, input.consensusScore);
      this.db
        .prepare(
          `UPDATE twap_health_samples SET
            priceUsd = ?,
            avgConsensusScore = ?,
            minConsensusScore = ?,
            consensusStatus = ?,
            tickCount = ?,
            observedAt = ?
           WHERE underlying = ? AND expiry = ? AND sampleTs = ?`
        )
        .run(
          input.priceUsd,
          nextAvg,
          nextMin,
          input.consensusStatus,
          nextCount,
          input.observedAt,
          input.underlying,
          input.expiry,
          input.sampleTs
        );
    }
  }

  async getTwapHealthSamples(
    underlying: UnderlyingSymbol,
    expiry: number
  ): Promise<TwapSampleObservation[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM twap_health_samples WHERE underlying = ? AND expiry = ? ORDER BY sampleTs ASC`
      )
      .all(underlying, expiry) as Array<Record<string, any>>;
    return rows.map((r) => ({
      underlying: r.underlying as UnderlyingSymbol,
      expiry: Number(r.expiry),
      sampleTs: Number(r.sampleTs),
      priceUsd: Number(r.priceUsd),
      avgConsensusScore: Number(r.avgConsensusScore),
      minConsensusScore: Number(r.minConsensusScore),
      consensusStatus: r.consensusStatus as AtlasConsensusStatus,
      tickCount: Number(r.tickCount),
      observedAt: Number(r.observedAt),
    }));
  }

  private mapSqliteWelcomeAirdrop(r: Record<string, any>): StoredWelcomeAirdrop {
    return {
      privyUserId: String(r.privyUserId),
      walletAddress: String(r.walletAddress),
      amountUsdt: Number(r.amountUsdt),
      txHash: String(r.txHash || ""),
      status: r.status as StoredWelcomeAirdrop["status"],
      createdAt: Number(r.createdAt),
      updatedAt: Number(r.updatedAt),
    };
  }

  async getWelcomeAirdropByUserId(
    privyUserId: string
  ): Promise<StoredWelcomeAirdrop | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM welcome_airdrops WHERE privyUserId = ?`)
      .get(privyUserId) as Record<string, any> | undefined;
    return row ? this.mapSqliteWelcomeAirdrop(row) : undefined;
  }

  async getWelcomeAirdropByWallet(
    walletAddress: string
  ): Promise<StoredWelcomeAirdrop | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM welcome_airdrops WHERE walletAddress = ?`)
      .get(walletAddress.toLowerCase()) as Record<string, any> | undefined;
    return row ? this.mapSqliteWelcomeAirdrop(row) : undefined;
  }

  async tryReserveWelcomeAirdrop(
    input: ReserveWelcomeAirdropInput
  ): Promise<{ reserved: boolean; existing?: StoredWelcomeAirdrop }> {
    const wallet = input.walletAddress.toLowerCase();
    const byUser = await this.getWelcomeAirdropByUserId(input.privyUserId);
    if (byUser) {
      if (byUser.status !== "FAILED") {
        return { reserved: false, existing: byUser };
      }
      const byWallet = await this.getWelcomeAirdropByWallet(wallet);
      if (byWallet && byWallet.privyUserId !== input.privyUserId) {
        return { reserved: false, existing: byWallet };
      }
      const res = this.db
        .prepare(
          `UPDATE welcome_airdrops
           SET walletAddress = ?, amountUsdt = ?, txHash = '', status = 'PENDING', updatedAt = ?
           WHERE privyUserId = ? AND status = 'FAILED'`
        )
        .run(wallet, input.amountUsdt, input.timestamp, input.privyUserId);
      if (Number(res.changes) > 0) {
        return { reserved: true };
      }
      return {
        reserved: false,
        existing: await this.getWelcomeAirdropByUserId(input.privyUserId),
      };
    }

    const byWallet = await this.getWelcomeAirdropByWallet(wallet);
    if (byWallet) {
      return { reserved: false, existing: byWallet };
    }

    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO welcome_airdrops (
          privyUserId, walletAddress, amountUsdt, txHash, status, createdAt, updatedAt
        ) VALUES (?, ?, ?, '', 'PENDING', ?, ?)`
      )
      .run(
        input.privyUserId,
        wallet,
        input.amountUsdt,
        input.timestamp,
        input.timestamp
      );
    if (Number(res.changes) > 0) {
      return { reserved: true };
    }
    const existing =
      (await this.getWelcomeAirdropByUserId(input.privyUserId)) ??
      (await this.getWelcomeAirdropByWallet(wallet));
    return { reserved: false, existing };
  }

  async completeWelcomeAirdrop(input: {
    privyUserId: string;
    txHash: string;
    timestamp: number;
  }): Promise<void> {
    this.db
      .prepare(
        `UPDATE welcome_airdrops
         SET status = 'COMPLETED', txHash = ?, updatedAt = ?
         WHERE privyUserId = ?`
      )
      .run(input.txHash, input.timestamp, input.privyUserId);
  }

  async failWelcomeAirdrop(input: {
    privyUserId: string;
    timestamp: number;
  }): Promise<void> {
    this.db
      .prepare(
        `UPDATE welcome_airdrops
         SET status = 'FAILED', updatedAt = ?
         WHERE privyUserId = ? AND status = 'PENDING'`
      )
      .run(input.timestamp, input.privyUserId);
  }
}

export async function createPayoffDatabase(opts: {
  databaseUrl?: string;
  dbPath: string;
}): Promise<PayoffDatabase> {
  const store: PayoffDatabase = opts.databaseUrl
    ? new PostgresDatabase(opts.databaseUrl)
    : new SqliteDatabase(opts.dbPath);
  await store.init();
  return store;
}

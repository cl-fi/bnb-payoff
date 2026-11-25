import { estimatePositionExitUsdt } from "@payoff/mock-maker";
import {
  MIN_CLOSE_LEAD_TIME_SEC,
  SETTLEMENT_DELAY_SEC,
  computeExpiryPayoffUsdt,
  computeTokenId,
  symbolToAssetId,
  type PositionView,
  type UnderlyingSymbol,
} from "@payoff/shared";
import type { PayoffDatabase, StoredTicket } from "../db/database.js";
import type {
  ChainService,
  OnChainActivePosition,
} from "./chainService.js";
import type { MarketDataService } from "./marketData.js";

const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as const;

function positionKey(seriesId: string, isUp: boolean | number): string {
  return `${seriesId.toLowerCase()}:${isUp ? 1 : 0}`;
}

export class PositionsService {
  constructor(
    private db: PayoffDatabase,
    private marketData: MarketDataService,
    private chain: ChainService
  ) {}

  async getPositionsForAddress(address: string): Promise<PositionView[]> {
    const addrLower = address.toLowerCase();
    const [onChainActive, dbTickets, effNow] = await Promise.all([
      this.chain.getUserActivePositionsOnChain(address as `0x${string}`),
      this.db.getTicketsByTaker(addrLower),
      this.chain.getEffectiveNow(),
    ]);

    const dbByKey = new Map<string, StoredTicket>();
    for (const t of dbTickets) {
      dbByKey.set(positionKey(t.seriesId, t.isUp), t);
    }

    const result: PositionView[] = [];
    const seenKeys = new Set<string>();
    const pausedCache = new Map<string, boolean>();
    const checkExpiryPaused = async (
      underlying: UnderlyingSymbol,
      expiry: number
    ): Promise<boolean> => {
      const k = `${underlying}:${expiry}`;
      if (pausedCache.has(k)) return pausedCache.get(k)!;
      const paused = await this.chain.isExpiryPausedOnChain(underlying, expiry);
      pausedCache.set(k, paused);
      return paused;
    };

    // 1. Authoritative active / settled-claimable UP & DOWN positions directly from PayoffSpreadVault
    if (onChainActive !== null) {
      for (const oc of onChainActive) {
        const key = positionKey(oc.seriesId, oc.isUp);
        seenKeys.add(key);
        const dbRow = dbByKey.get(key);
        result.push(
          await this.buildPositionFromOnChain(
            addrLower,
            oc,
            dbRow,
            effNow,
            checkExpiryPaused
          )
        );
      }
    }

    // 2. Historical closed / redeemed tickets from DB (or all DB rows if offline/unit test)
    for (const t of dbTickets) {
      const key = positionKey(t.seriesId, t.isUp);
      if (seenKeys.has(key)) continue;

      // Skip stale DB ACTIVE / SETTLED_CLAIMABLE rows when on-chain reader confirms zero balance
      if (
        onChainActive !== null &&
        (t.status === "ACTIVE" || t.status === "SETTLED_CLAIMABLE")
      ) {
        continue;
      }

      result.push(await this.buildPositionFromDb(t, effNow, checkExpiryPaused));
    }

    result.sort((a, b) => b.createdAt - a.createdAt);
    return result;
  }

  private async buildPositionFromOnChain(
    takerLower: string,
    oc: OnChainActivePosition,
    dbRow: StoredTicket | undefined,
    effNow: number,
    checkExpiryPaused: (
      underlying: UnderlyingSymbol,
      expiry: number
    ) => Promise<boolean>
  ): Promise<PositionView> {
    const snap = this.marketData.getSnapshot(oc.underlying);
    const dbSettlement = await this.db.getSettlement(oc.underlying, oc.expiry);
    const settled = oc.settled || Boolean(dbSettlement);
    const settlementPrice = oc.settled
      ? oc.settlementPrice
      : dbSettlement?.settlementPrice;

    const inTwapWindow =
      !settled &&
      effNow < oc.expiry &&
      oc.expiry - effNow <= MIN_CLOSE_LEAD_TIME_SEC;
    const awaitingSettlement = !settled && effNow >= oc.expiry;
    const expiryPaused =
      inTwapWindow || awaitingSettlement
        ? await checkExpiryPaused(oc.underlying, oc.expiry)
        : false;
    const canPermissionlessSettle =
      awaitingSettlement &&
      !expiryPaused &&
      effNow >= oc.expiry + SETTLEMENT_DELAY_SEC;

    const hoursRemaining = Math.max(0.25, (oc.expiry - effNow) / 3600);
    const book =
      hoursRemaining > 42 && snap.weekly ? snap.weekly : snap.daily!;

    const closedBalance = dbRow?.closedBalance ?? 0;
    const initialMaxPayout = Math.max(
      oc.balanceUsdt + closedBalance,
      dbRow?.initialMaxPayout ?? oc.balanceUsdt
    );
    const totalStakeUsdt = dbRow?.totalStakeUsdt ?? 0;
    const remainingCost =
      initialMaxPayout > 0 && totalStakeUsdt > 0
        ? totalStakeUsdt * Math.min(1, oc.balanceUsdt / initialMaxPayout)
        : 0;
    const earlyCloseProceedsUsdt = dbRow?.earlyCloseProceedsUsdt ?? 0;
    const redeemedUsdt = dbRow?.redeemedUsdt ?? 0;
    const protocolFeeUsdt = dbRow?.protocolFeeUsdt ?? 0;

    const width = oc.upperStrike - oc.lowerStrike;
    const ratioNeeded =
      oc.balanceUsdt > 0 && remainingCost > 0
        ? Math.min(1, remainingCost / oc.balanceUsdt)
        : 0.5;
    const breakevenPrice = oc.isUp
      ? oc.lowerStrike + width * ratioNeeded
      : oc.upperStrike - width * ratioNeeded;

    const flatPayoutUsdt = computeExpiryPayoffUsdt(
      oc.isUp,
      oc.lowerStrike,
      oc.upperStrike,
      oc.balanceUsdt,
      snap.spot
    );

    const status = settled ? "SETTLED_CLAIMABLE" : "ACTIVE";

    let indicativeExitUsdt = 0;
    if (status === "ACTIVE" && !awaitingSettlement && oc.balanceUsdt > 0) {
      const est = estimatePositionExitUsdt({
        book,
        isCall: oc.isUp,
        lowerStrike: oc.lowerStrike,
        upperStrike: oc.upperStrike,
        remainingLongUsdt: oc.balanceUsdt,
        hoursRemaining,
        atlasTelemetry: snap.atlasTelemetry,
      });
      indicativeExitUsdt = est.bestBidUsdt;
    }

    let claimableUsdt = oc.claimableUsdt;
    if (
      settled &&
      claimableUsdt === 0 &&
      settlementPrice &&
      oc.balanceUsdt > 0
    ) {
      claimableUsdt = computeExpiryPayoffUsdt(
        oc.isUp,
        oc.lowerStrike,
        oc.upperStrike,
        oc.balanceUsdt,
        settlementPrice
      );
    }

    const realizedPlusUnrealized =
      earlyCloseProceedsUsdt +
      redeemedUsdt +
      (status === "SETTLED_CLAIMABLE" ? claimableUsdt : indicativeExitUsdt);
    const unrealizedPnlUsdt =
      totalStakeUsdt > 0 ? realizedPlusUnrealized - totalStakeUsdt : 0;
    const unrealizedPnlPct =
      totalStakeUsdt > 0 ? (unrealizedPnlUsdt / totalStakeUsdt) * 100 : 0;

    const indicativeExitPct =
      remainingCost > 0
        ? ((indicativeExitUsdt - remainingCost) / remainingCost) * 100
        : 0;

    return {
      tokenId: oc.tokenId,
      seriesId: oc.seriesId,
      assetId: oc.assetId,
      taker: takerLower as `0x${string}`,
      originalMaker: (dbRow?.originalMaker || ZERO_ADDR) as `0x${string}`,
      tierKind: dbRow?.tierKind ?? "CUSTOM",
      underlying: oc.underlying,
      direction: oc.direction,
      isUp: oc.isUp,
      lowerStrike: oc.lowerStrike,
      upperStrike: oc.upperStrike,
      startPrice: oc.isUp ? oc.lowerStrike : oc.upperStrike,
      capPrice: oc.isUp ? oc.upperStrike : oc.lowerStrike,
      expiry: oc.expiry,
      expiryIso: new Date(oc.expiry * 1000).toISOString(),
      initialMaxPayoutUsdt: Number(initialMaxPayout.toFixed(2)),
      remainingBalanceUsdt: Number(oc.balanceUsdt.toFixed(2)),
      closedBalanceUsdt: Number(closedBalance.toFixed(2)),
      totalStakeUsdt: Number(totalStakeUsdt.toFixed(2)),
      protocolFeeUsdt: Number(protocolFeeUsdt.toFixed(2)),
      earlyCloseProceedsUsdt: Number(earlyCloseProceedsUsdt.toFixed(2)),
      redeemedUsdt: Number(redeemedUsdt.toFixed(2)),
      status,
      breakevenPrice: Number(breakevenPrice.toFixed(2)),
      flatPayoutUsdt: Number(flatPayoutUsdt.toFixed(2)),
      indicativeExitUsdt: Number(indicativeExitUsdt.toFixed(2)),
      indicativeExitPct: Number(indicativeExitPct.toFixed(1)),
      unrealizedPnlUsdt: Number(unrealizedPnlUsdt.toFixed(2)),
      unrealizedPnlPct: Number(unrealizedPnlPct.toFixed(1)),
      settlementPrice,
      claimableUsdt: Number(claimableUsdt.toFixed(2)),
      inTwapWindow,
      awaitingSettlement,
      expiryPaused,
      canPermissionlessSettle,
      openTxHash: dbRow?.openTxHash ?? "",
      createdAt: dbRow?.createdAt ?? effNow,
    };
  }

  private async buildPositionFromDb(
    t: StoredTicket,
    effNow: number,
    checkExpiryPaused: (
      underlying: UnderlyingSymbol,
      expiry: number
    ) => Promise<boolean>
  ): Promise<PositionView> {
    const isUp = Boolean(t.isUp);
    const snap = this.marketData.getSnapshot(t.underlying);
    const settlement = await this.db.getSettlement(t.underlying, t.expiry);
    const settled = Boolean(settlement) || t.status === "SETTLED_CLAIMABLE" || t.status === "SETTLED_CLAIMED";
    const inTwapWindow =
      !settled &&
      t.status === "ACTIVE" &&
      effNow < t.expiry &&
      t.expiry - effNow <= MIN_CLOSE_LEAD_TIME_SEC;
    const awaitingSettlement =
      !settled && t.status === "ACTIVE" && effNow >= t.expiry;
    const expiryPaused =
      inTwapWindow || awaitingSettlement
        ? await checkExpiryPaused(t.underlying, t.expiry)
        : false;
    const canPermissionlessSettle =
      awaitingSettlement &&
      !expiryPaused &&
      effNow >= t.expiry + SETTLEMENT_DELAY_SEC;

    const hoursRemaining = Math.max(0.25, (t.expiry - effNow) / 3600);
    const book =
      hoursRemaining > 42 && snap.weekly ? snap.weekly : snap.daily!;

    const width = t.upperStrike - t.lowerStrike;
    const ratioNeeded =
      t.initialMaxPayout > 0
        ? Math.min(1, t.totalStakeUsdt / t.initialMaxPayout)
        : 1;
    const breakevenPrice = isUp
      ? t.lowerStrike + width * ratioNeeded
      : t.upperStrike - width * ratioNeeded;

    const flatPayoutUsdt = computeExpiryPayoffUsdt(
      isUp,
      t.lowerStrike,
      t.upperStrike,
      t.initialMaxPayout,
      snap.spot
    );

    let indicativeExitUsdt = 0;
    if (t.status === "ACTIVE" && !awaitingSettlement && t.remainingBalance > 0) {
      const est = estimatePositionExitUsdt({
        book,
        isCall: isUp,
        lowerStrike: t.lowerStrike,
        upperStrike: t.upperStrike,
        remainingLongUsdt: t.remainingBalance,
        hoursRemaining,
        atlasTelemetry: snap.atlasTelemetry,
      });
      indicativeExitUsdt = est.bestBidUsdt;
    }

    let claimableUsdt = 0;
    if (settlement && t.remainingBalance > 0) {
      claimableUsdt = computeExpiryPayoffUsdt(
        isUp,
        t.lowerStrike,
        t.upperStrike,
        t.remainingBalance,
        settlement.settlementPrice
      );
    }

    const realizedPlusUnrealized =
      t.earlyCloseProceedsUsdt +
      t.redeemedUsdt +
      (t.status === "SETTLED_CLAIMABLE" ? claimableUsdt : indicativeExitUsdt);
    const unrealizedPnlUsdt = realizedPlusUnrealized - t.totalStakeUsdt;
    const unrealizedPnlPct =
      t.totalStakeUsdt > 0
        ? (unrealizedPnlUsdt / t.totalStakeUsdt) * 100
        : 0;

    const remainingStakeRatio =
      t.initialMaxPayout > 0 ? t.remainingBalance / t.initialMaxPayout : 0;
    const remainingCost = t.totalStakeUsdt * remainingStakeRatio;
    const indicativeExitPct =
      remainingCost > 0
        ? ((indicativeExitUsdt - remainingCost) / remainingCost) * 100
        : 0;

    const sidHex = t.seriesId as `0x${string}`;
    return {
      tokenId: computeTokenId(sidHex, isUp).toString(),
      seriesId: sidHex,
      assetId: symbolToAssetId(t.underlying),
      taker: t.taker as `0x${string}`,
      originalMaker: t.originalMaker as `0x${string}`,
      tierKind: t.tierKind,
      underlying: t.underlying,
      direction: t.direction,
      isUp,
      lowerStrike: t.lowerStrike,
      upperStrike: t.upperStrike,
      startPrice: isUp ? t.lowerStrike : t.upperStrike,
      capPrice: isUp ? t.upperStrike : t.lowerStrike,
      expiry: t.expiry,
      expiryIso: new Date(t.expiry * 1000).toISOString(),
      initialMaxPayoutUsdt: Number(t.initialMaxPayout.toFixed(2)),
      remainingBalanceUsdt: Number(t.remainingBalance.toFixed(2)),
      closedBalanceUsdt: Number(t.closedBalance.toFixed(2)),
      totalStakeUsdt: Number(t.totalStakeUsdt.toFixed(2)),
      protocolFeeUsdt: Number(t.protocolFeeUsdt.toFixed(2)),
      earlyCloseProceedsUsdt: Number(t.earlyCloseProceedsUsdt.toFixed(2)),
      redeemedUsdt: Number(t.redeemedUsdt.toFixed(2)),
      status: t.status,
      breakevenPrice: Number(breakevenPrice.toFixed(2)),
      flatPayoutUsdt: Number(flatPayoutUsdt.toFixed(2)),
      indicativeExitUsdt: Number(indicativeExitUsdt.toFixed(2)),
      indicativeExitPct: Number(indicativeExitPct.toFixed(1)),
      unrealizedPnlUsdt: Number(unrealizedPnlUsdt.toFixed(2)),
      unrealizedPnlPct: Number(unrealizedPnlPct.toFixed(1)),
      settlementPrice: settlement?.settlementPrice,
      claimableUsdt: Number(claimableUsdt.toFixed(2)),
      inTwapWindow,
      awaitingSettlement,
      expiryPaused,
      canPermissionlessSettle,
      openTxHash: t.openTxHash,
      createdAt: t.createdAt,
    };
  }
}

import type { Phase1Metrics, TierKind } from "@payoff/shared";
import type { PayoffDatabase } from "../db/database.js";
import type { ChainService } from "./chainService.js";

export class MetricsService {
  constructor(
    private db: PayoffDatabase,
    private chain: ChainService
  ) {}

  async computePhase1Metrics(): Promise<Phase1Metrics> {
    const [tickets, ledger, health] = await Promise.all([
      this.db.getAllTickets(),
      this.db.getAllHedgeLedger(),
      this.chain.getVaultHealth(),
    ]);

    const openLedger = ledger.filter((l) => l.action === "OPEN");
    const closeLedger = ledger.filter((l) => l.action === "CLOSE");

    // 1. Order volume & repeat buyer metrics
    const totalOrders = Math.max(tickets.length, openLedger.length);
    const buyerCounts = new Map<string, number>();
    for (const t of tickets) {
      buyerCounts.set(t.taker, (buyerCounts.get(t.taker) ?? 0) + 1);
    }
    const uniqueBuyers = buyerCounts.size;
    const repeatBuyers = Array.from(buyerCounts.values()).filter(
      (c) => c >= 2
    ).length;
    const repeatPurchaseRatePct =
      uniqueBuyers > 0 ? (repeatBuyers / uniqueBuyers) * 100 : 0;
    const totalVolumeUsdt = tickets.reduce((s, t) => s + t.totalStakeUsdt, 0);

    // 2. Shelf tier vs custom range distribution
    const tierDistribution: Record<TierKind, number> = {
      CONSERVATIVE: 0,
      STANDARD: 0,
      BREAKOUT: 0,
      CUSTOM: 0,
    };
    for (const t of tickets) {
      tierDistribution[t.tierKind] = (tierDistribution[t.tierKind] ?? 0) + 1;
    }
    const customRangeOrders = tierDistribution.CUSTOM;
    const defaultShelfOrders = tickets.length - customRangeOrders;
    const defaultShelfSharePct =
      tickets.length > 0 ? (defaultShelfOrders / tickets.length) * 100 : 0;

    // 3. Early close & atomic merge unlock capital efficiency
    const earlyClosedTickets = tickets.filter(
      (t) => t.closedBalance > 0
    ).length;
    const earlyCloseRatePct =
      tickets.length > 0 ? (earlyClosedTickets / tickets.length) * 100 : 0;
    const atomicMergeUnlocks = closeLedger.filter(
      (l) => l.executionMode === "ATOMIC_MERGE_UNLOCK"
    ).length;
    const externalTakeovers = closeLedger.filter(
      (l) => l.executionMode === "EXTERNAL_TAKEOVER"
    ).length;
    const totalCapitalUnlockedUsdt = closeLedger.reduce(
      (s, l) => s + l.capitalUnlockedUsdt,
      0
    );
    const totalInitialLocked = tickets.reduce(
      (s, t) => s + t.initialMaxPayout,
      0
    );
    const capitalTurnoverBoostPct =
      totalInitialLocked > 0
        ? (totalCapitalUnlockedUsdt / totalInitialLocked) * 100
        : 0;

    // 4. Protocol & reference maker economics
    const totalProtocolFeeUsd = ledger.reduce(
      (s, l) => s + l.protocolFeeUsd,
      0
    );
    const totalExchangeFeeUsd = ledger.reduce(
      (s, l) => s + l.exchangeFeeUsd,
      0
    );
    const totalMmNetMarginUsd = ledger.reduce(
      (s, l) => s + l.mmNetMarginUsd,
      0
    );
    const avgNetMarginPerOrderUsd =
      openLedger.length > 0 ? totalMmNetMarginUsd / openLedger.length : 0;

    const avgProtocolFeeBps =
      totalVolumeUsdt > 0
        ? (tickets.reduce((s, t) => s + t.protocolFeeUsdt, 0) /
            Math.max(
              1e-6,
              totalVolumeUsdt -
                tickets.reduce((s, t) => s + t.protocolFeeUsdt, 0)
            )) *
          10_000
        : 400;

    const parityFlipCount = ledger.filter((l) => l.isParityFlip).length;
    const totalParitySavedUsd = ledger.reduce(
      (s, l) => s + l.paritySavedUsd,
      0
    );

    return {
      totalOrders,
      uniqueBuyers,
      repeatBuyers,
      repeatPurchaseRatePct: Number(repeatPurchaseRatePct.toFixed(1)),
      totalVolumeUsdt: Number(totalVolumeUsdt.toFixed(2)),
      defaultShelfOrders,
      customRangeOrders,
      defaultShelfSharePct: Number(defaultShelfSharePct.toFixed(1)),
      tierDistribution,
      earlyClosedTickets,
      earlyCloseRatePct: Number(earlyCloseRatePct.toFixed(1)),
      atomicMergeUnlocks,
      externalTakeovers,
      totalCapitalUnlockedUsdt: Number(totalCapitalUnlockedUsdt.toFixed(2)),
      capitalTurnoverBoostPct: Number(capitalTurnoverBoostPct.toFixed(1)),
      avgProtocolFeeBps: Math.round(avgProtocolFeeBps),
      totalProtocolFeeUsd: Number(totalProtocolFeeUsd.toFixed(2)),
      totalExchangeFeeUsd: Number(totalExchangeFeeUsd.toFixed(2)),
      totalMmNetMarginUsd: Number(totalMmNetMarginUsd.toFixed(2)),
      avgNetMarginPerOrderUsd: Number(avgNetMarginPerOrderUsd.toFixed(2)),
      parityFlipCount,
      totalParitySavedUsd: Number(totalParitySavedUsd.toFixed(2)),
      vaultBalanceUsdt: Number(health.usdtBalanceUsdt.toFixed(2)),
      vaultLockedUsdt: Number(health.lockedUsdt.toFixed(2)),
      vaultMakerMarginUsdt: Number(health.makerMarginUsdt.toFixed(2)),
      vaultAccruedProtocolFeesUsdt: Number(
        health.accruedProtocolFeesUsdt.toFixed(2)
      ),
      isVaultSolvent: health.isSolvent,
    };
  }
}

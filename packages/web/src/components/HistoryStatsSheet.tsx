import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronDown, ExternalLink, X } from "lucide-react";
import {
  ASSET_SPECS,
  BSC_TESTNET,
  computeRealizedHistoryEntry,
  type PositionView,
} from "@payoff/shared";
import { formatStrikePrice } from "../lib/format";
import type { Locale } from "../lib/i18n";
import { getExplorerBaseUrl } from "../lib/wallet";

export interface HistoryStatsSheetProps {
  open: boolean;
  locale: Locale;
  positions: PositionView[];
  chainId?: number;
  onClose: () => void;
}

type PositionWithOptionalTx = PositionView & {
  closeTxHash?: string;
  redeemTxHash?: string;
};

function positionKey(p: PositionView): string {
  return `${p.seriesId}:${p.isUp ? "UP" : "DOWN"}:${p.tokenId}`;
}

function formatShortDate(unixSec: number): string {
  if (!unixSec) return "--";
  const d = new Date(unixSec * 1000);
  if (Number.isNaN(d.getTime())) return "--";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}/${dd}`;
}

function formatSignedUsd(value: number): string {
  const sign = value >= 0 ? "+" : "−";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

export function HistoryStatsSheet({
  open,
  locale,
  positions,
  chainId = BSC_TESTNET.chainId,
  onClose,
}: HistoryStatsSheetProps) {
  const isZh = locale === "zh";
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  // Safari fallback for declarative <dialog closedby="any">
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) return;
    if ("closedBy" in HTMLDialogElement.prototype) return;

    const isOutside = (e: PointerEvent) => {
      const r = dialog.getBoundingClientRect();
      return (
        e.clientX < r.left ||
        e.clientX > r.right ||
        e.clientY < r.top ||
        e.clientY > r.bottom
      );
    };

    let pressedOutside = false;
    const onPointerDown = (e: PointerEvent) => {
      pressedOutside = isOutside(e);
    };
    const onPointerUp = (e: PointerEvent) => {
      if (pressedOutside && isOutside(e)) {
        dialog.close();
      }
      pressedOutside = false;
    };

    dialog.addEventListener("pointerdown", onPointerDown);
    dialog.addEventListener("pointerup", onPointerUp);
    return () => {
      dialog.removeEventListener("pointerdown", onPointerDown);
      dialog.removeEventListener("pointerup", onPointerUp);
    };
  }, [open]);

  const { items, cumulativeNetPnl, totalTrades, directionRightCount, partialRefundCount } =
    useMemo(() => {
      const finished = positions
        .flatMap((p) => {
          const metrics = computeRealizedHistoryEntry(p);
          if (!metrics) return [];
          const posExt = p as PositionWithOptionalTx;
          return [
            {
              pos: posExt,
              realizedStakeUsdt: metrics.realizedStakeUsdt,
              totalPayout: metrics.totalPayoutUsdt,
              netPnl: metrics.netPnlUsdt,
              maxPossible: metrics.maxPossibleUsdt,
              mult: metrics.mult,
              soldSharePct: metrics.soldSharePct,
              isPartialActiveClose: metrics.isPartialActiveClose,
              isClosedEarly: metrics.isClosedEarly,
              isDirectionRight: metrics.isDirectionRight,
              isPartialRefund: metrics.isPartialRefund,
              isBufferNotZero: metrics.isBufferNotZero,
            },
          ];
        })
        .sort(
          (a, b) =>
            b.pos.expiry - a.pos.expiry || b.pos.createdAt - a.pos.createdAt
        );

      const cumPnl = finished.reduce((sum, x) => sum + x.netPnl, 0);
      const rightCount = finished.filter((x) => x.isDirectionRight).length;
      const partialCount = finished.filter((x) => x.isPartialRefund).length;

      return {
        items: finished,
        cumulativeNetPnl: cumPnl,
        totalTrades: finished.length,
        directionRightCount: rightCount,
        partialRefundCount: partialCount,
      };
    }, [positions]);

  if (!open) return null;

  const explorerBase = getExplorerBaseUrl(chainId);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      {...({ closedby: "any" } as Record<string, unknown>)}
      onClose={() => {
        if (dialogRef.current) dialogRef.current.returnValue = "";
        setExpandedKey(null);
        onClose();
      }}
      className="payoff-sheet md:!w-[min(92vw,480px)] md:!max-w-[480px]"
    >
      <div className="flex max-h-[90dvh] flex-col md:max-h-[86dvh]">
        <div aria-hidden="true" className="payoff-sheet-handle" />

        <div className="overflow-y-auto px-5 pt-3 pb-6 sm:px-6 safe-pb space-y-4">
          {/* Header */}
          <div className="flex items-center justify-between gap-3">
            <h1
              id={titleId}
              className="text-[19px] font-bold tracking-[-0.02em] text-white"
            >
              {isZh ? "历史与战绩" : "History & Stats"}
            </h1>
            <button
              type="button"
              autoFocus
              aria-label={isZh ? "关闭" : "Close"}
              onClick={() => dialogRef.current?.close()}
              className="rounded-full p-1.5 text-[#7e8690] hover:bg-[#24282f] hover:text-white transition cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>

          {/* 3-Column Stats Cards */}
          <div className="grid grid-cols-[1.35fr_1fr_1fr] gap-2">
            <div className="rounded-2xl bg-black border border-[#1d2025] p-3">
              <div className="text-[11px] font-semibold text-[#7e8690]">
                {isZh ? "累计盈亏" : "Net PnL"}
              </div>
              <div
                className={`mt-1 text-xl font-bold tracking-[-0.025em] tabular-nums ${
                  totalTrades === 0
                    ? "text-white"
                    : cumulativeNetPnl >= 0
                      ? "text-[#2EC26B]"
                      : "text-[#E85D4A]"
                }`}
              >
                {totalTrades === 0 ? "$0.00" : formatSignedUsd(cumulativeNetPnl)}
              </div>
            </div>

            <div className="rounded-2xl bg-black border border-[#1d2025] p-3">
              <div className="text-[11px] font-semibold text-[#7e8690]">
                {isZh ? "总笔数" : "Total"}
              </div>
              <div className="mt-1 text-xl font-bold tracking-[-0.025em] text-white tabular-nums">
                {isZh ? `${totalTrades} 笔` : totalTrades}
              </div>
            </div>

            <div className="rounded-2xl bg-black border border-[#1d2025] p-3">
              <div className="text-[11px] font-semibold text-[#7e8690]">
                {isZh ? "方向猜对" : "Right calls"}
              </div>
              <div className="mt-1 text-xl font-bold tracking-[-0.025em] text-white tabular-nums">
                {isZh ? `${directionRightCount} 笔` : directionRightCount}
              </div>
            </div>
          </div>

          {/* Partial Refund Callout */}
          {directionRightCount > 0 && partialRefundCount > 0 && (
            <div className="rounded-[14px] bg-[#2EC26B]/13 px-3.5 py-2.5 text-xs leading-relaxed text-[#cbead7]">
              {isZh ? (
                <>
                  方向猜对的 <strong className="text-white">{directionRightCount}</strong>{" "}
                  笔里，有 <strong className="text-white">{partialRefundCount}</strong>{" "}
                  笔未到封顶也拿回了一部分。
                </>
              ) : (
                <>
                  Out of{" "}
                  <strong className="text-white">{directionRightCount}</strong>{" "}
                  right calls,{" "}
                  <strong className="text-white">{partialRefundCount}</strong>{" "}
                  still paid back without reaching the cap.
                </>
              )}
            </div>
          )}

          {/* Records Section */}
          <div>
            <div className="mb-1 text-[11.5px] font-bold tracking-[0.02em] text-[#7e8690]">
              {isZh ? "历史记录" : "Records"}
            </div>

            {items.length === 0 ? (
              <div className="rounded-2xl bg-[#15171b] border border-[#1d2025] px-4 py-8 text-center space-y-1.5">
                <div className="text-sm font-semibold text-white">
                  {isZh ? "暂无已结算或已平仓记录" : "No settled or closed trades yet"}
                </div>
                <p className="text-xs text-[#7e8690]">
                  {isZh
                    ? "完成一笔提前卖出或到期结算后，这里会自动统计你的战绩与链上凭证。"
                    : "Your cumulative PnL, right-direction count, and BscScan tx proofs will appear here."}
                </p>
              </div>
            ) : (
              <div className="divide-y divide-[#1d2025]">
                {items.map((entry) => {
                  const {
                    pos,
                    realizedStakeUsdt,
                    totalPayout,
                    netPnl,
                    mult,
                    soldSharePct,
                    isPartialActiveClose,
                    isClosedEarly,
                    isBufferNotZero,
                  } = entry;
                  const rowKey = positionKey(pos);
                  const isExpanded = expandedKey === rowKey;
                  const spec = ASSET_SPECS[pos.underlying];
                  const dirText = pos.isUp
                    ? isZh
                      ? "看涨"
                      : "Up"
                    : isZh
                      ? "看跌"
                      : "Down";
                  const dateText = formatShortDate(
                    pos.expiry || pos.createdAt
                  );

                  const statusLabel = isPartialActiveClose
                    ? isZh
                      ? `部分卖出 ${soldSharePct}%`
                      : `Sold ${soldSharePct}% early`
                    : isClosedEarly
                      ? isZh
                        ? "提前卖出"
                        : "Sold early"
                      : pos.status === "SETTLED_CLAIMABLE"
                        ? isZh
                          ? "待领取"
                          : "Claimable"
                        : totalPayout <= 0.005
                          ? isZh
                            ? "没中"
                            : "Missed"
                          : isZh
                            ? "已领取"
                            : "Claimed";

                  const metaParts = [dateText];
                  if (!isClosedEarly && pos.settlementPrice !== undefined) {
                    metaParts.push(
                      isZh
                        ? `结算价 ${formatStrikePrice(pos.settlementPrice, pos.underlying)}`
                        : `Settled ${formatStrikePrice(pos.settlementPrice, pos.underlying)}`
                    );
                  }
                  metaParts.push(statusLabel);

                  const txLinks: Array<{ label: string; hash: string }> = [];
                  if (pos.openTxHash) {
                    txLinks.push({
                      label: isZh ? "买入交易" : "Open tx",
                      hash: pos.openTxHash,
                    });
                  }
                  if (pos.closeTxHash) {
                    txLinks.push({
                      label: isZh ? "卖出交易" : "Close tx",
                      hash: pos.closeTxHash,
                    });
                  }
                  if (pos.redeemTxHash) {
                    txLinks.push({
                      label: isZh ? "领取交易" : "Redeem tx",
                      hash: pos.redeemTxHash,
                    });
                  }

                  return (
                    <div key={rowKey} className="py-3">
                      <button
                        type="button"
                        aria-expanded={isExpanded}
                        onClick={() =>
                          setExpandedKey(isExpanded ? null : rowKey)
                        }
                        className="flex w-full items-center justify-between gap-3 text-left cursor-pointer group focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white rounded-lg"
                      >
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-[14.5px] font-bold text-white tracking-[-0.01em] tabular-nums">
                              {spec.displaySymbol} {dirText}
                              {mult > 0 ? ` ${mult.toFixed(2)}x` : ""}
                            </span>
                            {isPartialActiveClose && (
                              <span className="rounded-full bg-[#24282f] px-2 py-0.5 text-[10px] font-bold text-[#b8bec6]">
                                {isZh ? "部分平仓" : "Partial exit"}
                              </span>
                            )}
                            {isBufferNotZero && (
                              <span className="rounded-full bg-[#E6BA5C]/12 px-2 py-0.5 text-[10px] font-bold text-[#E6BA5C]">
                                {isZh ? "没有归零" : "Partial"}
                              </span>
                            )}
                            {pos.status === "SETTLED_CLAIMABLE" && (
                              <span className="rounded-full bg-[#E6BA5C]/12 px-2 py-0.5 text-[10px] font-bold text-[#E6BA5C]">
                                {isZh ? "待领取" : "Claimable"}
                              </span>
                            )}
                          </div>
                          <div className="mt-0.5 text-xs text-[#7e8690] tabular-nums">
                            {metaParts.join(" · ")}
                          </div>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          <div className="text-right tabular-nums">
                            <div className="text-[15px] font-bold text-white tracking-[-0.02em]">
                              ${totalPayout.toFixed(2)}
                            </div>
                            <div
                              className={`text-xs font-semibold ${
                                netPnl > 0.005
                                  ? "text-[#2EC26B]"
                                  : netPnl < -0.005
                                    ? "text-[#E85D4A]"
                                    : "text-[#7e8690]"
                              }`}
                            >
                              {formatSignedUsd(netPnl)}
                            </div>
                          </div>
                          <ChevronDown
                            aria-hidden="true"
                            className={`h-4 w-4 text-[#7e8690] transition-transform ${
                              isExpanded ? "rotate-180 text-white" : ""
                            }`}
                          />
                        </div>
                      </button>

                      {isExpanded && (
                        <div className="mt-2.5 rounded-xl bg-[#15171b] border border-[#1d2025] p-3 space-y-2 text-xs">
                          <div className="grid grid-cols-2 gap-2 tabular-nums">
                            <div>
                              <span className="text-[#7e8690]">
                                {isZh ? "区间" : "Range"}
                              </span>
                              <div className="font-semibold text-white">
                                {formatStrikePrice(
                                  pos.startPrice,
                                  pos.underlying
                                )}{" "}
                                →{" "}
                                {formatStrikePrice(
                                  pos.capPrice,
                                  pos.underlying
                                )}
                              </div>
                            </div>
                            <div className="text-right">
                              <span className="text-[#7e8690]">
                                {isPartialActiveClose
                                  ? isZh
                                    ? "平仓成本"
                                    : "Sold stake"
                                  : isZh
                                    ? "投入本金"
                                    : "Stake"}
                              </span>
                              <div className="font-semibold text-white">
                                ${realizedStakeUsdt.toFixed(2)}
                              </div>
                            </div>
                          </div>

                          {explorerBase && txLinks.length > 0 && (
                            <div className="flex flex-wrap items-center gap-2 border-t border-[#1d2025] pt-2">
                              {txLinks.map((lnk) => (
                                <a
                                  key={`${lnk.label}-${lnk.hash}`}
                                  href={`${explorerBase}/tx/${lnk.hash}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="inline-flex items-center gap-1 rounded-full bg-[#24282f] px-2.5 py-1 text-[11px] font-semibold text-[#b8bec6] hover:text-white transition"
                                >
                                  <span>{lnk.label}</span>
                                  <ExternalLink
                                    className="h-3 w-3"
                                    aria-hidden="true"
                                  />
                                </a>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </dialog>
  );
}

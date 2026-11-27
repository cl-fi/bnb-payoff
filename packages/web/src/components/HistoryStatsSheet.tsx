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
import { PayoffRangeRuler } from "./PayoffRangeRuler";

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
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}/${dd} ${hh}:${mi}`;
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

  const {
    items,
    cumulativeNetPnl,
    cumulativeRoiPct,
    totalTrades,
    directionRightCount,
    partialRefundCount,
  } = useMemo(() => {
    const finished = positions
      .flatMap((p) => {
        const metrics = computeRealizedHistoryEntry(p);
        if (!metrics) return [];
        const posExt = p as PositionWithOptionalTx;
        const timestampSec = metrics.isClosedEarly
          ? p.updatedAt || p.createdAt
          : p.expiry || p.updatedAt || p.createdAt;
        return [
          {
            pos: posExt,
            timestampSec,
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
      .sort((a, b) => b.timestampSec - a.timestampSec);

    const cumPnl = finished.reduce((sum, x) => sum + x.netPnl, 0);
    const cumCost = finished.reduce((sum, x) => sum + x.realizedStakeUsdt, 0);
    const cumRoi = cumCost > 0 ? (cumPnl / cumCost) * 100 : 0;
    const rightCount = finished.filter((x) => x.isDirectionRight).length;
    const partialCount = finished.filter((x) => x.isPartialRefund).length;

    return {
      items: finished,
      cumulativeNetPnl: cumPnl,
      cumulativeRoiPct: cumRoi,
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

          {/* Minimal Hairline Stats Strip */}
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-t border-b border-[#1d2025] py-3 tabular-nums">
            <div className="flex items-baseline gap-2">
              <span className="text-xs font-medium text-[#7e8690]">
                {isZh ? "已实现" : "Realized"}
              </span>
              <span
                className={`text-lg font-bold tracking-[-0.025em] ${
                  totalTrades === 0
                    ? "text-white"
                    : cumulativeNetPnl >= 0
                      ? "text-[#2EC26B]"
                      : "text-[#E85D4A]"
                }`}
              >
                {totalTrades === 0 ? "$0.00" : formatSignedUsd(cumulativeNetPnl)}
              </span>
              {totalTrades > 0 && (
                <span
                  className={`text-xs font-semibold ${
                    cumulativeNetPnl >= 0 ? "text-[#2EC26B]" : "text-[#E85D4A]"
                  }`}
                >
                  ({cumulativeRoiPct >= 0 ? "+" : ""}
                  {cumulativeRoiPct.toFixed(1)}%)
                </span>
              )}
            </div>
            <span className="text-xs text-[#7e8690]">
              {totalTrades === 0
                ? isZh
                  ? "0 笔"
                  : "0 trades"
                : isZh
                  ? `${totalTrades} 笔 · 胜率 ${Math.round((directionRightCount / totalTrades) * 100)}%`
                  : `${totalTrades} ${totalTrades === 1 ? "trade" : "trades"} · ${Math.round((directionRightCount / totalTrades) * 100)}% win`}
            </span>
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
                    timestampSec,
                    realizedStakeUsdt,
                    totalPayout,
                    netPnl,
                    soldSharePct,
                    isPartialActiveClose,
                    isClosedEarly,
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
                  const dateText = formatShortDate(timestampSec);
                  const roiPct =
                    realizedStakeUsdt > 0
                      ? (netPnl / realizedStakeUsdt) * 100
                      : 0;

                  const statusLabel = isPartialActiveClose
                    ? isZh
                      ? `部分卖出 ${soldSharePct}%`
                      : `Sold ${soldSharePct}%`
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
                            ? "未入区"
                            : "Expired $0"
                          : isZh
                            ? "已领取"
                            : "Claimed";

                  const metaParts = [statusLabel, dateText];
                  const openPct = Math.max(1, 100 - soldSharePct);
                  const combinedPnl =
                    pos.earlyCloseProceedsUsdt +
                    pos.indicativeExitUsdt -
                    pos.totalStakeUsdt;
                  const combinedPct =
                    pos.totalStakeUsdt > 0
                      ? (combinedPnl / pos.totalStakeUsdt) * 100
                      : 0;

                  const txLinks: Array<{ label: string; hash: string }> = [];
                  if (pos.openTxHash) {
                    txLinks.push({
                      label: isZh ? "开仓 tx" : "Open tx",
                      hash: pos.openTxHash,
                    });
                  }
                  if (pos.closeTxHash) {
                    txLinks.push({
                      label: isZh ? "平仓 tx" : "Close tx",
                      hash: pos.closeTxHash,
                    });
                  }
                  if (pos.redeemTxHash) {
                    txLinks.push({
                      label: isZh ? "领取 tx" : "Claim tx",
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
                        className="flex w-full items-center justify-between gap-3 px-2 py-1 -mx-2 rounded-xl hover:bg-[#14171c] text-left cursor-pointer transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
                      >
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-1.5 tabular-nums">
                            <span
                              className={`h-1.5 w-1.5 rounded-full shrink-0 ${
                                pos.isUp ? "bg-[#2EC26B]" : "bg-[#E85D4A]"
                              }`}
                              aria-hidden="true"
                            />
                            <span className="text-[14px] font-bold text-white tracking-[-0.01em]">
                              {spec.displaySymbol} {dirText}
                            </span>
                            <span className="text-xs font-medium text-[#b8bec6]">
                              {formatStrikePrice(pos.startPrice, pos.underlying)}{" "}
                              → {formatStrikePrice(pos.capPrice, pos.underlying)}
                            </span>
                          </div>
                          <div className="mt-0.5 text-xs text-[#7e8690] tabular-nums">
                            {metaParts.join(" · ")}
                          </div>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          <div className="text-right tabular-nums">
                            <div className="text-[14.5px] font-bold text-white tracking-[-0.02em]">
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
                              {formatSignedUsd(netPnl)} ({roiPct >= 0 ? "+" : ""}
                              {roiPct.toFixed(1)}%)
                            </div>
                          </div>
                          <ChevronDown
                            aria-hidden="true"
                            className={`h-4 w-4 text-[#5a616c] transition-transform ${
                              isExpanded ? "rotate-180 text-[#b8bec6]" : ""
                            }`}
                          />
                        </div>
                      </button>

                      {isExpanded && (
                        <div className="mt-2.5 rounded-xl bg-[#15171b] border border-[#1d2025] p-3.5 space-y-2.5 text-xs">
                          {!isClosedEarly &&
                            pos.settlementPrice !== undefined && (
                              <PayoffRangeRuler pos={pos} locale={locale} />
                            )}

                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 tabular-nums">
                            <div>
                              <span className="text-[#7e8690]">
                                {isPartialActiveClose
                                  ? isZh
                                    ? "平仓成本"
                                    : "Sold cost"
                                  : isZh
                                    ? "成本"
                                    : "Cost"}
                              </span>
                              <div className="mt-0.5 font-semibold text-white">
                                ${realizedStakeUsdt.toFixed(2)}
                              </div>
                            </div>

                            <div>
                              <span className="text-[#7e8690]">
                                {isClosedEarly
                                  ? isZh
                                    ? "卖出收回"
                                    : "Proceeds"
                                  : isZh
                                    ? "到期赔付"
                                    : "Payout"}
                              </span>
                              <div className="mt-0.5 font-semibold text-white">
                                ${totalPayout.toFixed(2)}
                              </div>
                            </div>

                            {isPartialActiveClose ? (
                              <>
                                <div>
                                  <span className="text-[#7e8690]">
                                    {isZh
                                      ? `剩余 (${openPct}%)`
                                      : `Open (${openPct}%)`}
                                  </span>
                                  <div
                                    className={`mt-0.5 font-semibold ${
                                      pos.unrealizedPnlUsdt >= 0
                                        ? "text-[#2EC26B]"
                                        : "text-[#E85D4A]"
                                    }`}
                                  >
                                    ${pos.indicativeExitUsdt.toFixed(2)} (
                                    {formatSignedUsd(pos.unrealizedPnlUsdt)})
                                  </div>
                                </div>
                                <div>
                                  <span className="text-[#7e8690]">
                                    {isZh ? "整笔盈亏" : "Total PnL"}
                                  </span>
                                  <div
                                    className={`mt-0.5 font-semibold ${
                                      combinedPnl >= 0
                                        ? "text-[#2EC26B]"
                                        : "text-[#E85D4A]"
                                    }`}
                                  >
                                    {formatSignedUsd(combinedPnl)} (
                                    {combinedPct >= 0 ? "+" : ""}
                                    {combinedPct.toFixed(0)}%)
                                  </div>
                                </div>
                              </>
                            ) : (
                              <>
                                <div>
                                  <span className="text-[#7e8690]">
                                    {isZh ? "协议费" : "Fee"}
                                  </span>
                                  <div className="mt-0.5 font-semibold text-white">
                                    ${pos.protocolFeeUsdt.toFixed(2)}
                                  </div>
                                </div>
                                <div>
                                  <span className="text-[#7e8690]">
                                    {isClosedEarly
                                      ? isZh
                                        ? "平仓时间"
                                        : "Closed"
                                      : isZh
                                        ? "结算价"
                                        : "Settled"}
                                  </span>
                                  <div className="mt-0.5 font-semibold text-white">
                                    {isClosedEarly
                                      ? dateText
                                      : pos.settlementPrice !== undefined
                                        ? formatStrikePrice(
                                            pos.settlementPrice,
                                            pos.underlying
                                          )
                                        : "--"}
                                  </div>
                                </div>
                              </>
                            )}
                          </div>

                          {explorerBase && txLinks.length > 0 && (
                            <div className="flex flex-wrap items-center gap-3 border-t border-[#1d2025] pt-2 text-[#7e8690]">
                              {txLinks.map((lnk) => (
                                <a
                                  key={`${lnk.label}-${lnk.hash}`}
                                  href={`${explorerBase}/tx/${lnk.hash}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="inline-flex items-center gap-1 hover:text-white transition"
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

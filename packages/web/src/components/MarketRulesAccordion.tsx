import { useEffect, useId, useRef, useState, type JSX } from "react";
import {
  BookOpen,
  Building2,
  ChevronRight,
  Clock,
  ExternalLink,
  Loader2,
  Scale,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  ASSET_SPECS,
  ATLAS_FEEDS,
  BSC_TESTNET,
  type AtlasFeedTelemetry,
  type Direction,
  type ExpiryTenor,
  type FixedGridMeta,
  type RwaAssetTelemetry,
  type TicketSummary,
  type UnderlyingSymbol,
} from "@payoff/shared";
import {
  api,
  type ConsensusGuardState,
  type SettlementHistoryRecord,
} from "../lib/api";
import {
  formatSettlementClock,
  formatStrikeNumber,
  formatStrikePrice,
} from "../lib/format";
import { getCopy, type Locale } from "../lib/i18n";
import { AtlasOracleBadge } from "./AtlasOracleBadge";
import { LinearPayoffChart } from "./LinearPayoffChart";

export interface MarketRulesAccordionProps {
  locale: Locale;
  underlying: UnderlyingSymbol;
  direction: Direction;
  tenor: ExpiryTenor;
  expiryIso: string;
  ticket?: TicketSummary;
  grid?: FixedGridMeta;
  spot?: number;
  atlasTelemetry?: AtlasFeedTelemetry;
  rwaTelemetry?: RwaAssetTelemetry;
  consensusGuard?: ConsensusGuardState;
  signerAddress?: `0x${string}`;
  oracleAddress?: `0x${string}`;
  onReplayOnboarding?: () => void;
}

export interface RulesOracleSheetProps extends MarketRulesAccordionProps {
  open: boolean;
  onClose: () => void;
}

function formatExpiryUtc(
  expiryIso: string,
  fallbackUtcHour: number
): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  if (!expiryIso) return `${pad(fallbackUtcHour)}:00 UTC`;
  const d = new Date(expiryIso);
  if (Number.isNaN(d.getTime())) return expiryIso;
  const yyyy = d.getUTCFullYear();
  const mm = pad(d.getUTCMonth() + 1);
  const dd = pad(d.getUTCDate());
  const hh = pad(d.getUTCHours());
  const min = pad(d.getUTCMinutes());
  return `${yyyy}-${mm}-${dd} ${hh}:${min} UTC`;
}

function formatHistoryDate(record: SettlementHistoryRecord): string {
  const sec = record.expiry || record.oracleTimestamp || record.settledAt;
  if (!sec) return record.expiryIso?.slice(0, 10) || "--";
  const d = new Date(sec * 1000);
  if (Number.isNaN(d.getTime())) return "--";
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  return `${mm}/${dd} ${hh}:${min} UTC`;
}

function RulesAndOracleContent({
  locale,
  underlying,
  direction,
  expiryIso,
  ticket,
  grid,
  spot,
  atlasTelemetry,
  rwaTelemetry,
  consensusGuard,
  signerAddress,
  oracleAddress,
  onReplayOnboarding,
  shouldLoadHistory,
  onBeforeReplay,
}: MarketRulesAccordionProps & {
  shouldLoadHistory: boolean;
  onBeforeReplay?: () => void;
}) {
  const isZh = locale === "zh";
  const t = getCopy(locale);
  const isBull = direction === "BULL";
  const spec = ASSET_SPECS[underlying];
  const isRwa = spec.assetClass === "RWA_EQUITY";
  const feed = ATLAS_FEEDS[underlying];

  const [historyRecords, setHistoryRecords] = useState<
    SettlementHistoryRecord[]
  >([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  useEffect(() => {
    if (!shouldLoadHistory) return;
    let cancelled = false;
    setHistoryLoading(true);
    setHistoryError(null);
    api
      .getSettlementHistory(underlying, 10)
      .then((res) => {
        if (!cancelled) {
          setHistoryRecords(res.records || []);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setHistoryError(
            isZh
              ? "暂时无法加载历史结算价"
              : "Unable to load settlement history"
          );
        }
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [shouldLoadHistory, underlying, isZh]);

  const effectiveExpiryIso = expiryIso || ticket?.expiryIso || "";
  const parsedExpiry = effectiveExpiryIso ? new Date(effectiveExpiryIso) : null;
  const settlementUtcHour =
    rwaTelemetry?.settlementUtcHour ??
    (parsedExpiry && !Number.isNaN(parsedExpiry.getTime())
      ? parsedExpiry.getUTCHours()
      : spec.settlementUtcHour);
  const clock = formatSettlementClock(settlementUtcHour);
  const windowLabel = isRwa
    ? isZh
      ? `${clock.windowUtc} · 美股收盘`
      : `${clock.windowUtc} · US Close`
    : clock.windowUtc;

  const expiryUtc = formatExpiryUtc(effectiveExpiryIso, settlementUtcHour);
  const startValue =
    ticket?.startPrice ??
    grid?.anchorStartPrice ??
    (isBull ? grid?.gridLow : grid?.gridHigh);
  const capValue = ticket?.capPrice ?? (isBull ? grid?.gridHigh : grid?.gridLow);
  const maxPayoutText =
    ticket && Number.isFinite(ticket.maxPayoutUsdt)
      ? ticket.maxPayoutUsdt.toFixed(2)
      : "--";
  const effectiveFeedId = atlasTelemetry?.feedId || feed.feedId;
  const explorerBase =
    BSC_TESTNET.explorerUrl || "https://testnet.bscscan.com";

  const rules = [
    {
      id: "oracle",
      icon: Clock,
      title: isRwa ? t.rulesItem1TitleRwa : t.rulesItem1Title,
      body: t.rulesItem1Body(
        underlying,
        effectiveFeedId,
        expiryUtc,
        windowLabel
      ),
    },
    {
      id: "payoff",
      icon: Scale,
      title: t.rulesItem2Title,
      body: t.rulesItem2Body(
        formatStrikeNumber(startValue, underlying),
        formatStrikeNumber(capValue, underlying),
        maxPayoutText,
        isBull
      ),
    },
    {
      id: "collateral",
      icon: ShieldCheck,
      title: t.rulesItem3Title,
      body: t.rulesItem3Body,
    },
    ...(isRwa
      ? [
          {
            id: "rwa-bstock",
            icon: Building2,
            title: t.rulesItem4Title,
            body: t.rulesItem4Body(
              (rwaTelemetry?.shareMultiplier ?? 1.0008).toFixed(4),
              effectiveFeedId
            ),
          },
        ]
      : []),
  ];

  const effectiveSpot = spot ?? ticket?.spot ?? spec.defaultSpot;

  return (
    <div className="space-y-4">
      {/* Optional Replay 30s Onboarding CTA */}
      {onReplayOnboarding && (
        <button
          type="button"
          onClick={() => {
            onBeforeReplay?.();
            onReplayOnboarding();
          }}
          className="flex w-full items-center justify-between gap-2 rounded-2xl bg-[#15171b] border border-[#1d2025] px-3.5 py-3 text-left hover:bg-[#1c2026] transition cursor-pointer"
        >
          <span className="inline-flex items-center gap-2 text-xs font-semibold text-white">
            <BookOpen className="h-4 w-4 text-[#2EC26B]" aria-hidden="true" />
            <span>
              {isZh ? "重看 30 秒看懂 Payoff" : "Replay 30s Payoff Guide"}
            </span>
          </span>
          <ChevronRight className="h-4 w-4 text-[#7e8690]" aria-hidden="true" />
        </button>
      )}

      {/* Dark Atlas Oracle Live Telemetry */}
      <AtlasOracleBadge
        locale={locale}
        underlying={underlying}
        telemetry={atlasTelemetry}
        guard={consensusGuard}
        signerAddress={signerAddress}
        oracleAddress={oracleAddress}
        variant="expanded"
      />

      {/* Optional Embedded Linear Payoff Curve */}
      {ticket && (
        <details className="group rounded-2xl border border-[#1d2025] bg-[#15171b]">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-3.5 py-2.5 text-xs font-semibold text-white select-none [&::-webkit-details-marker]:hidden">
            <span className="inline-flex items-center gap-2">
              <ChevronRight
                aria-hidden="true"
                className="h-3.5 w-3.5 text-[#7e8690] group-open:rotate-90 transition-transform"
              />
              <span>
                {isZh ? "查看线性赔付阶梯图" : "View Linear Payoff Curve"}
              </span>
            </span>
            <span className="text-[11px] font-medium text-[#7e8690] tabular-nums">
              {formatStrikePrice(ticket.startPrice, underlying)} →{" "}
              {formatStrikePrice(ticket.capPrice, underlying)}
            </span>
          </summary>
          <div className="border-t border-[#1d2025] p-2.5">
            <LinearPayoffChart
              locale={locale}
              underlying={underlying}
              direction={direction}
              spot={effectiveSpot}
              ticket={ticket}
              gridStep={grid?.gridStep}
            />
          </div>
        </details>
      )}

      {/* Recent Official Atlas Settlement History */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-[11.5px] font-bold tracking-[0.02em] text-[#7e8690]">
            {isZh
              ? `${spec.displaySymbol} 近期官方结算价（Atlas 30m TWAP）`
              : `${spec.displaySymbol} Recent Settlements (Atlas 30m TWAP)`}
          </h2>
          {historyLoading && (
            <Loader2
              className="h-3.5 w-3.5 animate-spin text-[#7e8690]"
              aria-hidden="true"
            />
          )}
        </div>

        {historyError ? (
          <div className="rounded-xl bg-[#15171b] border border-[#1d2025] px-3 py-2.5 text-xs text-[#7e8690]">
            {historyError}
          </div>
        ) : historyRecords.length === 0 && !historyLoading ? (
          <div className="rounded-xl bg-[#15171b] border border-[#1d2025] px-3 py-2.5 text-xs text-[#7e8690]">
            {isZh
              ? "暂无近期链上结算记录。"
              : "No recent on-chain settlements yet."}
          </div>
        ) : (
          <div className="rounded-2xl bg-[#15171b] border border-[#1d2025] divide-y divide-[#1d2025] px-3.5">
            {historyRecords.map((rec, idx) => (
              <div
                key={`${rec.expiry}-${idx}`}
                className="flex items-center justify-between gap-3 py-2.5 text-xs tabular-nums"
              >
                <div className="min-w-0">
                  <div className="font-semibold text-white">
                    {formatHistoryDate(rec)}
                  </div>
                  <div className="text-[11px] text-[#7e8690]">
                    {rec.sampleCount
                      ? isZh
                        ? `${rec.sampleCount} 点签名均值`
                        : `${rec.sampleCount}-pt signed TWAP`
                      : rec.source}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="font-bold text-white">
                    {formatStrikePrice(rec.priceUsd, underlying)}
                  </span>
                  {rec.txHash && (
                    <a
                      href={`${explorerBase}/tx/${rec.txHash}`}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={isZh ? "查看结算交易" : "View settlement tx"}
                      className="rounded-full p-1 text-[#7e8690] hover:bg-[#24282f] hover:text-white transition"
                    >
                      <ExternalLink className="h-3 w-3" aria-hidden="true" />
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Rules List */}
      <ol role="list" className="divide-y divide-[#1d2025]">
        {rules.map((rule) => {
          const Icon = rule.icon;
          return (
            <li key={rule.id} className="flex items-start gap-3 py-3 first:pt-1">
              <span
                aria-hidden="true"
                className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-[#15171b] border border-[#24282e] text-[#b8bec6]"
              >
                <Icon className="h-3.5 w-3.5" />
              </span>
              <div className="min-w-0 space-y-1">
                <p className="text-xs font-semibold text-white">{rule.title}</p>
                <p className="text-xs leading-relaxed text-[#7e8690] tabular-nums">
                  {rule.body}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export function MarketRulesAccordion(
  props: MarketRulesAccordionProps
): JSX.Element {
  const { locale } = props;
  const t = getCopy(locale);
  const [isOpen, setIsOpen] = useState(false);

  return (
    <details
      open={isOpen}
      onToggle={(e) => setIsOpen(e.currentTarget.open)}
      className="group rounded-2xl border border-[#1d2025] bg-[#121417] text-white"
    >
      <summary className="flex min-h-12 cursor-pointer list-none flex-wrap items-center justify-between gap-x-3 gap-y-1.5 rounded-2xl px-4 py-3 text-left select-none transition-colors hover:bg-[#15171b] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white [&::-webkit-details-marker]:hidden">
        <span className="flex items-center gap-2 text-sm font-semibold text-white">
          <ChevronRight
            aria-hidden="true"
            className="h-4 w-4 shrink-0 text-[#7e8690] group-open:rotate-90 motion-safe:transition-transform motion-safe:duration-200 motion-reduce:transition-none"
          />
          <span>{t.rulesTitle}</span>
        </span>
        <span className="rounded-full bg-[#24282f] px-2.5 py-0.5 text-[11px] font-medium text-[#b8bec6]">
          Atlas 30m TWAP
        </span>
      </summary>

      <div className="border-t border-[#1d2025] px-4 py-4 sm:px-5">
        <RulesAndOracleContent {...props} shouldLoadHistory={isOpen} />
      </div>
    </details>
  );
}

export function RulesOracleSheet({
  open,
  onClose,
  ...rest
}: RulesOracleSheetProps): JSX.Element | null {
  const isZh = rest.locale === "zh";
  const t = getCopy(rest.locale);
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);

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

  if (!open) return null;

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      {...({ closedby: "any" } as Record<string, unknown>)}
      onClose={() => {
        if (dialogRef.current) dialogRef.current.returnValue = "";
        onClose();
      }}
      className="payoff-sheet md:!w-[min(92vw,540px)] md:!max-w-[540px]"
    >
      <div className="flex max-h-[90dvh] flex-col md:max-h-[86dvh]">
        <div aria-hidden="true" className="payoff-sheet-handle" />

        <div className="overflow-y-auto px-5 pt-3 pb-6 sm:px-6 safe-pb space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h1
                id={titleId}
                className="text-[19px] font-bold tracking-[-0.02em] text-white"
              >
                {t.rulesTitle}
              </h1>
              <p className="mt-0.5 text-xs text-[#7e8690]">
                {isZh
                  ? "Atlas 30 分钟链上验签 TWAP · BNB Chain 100% 全额托管"
                  : "Atlas 30m on-chain signed TWAP · 100% BNB Chain collateral"}
              </p>
            </div>
            <button
              type="button"
              autoFocus
              aria-label={t.cancel}
              onClick={() => dialogRef.current?.close()}
              className="rounded-full p-1.5 text-[#7e8690] hover:bg-[#24282f] hover:text-white transition cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>

          <RulesAndOracleContent
            {...rest}
            shouldLoadHistory={open}
            onBeforeReplay={() => dialogRef.current?.close()}
          />
        </div>
      </div>
    </dialog>
  );
}

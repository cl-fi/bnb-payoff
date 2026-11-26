import type { JSX } from "react";
import {
  Building2,
  ChevronRight,
  Clock,
  Scale,
  ShieldCheck,
} from "lucide-react";
import {
  ASSET_SPECS,
  ATLAS_FEEDS,
  type AtlasFeedTelemetry,
  type Direction,
  type ExpiryTenor,
  type FixedGridMeta,
  type RwaAssetTelemetry,
  type TicketSummary,
  type UnderlyingSymbol,
} from "@payoff/shared";
import type { ConsensusGuardState } from "../lib/api";
import { formatSettlementClock, formatStrikeNumber } from "../lib/format";
import { getCopy, type Locale } from "../lib/i18n";
import { AtlasOracleBadge } from "./AtlasOracleBadge";

export interface MarketRulesAccordionProps {
  locale: Locale;
  underlying: UnderlyingSymbol;
  direction: Direction;
  tenor: ExpiryTenor;
  expiryIso: string;
  ticket?: TicketSummary;
  grid?: FixedGridMeta;
  atlasTelemetry?: AtlasFeedTelemetry;
  rwaTelemetry?: RwaAssetTelemetry;
  consensusGuard?: ConsensusGuardState;
  signerAddress?: `0x${string}`;
  oracleAddress?: `0x${string}`;
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

export function MarketRulesAccordion({
  locale,
  underlying,
  direction,
  tenor: _tenor,
  expiryIso,
  ticket,
  grid,
  atlasTelemetry,
  rwaTelemetry,
  consensusGuard,
  signerAddress,
  oracleAddress,
}: MarketRulesAccordionProps): JSX.Element {
  const t = getCopy(locale);
  const isBull = direction === "BULL";
  const spec = ASSET_SPECS[underlying];
  const isRwa = spec.assetClass === "RWA_EQUITY";
  const feed = ATLAS_FEEDS[underlying];

  const effectiveExpiryIso = expiryIso || ticket?.expiryIso || "";
  const parsedExpiry = effectiveExpiryIso ? new Date(effectiveExpiryIso) : null;
  const settlementUtcHour =
    rwaTelemetry?.settlementUtcHour ??
    (parsedExpiry && !Number.isNaN(parsedExpiry.getTime())
      ? parsedExpiry.getUTCHours()
      : spec.settlementUtcHour);
  const clock = formatSettlementClock(settlementUtcHour);
  const windowLabel = isRwa
    ? locale === "zh"
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

  return (
    <details className="group rounded-xl border border-[#e2e5e8] bg-white">
      <summary className="flex min-h-12 cursor-pointer list-none flex-wrap items-center justify-between gap-x-3 gap-y-1.5 rounded-xl px-4 py-3 text-left select-none transition-colors hover:bg-[#f7f8f9] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#14202a] [&::-webkit-details-marker]:hidden">
        <span className="flex items-center gap-2 text-sm font-semibold text-[#14202a]">
          <ChevronRight
            aria-hidden="true"
            className="h-4 w-4 shrink-0 text-[#667080] group-open:rotate-90 motion-safe:transition-transform motion-safe:duration-200 motion-reduce:transition-none"
          />
          <span>{t.rulesTitle}</span>
        </span>
        <span className="rounded-md bg-[#eef0f2] px-2 py-0.5 text-[11px] font-medium text-[#3a4552]">
          {t.rulesBadge}
        </span>
      </summary>

      <div className="border-t border-[#eef0f2] px-4 py-3.5 sm:px-5 sm:py-4 space-y-4">
        <AtlasOracleBadge
          locale={locale}
          underlying={underlying}
          telemetry={atlasTelemetry}
          guard={consensusGuard}
          signerAddress={signerAddress}
          oracleAddress={oracleAddress}
          variant="expanded"
        />

        <ol role="list" className="space-y-3.5">
          {rules.map((rule) => {
            const Icon = rule.icon;
            return (
              <li key={rule.id} className="flex items-start gap-3">
                <span
                  aria-hidden="true"
                  className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-[#f7f8f9] border border-[#e2e5e8] text-[#3a4552]"
                >
                  <Icon className="h-3.5 w-3.5" />
                </span>
                <div className="min-w-0 space-y-0.5">
                  <p className="text-xs font-semibold text-[#14202a]">
                    {rule.title}
                  </p>
                  <p className="text-xs leading-relaxed text-[#667080] tabular-nums">
                    {rule.body}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </details>
  );
}

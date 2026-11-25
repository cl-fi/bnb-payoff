import type { JSX } from "react";
import { ChevronRight, Clock, Scale, ShieldCheck } from "lucide-react";
import {
  ATLAS_FEEDS,
  type AtlasFeedTelemetry,
  type Direction,
  type ExpiryTenor,
  type FixedGridMeta,
  type TicketSummary,
  type UnderlyingSymbol,
} from "@payoff/shared";
import type { ConsensusGuardState } from "../lib/api";
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
  consensusGuard?: ConsensusGuardState;
  signerAddress?: `0x${string}`;
  oracleAddress?: `0x${string}`;
}

function formatExpiryUtc(expiryIso: string): string {
  if (!expiryIso) return "08:00 UTC";
  const d = new Date(expiryIso);
  if (Number.isNaN(d.getTime())) return expiryIso;
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min} UTC`;
}

function formatStrikeNumber(
  value: number | undefined,
  underlying: UnderlyingSymbol
): string {
  if (value === undefined || !Number.isFinite(value)) return "--";
  const isWhole = Math.abs(value - Math.round(value)) < 0.005;
  const maxFrac = underlying === "BTC" ? 0 : isWhole ? 0 : 2;
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxFrac,
  });
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
  consensusGuard,
  signerAddress,
  oracleAddress,
}: MarketRulesAccordionProps): JSX.Element {
  const t = getCopy(locale);
  const isBull = direction === "BULL";
  const feed = ATLAS_FEEDS[underlying];

  const expiryUtc = formatExpiryUtc(expiryIso || ticket?.expiryIso || "");
  const startValue =
    ticket?.startPrice ??
    grid?.anchorStartPrice ??
    (isBull ? grid?.gridLow : grid?.gridHigh);
  const capValue = ticket?.capPrice ?? (isBull ? grid?.gridHigh : grid?.gridLow);
  const maxPayoutText =
    ticket && Number.isFinite(ticket.maxPayoutUsdt)
      ? ticket.maxPayoutUsdt.toFixed(2)
      : "--";

  const rules = [
    {
      id: "oracle",
      icon: Clock,
      title: t.rulesItem1Title,
      body: t.rulesItem1Body(
        underlying,
        atlasTelemetry?.feedId || feed.feedId,
        expiryUtc
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

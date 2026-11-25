import { useState } from "react";
import {
  Activity,
  AlertTriangle,
  ChevronDown,
  ExternalLink,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import {
  ATLAS_FEEDS,
  ATLAS_OFFICIAL_SIGNER,
  BSC_TESTNET,
  type AtlasConsensusStatus,
  type AtlasFeedTelemetry,
  type UnderlyingSymbol,
} from "@payoff/shared";
import type { ConsensusGuardState } from "../lib/api";
import { getCopy, type Locale } from "../lib/i18n";

export interface AtlasOracleBadgeProps {
  locale: Locale;
  underlying: UnderlyingSymbol;
  telemetry?: AtlasFeedTelemetry;
  guard?: ConsensusGuardState;
  signerAddress?: `0x${string}`;
  oracleAddress?: `0x${string}`;
  variant?: "compact" | "expanded";
}

function formatScorePct(score: number | null | undefined): string {
  if (score === null || score === undefined || !Number.isFinite(score)) {
    return "--";
  }
  const pct = score <= 1 ? score * 100 : score;
  return `${Math.round(pct)}%`;
}

function formatPrice(val: number | null | undefined): string {
  if (val === null || val === undefined || !Number.isFinite(val)) return "--";
  return `$${val.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatVolatility(val: number | null | undefined): string {
  if (val === null || val === undefined || !Number.isFinite(val)) return "--";
  const pct = val <= 2 ? val * 100 : val;
  return `${pct.toFixed(2)}%`;
}

function shortHex(addr: string): string {
  if (!addr || addr.length < 12) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-5)}`;
}

function getStatusStyles(status: AtlasConsensusStatus) {
  switch (status) {
    case "HEALTHY":
      return {
        pill: "border-[#bfe2dc] bg-[#e9f3f1] text-[#0e7c72]",
        dot: "bg-[#0e7c72]",
        text: "text-[#0e7c72]",
        bar: "bg-[#0e7c72]",
        isAlert: false,
      };
    case "DEGRADED":
    case "WARNING":
      return {
        pill: "border-[#e6cf8b] bg-[#fbf3dd] text-[#8a6410]",
        dot: "bg-[#d97706]",
        text: "text-[#8a6410]",
        bar: "bg-[#d97706]",
        isAlert: true,
      };
    case "CRITICAL":
    case "SPLIT_MARKET":
      return {
        pill: "border-[#f1ccc6] bg-[#fbeeea] text-[#b54134]",
        dot: "bg-[#b54134]",
        text: "text-[#b54134]",
        bar: "bg-[#b54134]",
        isAlert: true,
      };
    default:
      return {
        pill: "border-[#e2e5e8] bg-[#eef0f2] text-[#667080]",
        dot: "bg-[#94a0ad]",
        text: "text-[#667080]",
        bar: "bg-[#94a0ad]",
        isAlert: false,
      };
  }
}

export function AtlasOracleBadge({
  locale,
  underlying,
  telemetry,
  guard,
  signerAddress,
  oracleAddress,
  variant = "compact",
}: AtlasOracleBadgeProps) {
  const t = getCopy(locale);
  const [expanded, setExpanded] = useState(false);

  const feed = ATLAS_FEEDS[underlying];
  const status: AtlasConsensusStatus =
    telemetry?.consensusStatus ?? guard?.consensusStatus ?? "UNKNOWN";
  const score = telemetry?.consensusScore ?? guard?.consensusScore ?? null;
  const styles = getStatusStyles(status);

  const effectiveSigner = signerAddress || ATLAS_OFFICIAL_SIGNER;
  const hasOracleContract =
    Boolean(oracleAddress) &&
    oracleAddress !== "0x0000000000000000000000000000000000000000";
  const explorerTarget = hasOracleContract ? oracleAddress! : effectiveSigner;
  const explorerBase =
    BSC_TESTNET.explorerUrl || "https://testnet.bscscan.com";
  const explorerHref = `${explorerBase}/address/${explorerTarget}`;

  const scorePctText = formatScorePct(score);
  const scoreRatio =
    score === null || !Number.isFinite(score)
      ? 0
      : Math.max(0, Math.min(100, score <= 1 ? score * 100 : score));

  const breakerTriggered = Boolean(
    guard && (!guard.settlementSafe || !guard.quotingSafe || guard.paused)
  );

  const StatusIcon =
    status === "CRITICAL" || status === "SPLIT_MARKET"
      ? ShieldAlert
      : status === "DEGRADED" || status === "WARNING"
        ? AlertTriangle
        : ShieldCheck;

  const detailContent = (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 text-[11px] pt-2.5 border-t border-[#eef0f2]">
      <div className="rounded-lg bg-[#f7f8f9] border border-[#eef0f2] px-2.5 py-2">
        <div className="text-[#667080]">{t.atlasFeedLabel}</div>
        <div className="mt-0.5 font-semibold text-[#14202a] tabular-nums">
          #{telemetry?.feedId || feed.feedId} {feed.pair}
        </div>
        <div className="font-mono text-[10px] text-[#667080]">
          {telemetry?.feedIdHex || feed.feedIdHex}
        </div>
      </div>

      <div className="rounded-lg bg-[#f7f8f9] border border-[#eef0f2] px-2.5 py-2">
        <div className="text-[#667080]">
          {t.atlasTwapLabel} / {t.atlasMedianLabel}
        </div>
        <div className="mt-0.5 font-semibold text-[#14202a] tabular-nums">
          {formatPrice(telemetry?.twapPrice)}
        </div>
        <div className="text-[10px] text-[#667080] tabular-nums">
          Med: {formatPrice(telemetry?.medianPrice)}
        </div>
      </div>

      <div className="rounded-lg bg-[#f7f8f9] border border-[#eef0f2] px-2.5 py-2">
        <div className="flex items-center justify-between text-[#667080]">
          <span>{t.atlasConsensusLabel}</span>
          {telemetry?.priceVolatility !== null &&
            telemetry?.priceVolatility !== undefined && (
              <span className="inline-flex items-center gap-0.5 text-[10px]">
                <Activity className="h-2.5 w-2.5" aria-hidden="true" />
                {formatVolatility(telemetry.priceVolatility)}
              </span>
            )}
        </div>
        <div className={`mt-0.5 font-bold tabular-nums ${styles.text}`}>
          {status} · {scorePctText}
        </div>
        <div className="mt-1 h-1 w-full rounded-full bg-[#e2e5e8] overflow-hidden">
          <div
            className={`h-full rounded-full ${styles.bar}`}
            style={{ width: `${scoreRatio}%` }}
          />
        </div>
      </div>

      <div className="rounded-lg bg-[#f7f8f9] border border-[#eef0f2] px-2.5 py-2">
        <div className="text-[#667080]">{t.atlasVerifierLabel}</div>
        <a
          href={explorerHref}
          target="_blank"
          rel="noreferrer"
          className="mt-0.5 inline-flex items-center gap-1 font-mono font-semibold text-[#14202a] hover:underline underline-offset-2"
        >
          <span>{shortHex(effectiveSigner)}</span>
          <ExternalLink className="h-2.5 w-2.5 shrink-0 text-[#667080]" aria-hidden="true" />
        </a>
        <div className="text-[10px] text-[#667080]">
          ECDSA · {t.atlasBscTestnet}
        </div>
      </div>
    </div>
  );

  if (variant === "expanded") {
    return (
      <div className="rounded-xl border border-[#e2e5e8] bg-white p-3.5 space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold tabular-nums ${styles.pill}`}
            >
              <StatusIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>
                Atlas Oracle · {status}
                {scorePctText !== "--" ? ` · ${scorePctText}` : ""}
              </span>
            </span>
            <span className="text-xs font-semibold text-[#14202a]">
              {t.atlasBadgeTitle}
            </span>
          </div>

          <span
            className={`rounded-md px-2 py-0.5 text-[10px] font-semibold ${
              breakerTriggered
                ? "bg-[#fbeeea] text-[#b54134]"
                : "bg-[#eef0f2] text-[#3a4552]"
            }`}
          >
            {breakerTriggered
              ? guard?.reason || t.atlasBreakerActive
              : t.atlasBreakerNormal}
          </span>
        </div>

        {detailContent}
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-[#e2e5e8] bg-[#f7f8f9]/80 px-3 py-2 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-semibold tabular-nums ${styles.pill}`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full shrink-0 ${styles.dot} ${
                status === "HEALTHY" ? "animate-pulse" : ""
              }`}
              aria-hidden="true"
            />
            <span>
              Atlas Oracle · {status}
              {scorePctText !== "--" ? ` · ${scorePctText}` : ""}
            </span>
          </span>

          <span className="font-semibold text-[#14202a] tabular-nums">
            #{telemetry?.feedId || feed.feedId} {feed.pair}
          </span>

          {telemetry?.twapPrice !== null &&
            telemetry?.twapPrice !== undefined &&
            telemetry?.medianPrice !== null &&
            telemetry?.medianPrice !== undefined && (
              <span className="hidden sm:inline text-[#667080] tabular-nums">
                TWAP {formatPrice(telemetry.twapPrice)} · Med{" "}
                {formatPrice(telemetry.medianPrice)}
              </span>
            )}

          {telemetry?.priceVolatility !== null &&
            telemetry?.priceVolatility !== undefined && (
              <span className="hidden md:inline text-[#667080] tabular-nums">
                Vol {formatVolatility(telemetry.priceVolatility)}
              </span>
            )}
        </div>

        <div className="flex items-center gap-2 text-[11px]">
          <a
            href={explorerHref}
            target="_blank"
            rel="noreferrer"
            className="hidden sm:inline-flex items-center gap-1 rounded-md border border-[#e2e5e8] bg-white px-2 py-0.5 font-mono text-[10px] font-medium text-[#3a4552] hover:border-[#c8ccd1] hover:text-[#14202a] transition"
            title={`${t.atlasVerifierLabel}: ${effectiveSigner}`}
          >
            <ShieldCheck className="h-3 w-3 text-[#0e7c72]" aria-hidden="true" />
            <span>{shortHex(effectiveSigner)}</span>
            <span className="text-[#c8ccd1]">·</span>
            <span className="font-sans">{t.atlasBscTestnet}</span>
          </a>

          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((prev) => !prev)}
            className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-semibold text-[#3a4552] hover:bg-[#eef0f2] hover:text-[#14202a] transition cursor-pointer"
          >
            <span>{t.atlasToggleDetails}</span>
            <ChevronDown
              className={`h-3.5 w-3.5 transition-transform ${
                expanded ? "rotate-180" : ""
              }`}
              aria-hidden="true"
            />
          </button>
        </div>
      </div>

      {breakerTriggered && (
        <div className="flex items-center gap-1.5 rounded-lg bg-[#fbeeea] px-2.5 py-1.5 text-[11px] font-medium text-[#b54134]">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{guard?.reason || t.atlasBreakerActive}</span>
        </div>
      )}

      {expanded && detailContent}
    </div>
  );
}

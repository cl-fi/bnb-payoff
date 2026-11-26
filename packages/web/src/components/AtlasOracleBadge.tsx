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
import { AtlasLogoMark } from "./AtlasBrand";

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
        pill: "border-[#2EC26B]/30 bg-[#2EC26B]/13 text-[#2EC26B]",
        dot: "bg-[#2EC26B]",
        text: "text-[#2EC26B]",
        bar: "bg-[#2EC26B]",
        isAlert: false,
      };
    case "DEGRADED":
    case "WARNING":
      return {
        pill: "border-[#E6BA5C]/30 bg-[#E6BA5C]/12 text-[#E6BA5C]",
        dot: "bg-[#E6BA5C]",
        text: "text-[#E6BA5C]",
        bar: "bg-[#E6BA5C]",
        isAlert: true,
      };
    case "CRITICAL":
    case "SPLIT_MARKET":
      return {
        pill: "border-[#E85D4A]/30 bg-[#E85D4A]/13 text-[#E85D4A]",
        dot: "bg-[#E85D4A]",
        text: "text-[#E85D4A]",
        bar: "bg-[#E85D4A]",
        isAlert: true,
      };
    default:
      return {
        pill: "border-[#2e333a] bg-[#24282f] text-[#b8bec6]",
        dot: "bg-[#7e8690]",
        text: "text-[#b8bec6]",
        bar: "bg-[#7e8690]",
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
  const explorerBase =
    BSC_TESTNET.explorerUrl || "https://testnet.bscscan.com";
  const oracleHref = hasOracleContract
    ? `${explorerBase}/address/${oracleAddress!}`
    : undefined;
  const signerHref = `${explorerBase}/address/${effectiveSigner}`;

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
    <div className="grid grid-cols-2 gap-2 text-[11px] pt-2.5 border-t border-[#1d2025]">
      <div className="rounded-xl bg-black border border-[#1d2025] px-2.5 py-2">
        <div className="text-[#7e8690]">{t.atlasFeedLabel}</div>
        <div className="mt-0.5 font-semibold text-white tabular-nums">
          #{telemetry?.feedId || feed.feedId} {feed.pair}
        </div>
        <div className="font-mono text-[10px] text-[#7e8690]">
          {telemetry?.feedIdHex || feed.feedIdHex}
        </div>
      </div>

      <div className="rounded-xl bg-black border border-[#1d2025] px-2.5 py-2">
        <div className="text-[#7e8690]">
          {t.atlasTwapLabel} / {t.atlasMedianLabel}
        </div>
        <div className="mt-0.5 font-semibold text-white tabular-nums">
          {formatPrice(telemetry?.twapPrice)}
        </div>
        <div className="text-[10px] text-[#7e8690] tabular-nums">
          Med: {formatPrice(telemetry?.medianPrice)}
        </div>
      </div>

      <div className="rounded-xl bg-black border border-[#1d2025] px-2.5 py-2">
        <div className="flex items-center justify-between text-[#7e8690]">
          <span>{t.atlasConsensusLabel}</span>
          {telemetry?.priceVolatility !== null &&
            telemetry?.priceVolatility !== undefined && (
              <span className="inline-flex items-center gap-0.5 text-[10px] tabular-nums">
                <Activity className="h-2.5 w-2.5" aria-hidden="true" />
                {formatVolatility(telemetry.priceVolatility)}
              </span>
            )}
        </div>
        <div className={`mt-0.5 font-bold tabular-nums ${styles.text}`}>
          {status} · {scorePctText}
        </div>
        <div className="mt-1 h-1 w-full rounded-full bg-[#24282f] overflow-hidden">
          <div
            className={`h-full rounded-full ${styles.bar}`}
            style={{ width: `${scoreRatio}%` }}
          />
        </div>
      </div>

      <div className="rounded-xl bg-black border border-[#1d2025] px-2.5 py-2 space-y-1">
        <div className="text-[#7e8690]">{t.atlasVerifierLabel}</div>
        <div className="flex flex-wrap items-center gap-1.5">
          {oracleHref && oracleAddress && (
            <a
              href={oracleHref}
              target="_blank"
              rel="noreferrer"
              title={`${t.atlasOracleContractLabel}: ${oracleAddress}`}
              className="inline-flex items-center gap-1 font-mono font-semibold text-white hover:underline underline-offset-2"
            >
              <span>{shortHex(oracleAddress)}</span>
              <ExternalLink
                className="h-2.5 w-2.5 shrink-0 text-[#7e8690]"
                aria-hidden="true"
              />
            </a>
          )}
        </div>
        <div className="text-[10px] text-[#7e8690] flex items-center gap-1">
          <span>Signer:</span>
          <a
            href={signerHref}
            target="_blank"
            rel="noreferrer"
            title={`ECDSA Signer: ${effectiveSigner}`}
            className="font-mono hover:underline underline-offset-2 text-[#b8bec6]"
          >
            {shortHex(effectiveSigner)}
          </a>
        </div>
      </div>
    </div>
  );

  if (variant === "expanded") {
    const isZh = locale === "zh";
    return (
      <div className="rounded-2xl border border-[#1d2025] bg-[#15171b] p-3.5 space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <AtlasLogoMark size={16} className="shrink-0" />
            <span className="text-xs font-semibold text-white">
              {t.atlasBadgeTitle}
            </span>
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold tabular-nums ${styles.pill}`}
            >
              <StatusIcon className="h-3 w-3 shrink-0" aria-hidden="true" />
              <span>
                {status}
                {scorePctText !== "--" ? ` · ${scorePctText}` : ""}
              </span>
            </span>
          </div>

          <span
            className={`rounded-full px-2.5 py-0.5 text-[10px] font-semibold ${
              breakerTriggered
                ? "bg-[#E85D4A]/13 text-[#E85D4A]"
                : "bg-[#24282f] text-[#b8bec6]"
            }`}
          >
            {breakerTriggered
              ? guard?.reason || t.atlasBreakerActive
              : t.atlasBreakerNormal}
          </span>
        </div>

        {detailContent}

        <div className="flex items-center justify-between gap-2 border-t border-[#1d2025] pt-2.5 text-[11px]">
          <span className="text-[#7e8690]">
            {isZh
              ? "由 Atlas 第一方预言机实时提供价格数据"
              : "First-party real-time price feed by Atlas"}
          </span>
          <a
            href="https://atlasoracle.io/"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-6 shrink-0 items-center gap-1 font-semibold text-[#d4d8df] transition-colors hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          >
            <span>atlasoracle.io</span>
            <ExternalLink
              className="h-3 w-3 shrink-0 text-[#7e8690]"
              aria-hidden="true"
            />
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-[#1d2025] bg-[#15171b] px-3 py-2 space-y-2">
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

          <span className="font-semibold text-white tabular-nums">
            #{telemetry?.feedId || feed.feedId} {feed.pair}
          </span>

          {telemetry?.twapPrice !== null &&
            telemetry?.twapPrice !== undefined &&
            telemetry?.medianPrice !== null &&
            telemetry?.medianPrice !== undefined && (
              <span className="hidden sm:inline text-[#7e8690] tabular-nums">
                TWAP {formatPrice(telemetry.twapPrice)} · Med{" "}
                {formatPrice(telemetry.medianPrice)}
              </span>
            )}

          {telemetry?.priceVolatility !== null &&
            telemetry?.priceVolatility !== undefined && (
              <span className="hidden md:inline text-[#7e8690] tabular-nums">
                Vol {formatVolatility(telemetry.priceVolatility)}
              </span>
            )}
        </div>

        <div className="flex items-center gap-2 text-[11px]">
          <a
            href={oracleHref || signerHref}
            target="_blank"
            rel="noreferrer"
            className="hidden sm:inline-flex items-center gap-1 rounded-full border border-[#24282e] bg-black px-2.5 py-0.5 font-mono text-[10px] font-medium text-[#b8bec6] hover:border-white/25 hover:text-white transition"
            title={
              hasOracleContract && oracleAddress
                ? `${t.atlasOracleContractLabel}: ${oracleAddress} | Signer: ${effectiveSigner}`
                : `${t.atlasVerifierLabel}: ${effectiveSigner}`
            }
          >
            <ShieldCheck
              className="h-3 w-3 text-[#2EC26B]"
              aria-hidden="true"
            />
            <span>
              {hasOracleContract && oracleAddress
                ? shortHex(oracleAddress)
                : shortHex(effectiveSigner)}
            </span>
            <span className="text-[#343941]">·</span>
            <span className="font-sans">{t.atlasBscTestnet}</span>
          </a>

          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((prev) => !prev)}
            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold text-[#b8bec6] hover:bg-[#24282f] hover:text-white transition cursor-pointer"
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
        <div className="flex items-center gap-2 rounded-xl bg-black border border-[#E85D4A]/30 px-2.5 py-1.5 text-[11px] font-medium text-[#E85D4A]">
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 rounded-full bg-[#E85D4A] shrink-0"
          />
          <span>{guard?.reason || t.atlasBreakerActive}</span>
        </div>
      )}

      {expanded && detailContent}
    </div>
  );
}

import type { RwaAssetTelemetry, UnderlyingSymbol } from "@payoff/shared";

/**
 * Formats a strike or reference USD value without a leading `$`:
 * - Whole integers render cleanly without redundant `.00` (`68,000`, `2,500`, `155`).
 * - Fractional values (including OCC `$2.50` strikes like `152.5`, `157.5`) always render
 *   consistent 2-decimal precision (`152.50`, `157.50`), never truncated to `152` or `152.5`.
 */
export function formatStrikeNumber(
  value: number | null | undefined,
  _underlying?: UnderlyingSymbol
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "--";
  }
  const isWhole = Math.abs(value - Math.round(value)) < 0.005;
  const frac = isWhole ? 0 : 2;
  return value.toLocaleString("en-US", {
    minimumFractionDigits: frac,
    maximumFractionDigits: frac,
  });
}

/** Formats a strike or reference price with a leading `$` (`$152.50`, `$155`, `$68,000`). */
export function formatStrikePrice(
  value: number | null | undefined,
  underlying?: UnderlyingSymbol
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "--";
  }
  return `$${formatStrikeNumber(value, underlying)}`;
}

/** Computes UTC, UTC+8, and 30-minute TWAP window labels from an asset's settlement UTC hour. */
export function formatSettlementClock(utcHour: number): {
  utcHour: number;
  utcLabel: string;
  utcPlus8Label: string;
  windowUtc: string;
} {
  const normalized = ((Math.trunc(utcHour) % 24) + 24) % 24;
  const startHour = (normalized + 23) % 24;
  const utcPlus8Hour = (normalized + 8) % 24;
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    utcHour: normalized,
    utcLabel: `${pad(normalized)}:00 UTC`,
    utcPlus8Label: `${pad(utcPlus8Hour)}:00 UTC+8`,
    windowUtc: `${pad(startHour)}:31–${pad(normalized)}:00 UTC`,
  };
}

/**
 * Resolves `RwaAssetTelemetry` whether an endpoint returns a single-asset telemetry object
 * or a per-underlying map (`Partial<Record<UnderlyingSymbol, RwaAssetTelemetry>>`).
 */
export function resolveRwaTelemetry(
  raw:
    | RwaAssetTelemetry
    | Partial<Record<UnderlyingSymbol, RwaAssetTelemetry>>
    | undefined,
  underlying: UnderlyingSymbol
): RwaAssetTelemetry | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  if ("session" in raw && "shareMultiplier" in raw) {
    return raw as RwaAssetTelemetry;
  }
  return (raw as Partial<Record<UnderlyingSymbol, RwaAssetTelemetry>>)[
    underlying
  ];
}

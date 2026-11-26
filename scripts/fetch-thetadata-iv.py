#!/usr/bin/env python3
"""
ThetaData NVDA Option Chain & Implied Volatility Bridge.

Queries real listed NVDA option expirations and live/latest NBBO option quotes
via thetadata==1.0.18, sanitizes crossed/illiquid quotes, extracts a Put-Call
Parity synthetic forward (F = K + C_mid - P_mid), solves per-strike European
Black-Scholes IV (r = 0) via bisection, and emits compact JSON to stdout.

Security: NEVER prints or logs THETADATA_API_KEY.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import statistics
import sys
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple


SQRT_2 = math.sqrt(2.0)


def norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / SQRT_2))


def bs_price(is_call: bool, forward: float, strike: float, t_years: float, vol: float) -> float:
    if t_years <= 0.0 or vol <= 0.0:
        return max(forward - strike, 0.0) if is_call else max(strike - forward, 0.0)
    sqrt_t = math.sqrt(t_years)
    vol_sqrt_t = vol * sqrt_t
    d1 = (math.log(forward / strike) + 0.5 * vol * vol * t_years) / vol_sqrt_t
    d2 = d1 - vol_sqrt_t
    if is_call:
        return forward * norm_cdf(d1) - strike * norm_cdf(d2)
    return strike * norm_cdf(-d2) - forward * norm_cdf(-d1)


def solve_bs_iv(
    is_call: bool,
    forward: float,
    strike: float,
    t_years: float,
    target_price: float,
    lo: float = 0.05,
    hi: float = 3.0,
    iterations: int = 60,
) -> Optional[float]:
    if forward <= 0.0 or strike <= 0.0 or t_years <= 0.0 or target_price <= 0.0:
        return None
    intrinsic = max(forward - strike, 0.0) if is_call else max(strike - forward, 0.0)
    upper_bound = forward if is_call else strike
    if target_price <= intrinsic + 1e-6 or target_price >= upper_bound:
        return None

    p_lo = bs_price(is_call, forward, strike, t_years, lo)
    p_hi = bs_price(is_call, forward, strike, t_years, hi)
    if target_price < p_lo or target_price > p_hi:
        return None

    a, b = lo, hi
    for _ in range(iterations):
        mid = 0.5 * (a + b)
        p_mid = bs_price(is_call, forward, strike, t_years, mid)
        if p_mid < target_price:
            a = mid
        else:
            b = mid

    vol = 0.5 * (a + b)
    if vol < 0.06 or vol > 2.50:
        return None
    err = abs(bs_price(is_call, forward, strike, t_years, vol) - target_price)
    if err > max(0.02, 0.02 * target_price):
        return None
    return vol


def format_strike_key(k: float) -> str:
    if abs(k - round(k)) < 1e-9:
        return str(int(round(k)))
    return f"{k:.4f}".rstrip("0").rstrip(".")


def normalize_strike_num(k: float) -> float | int:
    if abs(k - round(k)) < 1e-9:
        return int(round(k))
    return round(k, 4)


def parse_exp_utc_ts(exp_str: str, settlement_utc_hour: int) -> int:
    dt = datetime.strptime(exp_str, "%Y-%m-%d").replace(
        hour=settlement_utc_hour, minute=0, second=0, microsecond=0, tzinfo=timezone.utc
    )
    return int(dt.timestamp())


def extract_expirations_list(df: Any) -> List[str]:
    if df is None:
        return []
    if hasattr(df, "columns") and "expiration" in df.columns:
        raw = df["expiration"].to_list()
    elif hasattr(df, "to_list"):
        raw = df.to_list()
    elif isinstance(df, (list, tuple)):
        raw = list(df)
    else:
        return []

    out: List[str] = []
    for item in raw:
        s = str(item).strip()
        if len(s) >= 10:
            s = s[:10]
        try:
            datetime.strptime(s, "%Y-%m-%d")
            out.append(s)
        except ValueError:
            continue
    return sorted(set(out))


def select_expirations(
    expirations: List[str], now_ts: int, settlement_utc_hour: int
) -> Tuple[List[str], Optional[str], Optional[str]]:
    upcoming = [e for e in expirations if parse_exp_utc_ts(e, settlement_utc_hour) > now_ts]
    if not upcoming:
        return [], None, None

    nearest_exp: Optional[str] = None
    for e in upcoming:
        if parse_exp_utc_ts(e, settlement_utc_hour) - now_ts >= 8 * 3600:
            nearest_exp = e
            break
    if nearest_exp is None:
        nearest_exp = upcoming[0]

    exp_set = set(upcoming)
    weekly_exp: Optional[str] = None
    for e in upcoming:
        exp_ts = parse_exp_utc_ts(e, settlement_utc_hour)
        if exp_ts - now_ts < 72 * 3600:
            continue
        dt = datetime.strptime(e, "%Y-%m-%d")
        if dt.weekday() == 4:  # Friday
            weekly_exp = e
            break
        if dt.weekday() == 3:  # Holiday-adjusted Thursday when Friday is unlisted
            next_fri = (dt + timedelta(days=1)).strftime("%Y-%m-%d")
            if next_fri not in exp_set:
                weekly_exp = e
                break
    if weekly_exp is None:
        for e in upcoming:
            if parse_exp_utc_ts(e, settlement_utc_hour) - now_ts >= 72 * 3600:
                weekly_exp = e
                break
    if weekly_exp is None:
        weekly_exp = nearest_exp

    return upcoming[:16], nearest_exp, weekly_exp


def to_utc_ts(val: Any) -> Optional[int]:
    if val is None:
        return None
    if isinstance(val, datetime):
        if val.tzinfo is None:
            return int(val.replace(tzinfo=timezone.utc).timestamp())
        return int(val.astimezone(timezone.utc).timestamp())
    return None


def analyze_snapshot(
    df: Any,
    exp_str: str,
    now_ts: int,
    settlement_utc_hour: int,
) -> Dict[str, Any]:
    if df is None or (hasattr(df, "height") and df.height == 0):
        return {
            "strikes": [],
            "atmIv": None,
            "strikeIvs": {},
            "syntheticForward": None,
        }

    strikes_col = df["strike"].to_list()
    rights_col = df["right"].to_list()
    bids_col = df["bid"].to_list()
    asks_col = df["ask"].to_list()
    ts_col = df["timestamp"].to_list() if "timestamp" in df.columns else [None] * len(strikes_col)

    all_listed_strikes = set()
    # Map strike -> {"CALL": mid, "PUT": mid}
    sanitized: Dict[float, Dict[str, float]] = {}
    quote_timestamps: List[int] = []

    for k_raw, right_raw, bid_raw, ask_raw, ts_raw in zip(
        strikes_col, rights_col, bids_col, asks_col, ts_col
    ):
        try:
            k = float(k_raw)
        except (TypeError, ValueError):
            continue
        if not math.isfinite(k) or k <= 0.0:
            continue
        k = round(k, 4)
        all_listed_strikes.add(k)

        right = str(right_raw).strip().upper()
        if right in ("C", "CALL"):
            right = "CALL"
        elif right in ("P", "PUT"):
            right = "PUT"
        else:
            continue

        try:
            bid = float(bid_raw)
            ask = float(ask_raw)
        except (TypeError, ValueError):
            continue

        # Sanitize invalid, crossed, or illiquid (>30% spread) quotes
        if not (math.isfinite(bid) and math.isfinite(ask)):
            continue
        if bid <= 0.0 or ask <= 0.0 or bid > ask:
            continue
        mid = 0.5 * (bid + ask)
        if mid <= 0.0 or (ask - bid) / mid > 0.30:
            continue

        sanitized.setdefault(k, {})[right] = mid
        q_ts = to_utc_ts(ts_raw)
        if q_ts is not None and q_ts <= now_ts + 300:
            quote_timestamps.append(q_ts)

    # Compute Put-Call Parity synthetic forward: F = K + C_mid - P_mid
    pcp_candidates: List[Tuple[float, float]] = []
    for k, sides in sanitized.items():
        if "CALL" in sides and "PUT" in sides:
            c_mid = sides["CALL"]
            p_mid = sides["PUT"]
            fwd = k + c_mid - p_mid
            if math.isfinite(fwd) and fwd > 0.0:
                pcp_candidates.append((abs(c_mid - p_mid), fwd))

    synthetic_forward: Optional[float] = None
    if pcp_candidates:
        pcp_candidates.sort(key=lambda item: item[0])
        top_fwds = [fwd for _, fwd in pcp_candidates[:5]]
        synthetic_forward = statistics.median(top_fwds)
    elif sanitized:
        synthetic_forward = statistics.median(sorted(sanitized.keys()))

    exp_ts = parse_exp_utc_ts(exp_str, settlement_utc_hour)
    # Use the latest active quote timestamp (handles weekends/holidays/after-hours cleanly)
    val_ts = now_ts
    if quote_timestamps:
        quote_timestamps.sort()
        ref_q_ts = quote_timestamps[int(0.9 * (len(quote_timestamps) - 1))]
        # Guard against stale timestamps (> 7 days old) or post-expiry timestamps
        if ref_q_ts < exp_ts - 600 and (now_ts - ref_q_ts) <= 7 * 86400:
            val_ts = ref_q_ts

    t_years = max(exp_ts - val_ts, 3600) / (365.0 * 86400.0)

    sorted_all_strikes = sorted(all_listed_strikes)
    if synthetic_forward is not None and synthetic_forward > 0.0:
        min_k = synthetic_forward * 0.75
        max_k = synthetic_forward * 1.25
        filtered_strikes = [
            normalize_strike_num(k) for k in sorted_all_strikes if min_k <= k <= max_k
        ]
    else:
        filtered_strikes = [normalize_strike_num(k) for k in sorted_all_strikes]

    strike_ivs: Dict[str, float] = {}
    solved_pairs: List[Tuple[float, float]] = []

    if synthetic_forward is not None and synthetic_forward > 0.0:
        for k in sorted(sanitized.keys()):
            if k < synthetic_forward * 0.70 or k > synthetic_forward * 1.30:
                continue
            sides = sanitized[k]
            # Prefer OTM option for tighter spreads & better Vega conditioning
            preferred_order = (
                [("CALL", True), ("PUT", False)]
                if k >= synthetic_forward
                else [("PUT", False), ("CALL", True)]
            )
            solved: Optional[float] = None
            for side_name, is_call in preferred_order:
                if side_name not in sides:
                    continue
                iv = solve_bs_iv(is_call, synthetic_forward, k, t_years, sides[side_name])
                if iv is not None:
                    solved = iv
                    break
            if solved is not None:
                rounded_iv = round(solved, 4)
                strike_ivs[format_strike_key(k)] = rounded_iv
                solved_pairs.append((k, rounded_iv))

    atm_iv: Optional[float] = None
    if solved_pairs and synthetic_forward is not None:
        below = [p for p in solved_pairs if p[0] <= synthetic_forward]
        above = [p for p in solved_pairs if p[0] >= synthetic_forward]
        if below and above:
            k_lo, iv_lo = below[-1]
            k_hi, iv_hi = above[0]
            if abs(k_hi - k_lo) < 1e-9:
                atm_iv = round(iv_lo, 4)
            elif (k_hi - k_lo) <= synthetic_forward * 0.08:
                w = (synthetic_forward - k_lo) / (k_hi - k_lo)
                atm_iv = round(iv_lo + w * (iv_hi - iv_lo), 4)
            else:
                nearest_pair = min(solved_pairs, key=lambda p: abs(p[0] - synthetic_forward))
                atm_iv = round(nearest_pair[1], 4)
        else:
            nearest_pair = min(solved_pairs, key=lambda p: abs(p[0] - synthetic_forward))
            atm_iv = round(nearest_pair[1], 4)

    return {
        "strikes": filtered_strikes,
        "atmIv": atm_iv,
        "strikeIvs": strike_ivs,
        "syntheticForward": round(synthetic_forward, 4) if synthetic_forward is not None else None,
    }


def sanitize_error(msg: str, secret: str) -> str:
    if secret and secret in msg:
        return msg.replace(secret, "[REDACTED]")
    return msg


def main() -> int:
    parser = argparse.ArgumentParser(description="Fetch NVDA option chain & IV via ThetaData")
    parser.add_argument("--symbol", default=os.environ.get("THETADATA_SYMBOL", "NVDA"))
    parser.add_argument(
        "--settlement-utc-hour",
        type=int,
        default=int(os.environ.get("NVDAB_SETTLEMENT_UTC_HOUR", "21")),
    )
    args = parser.parse_args()

    api_key = os.environ.get("THETADATA_API_KEY", "").strip()
    if not api_key:
        sys.stderr.write("THETADATA_API_KEY environment variable is not set\n")
        return 1

    try:
        from thetadata import ThetaClient  # type: ignore

        now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
        now_ts = now_ms // 1000

        client = ThetaClient(api_key=api_key)
        exp_df = client.option_list_expirations(args.symbol)
        all_exps = extract_expirations_list(exp_df)
        upcoming, nearest_exp, weekly_exp = select_expirations(
            all_exps, now_ts, args.settlement_utc_hour
        )

        nearest_data = (
            analyze_snapshot(
                client.option_snapshot_quote(args.symbol, expiration=nearest_exp),
                nearest_exp,
                now_ts,
                args.settlement_utc_hour,
            )
            if nearest_exp
            else {"strikes": [], "atmIv": None, "strikeIvs": {}, "syntheticForward": None}
        )

        if weekly_exp and weekly_exp != nearest_exp:
            weekly_data = analyze_snapshot(
                client.option_snapshot_quote(args.symbol, expiration=weekly_exp),
                weekly_exp,
                now_ts,
                args.settlement_utc_hour,
            )
        else:
            weekly_data = nearest_data

        payload = {
            "symbol": args.symbol,
            "expirations": upcoming,
            "nearestExp": nearest_exp,
            "weeklyExp": weekly_exp,
            "strikes": nearest_data["strikes"],
            "atmIv": nearest_data["atmIv"],
            "strikeIvs": nearest_data["strikeIvs"],
            "weeklyStrikes": weekly_data["strikes"],
            "weeklyAtmIv": weekly_data["atmIv"],
            "weeklyStrikeIvs": weekly_data["strikeIvs"],
            "syntheticForward": nearest_data["syntheticForward"],
            "weeklySyntheticForward": weekly_data["syntheticForward"],
            "fetchedAtMs": int(datetime.now(timezone.utc).timestamp() * 1000),
        }
        sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
        return 0
    except Exception as exc:
        err_msg = sanitize_error(f"{type(exc).__name__}: {exc}", api_key)
        sys.stderr.write(f"fetch-thetadata-iv failed: {err_msg}\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

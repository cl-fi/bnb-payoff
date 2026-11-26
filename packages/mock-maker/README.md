# `@payoff/mock-maker` — Open-Source Reference / Mock Market Maker

This package contains the complete, transparent reference market-making engine deployed for the Payoff BNB Smart Chain Testnet demo. It is intentionally separated from the core protocol (`packages/contracts` and `packages/server`) to preserve a clean architectural boundary:

- **Core Protocol** (`PayoffSpreadVault.sol`, `AtlasPullSettlementOracle.sol`, `@payoff/server`): permissionless 100%-collateralized vertical spread vault, RFQ router, and trustless on-chain Atlas Pull settlement.
- **Reference Market Maker** (`@payoff/mock-maker`): open-source pricing, 24/7 RWA & crypto risk engine, Quick/Custom shelf builder, and EIP-712 quote signer proving every live testnet quote is driven by real financial math and live Atlas Oracle telemetry—not hardcoded stubs.

---

## Pricing & Risk Algorithm

### 1. European Black-Scholes Valuation Anchored on Live Atlas Spot
Every vertical spread `[K1, K2]` (`width = K2 - K1`) is valued from live **Atlas Oracle spot** (**`#1005` NVDAB/USD RWA**, **`#626` BTC/USD**, **`#632` ETH/USD**) using zero-rate European Black-Scholes (`bsOptionPrice`), with strike IVs averaged symmetrically across call and put legs.

### 2. Strict Put-Call Parity No-Arbitrage
Because `PayoffSpreadVault` mints complementary `UP` + `DOWN` ERC-1155 tokens backed 1:1 by `tUSDT` (`1 UP + 1 DOWN = 1 tUSDT`), every fair mid, open ask, and early-close bid enforces exact no-arbitrage identities:

- **Fair Mid Parity**:
  `UP_fair(K1, K2) + DOWN_fair(K1, K2) === K2 - K1` (clamped to `[0.04W, 0.96W]`)
- **Open Ask No-Arbitrage**:
  `UP_ask + DOWN_ask > K2 - K1` (prevents risk-free mint-and-merge arbitrage against the maker)
- **Early-Close Bid No-Arbitrage**:
  `UP_bid + DOWN_bid < K2 - K1` and `UP_bid < UP_fair < UP_ask`

For `/ops` hedge analytics, `evaluateSpreadHedgeRoutes` continuously compares Direct spreads (`Call(K1) - Call(K2)`) against Put-Call Parity equivalents (`(K2 - K1) + Put(K1) - Put(K2)`) and records parity savings whenever ITM call spreads are wider than OTM put spreads.

### 3. Hysteresis-Locked Strike Grid, Dense Quick Slider & Custom Dual-Range Bounds
- **Fixed Anchor & Dense Quick Tiers**: `buildFixedGridShelf` anchors `BULL` tickets on `gridLow` and `BEAR` tickets on `gridHigh` with a configurable hysteresis buffer (`GRID_CONFIG`), preventing quote flicker around strike boundaries and keeping `[gridLow, gridHigh]` as a shared center liquidity pool. Quick mode densifies target caps across native fine strike steps (`BTC $500`, `ETH $25`/`$50`, `NVDA` real OCC `$1`/`$2.50`/`$5` steps) strictly on the directional side of spot.
- **Server-Authoritative Custom Range Config**: Exposes valid Start and Target Cap combinations plus exact pricing parameters (`pricingParams`) so the frontend renders zero-latency drag previews while the server enforces identical width caps and fair ITM/OTM multiplier guardrails (`~1.15x–20x`) on every `/api/rfq/open` request.

### 4. 24/7 Tokenized Equity RWA Pricing (`NVDAB` / NVIDIA)
For `NVDAB` (`#1005`, `21:00 UTC` US Close MWF expiry calendar):
- **Real OCC Strike Ladder**: Dynamically snaps strikes to equity OCC increments (`$1` below `$150`, `$2.50` across `$150–$200`, `$5` above) with live **ThetaData NVDA option IV** (Sticky-Delta strike skew) when available and safe baseline fallback otherwise.
- **24/7 Session & Spot-Perp Basis Regimes**: Adapts variance time-scaling and spread buffers across DST-aware US market sessions (`RTH`, `EXTENDED`, `WEEKEND`) and live Binance `NVDAUSDT` perpetual basis divergence.
- **Split & Corporate-Action Circuit Breaker**: Immediately halts `OpenQuote` signing whenever `splitGuardTriggered` (`shareMultiplier` drift `> 1.0%`) or `corporateActionBlackout` is active, while keeping `CloseQuote` exits operational.

### 5. Atlas Enterprise `ConsensusScore` Dynamic Risk Engine
`computeConsensusRiskAdjustments(atlasTelemetry)` consumes live Atlas Enterprise `consensusScores` (`consensusScore`, `consensusStatus`, `priceVolatility`) to adapt quoting risk in real time:

| Atlas `consensusStatus` | New `OpenQuote` | Spread Multiplier | IV Floor Boost | Behavior |
|---|---|---|---|---|
| `HEALTHY` (score >= 70%) | Allowed | `1.00x` (`1.15x` if vol spikes) | `0` (or dynamic from `priceVolatility`) | Baseline quoting |
| `DEGRADED` | Allowed | `1.35x` | `>= +5%` | Dynamic spread widening + IV boost |
| `WARNING` | Allowed | `1.85x` - `2.00x` | `>= +12%` | Aggressive spread widening + IV boost |
| `CRITICAL` | **Halted** | `2.75x` (exits only) | `>= +25%` | `ConsensusCircuitBreakerError` on `OpenQuote`; `CloseQuote` remains active |
| `SPLIT_MARKET` | **Halted** | `3.00x` (exits only) | `>= +30%` | `ConsensusCircuitBreakerError` on `OpenQuote`; `CloseQuote` remains active |

When Atlas `priceVolatility` exceeds `0.5%`, the effective volatility floor automatically scales upward, protecting maker inventory against abrupt regime shifts.

### 6. Atomic-Merge Unlock Edge on Reverse-RFQ Early Exits
When a ticket holder sells early (partial or full custom USD exit) before the 30-minute settlement lock, `MockMakerSigner.computeCloseBid` checks the maker's on-chain complementary ERC-1155 balance (`DOWN` when the taker sells `UP`, or vice versa). Whenever matched pairs can be atomically burned inside `PayoffSpreadVault.fillCloseQuote` (`ATOMIC_MERGE_UNLOCK` / `HYBRID`), the maker unlocks locked collateral immediately and passes a `+25 bps` merge-unlock price improvement back to the user.

---

## Third-Party Market Maker Integration Boundary

Any external market maker can compete directly with `@payoff/mock-maker` without changing any smart contract:

1. Get whitelisted on `PayoffSpreadVault` (`setWhitelistedMaker`) and pre-fund `tUSDT` collateral via `depositMakerMargin` (zero standing `MaxUint256` approval required).
2. Price incoming RFQs with your own proprietary vol surface or hedge engine.
3. Return EIP-712 signed `OpenQuote` / `CloseQuote` structs using domain `{ name: "PayoffSpreadVault", version: "2", chainId: 97, verifyingContract }` from `@payoff/shared`.
4. The protocol RFQ router ranks competing quotes strictly by best `maxPayout` (for opens) or highest `buybackAmount` (for early closes).

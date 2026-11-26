# Payoff — Continuous-Payout Prediction Markets on BNB Chain

**Be Right on Direction and Actually Get Paid.**  
*Continuous-payout crypto prediction markets on BNB Chain—turning 60 fragmented all-or-nothing lottery rows into one smooth, zero-liquidation ticket, backed by competitive EIP-712 RFQ liquidity and trustless 30-Minute Atlas Pull Oracle TWAP settlement.*

Built for the **HackQuest BNB Bangkok Hackathon** — targeting the **Developer Track** and the **CoinMarketCap × Atlas Challenge**.

> **Read the 1-page hackathon submission brief:** [`docs/HACKATHON_ONE_PAGER.md`](./docs/HACKATHON_ONE_PAGER.md)  
> **Inspect the transparent odds & market-making engine:** [`packages/mock-maker/README.md`](./packages/mock-maker/README.md)

---

## Why Continuous-Payout Prediction Markets? (Real Product Comparison vs. Polymarket)

Prediction markets like Polymarket and Kalshi have proven massive consumer demand—and **short-term crypto price markets** are one of their highest-frequency daily categories.  
Yet when you open a real daily BTC prediction page on Polymarket today (`BTC spot ≈ $60,276`), **forcing continuous asset prices into `0-or-1` binary contracts creates four concrete, unsolved problems**:

1. **You Can Nail a `+$1,200` Rally and Still Lose `100%` (`$0`)**:
   - On Polymarket's daily BTC market (`spot = $60,276`), buying a **`5.0x`** bullish ticket means picking **`$61,750 or above`** (~20% implied win rate).
   - If BTC surges **`+$1,224` (`+2.0%`)** to **`$61,500`** at expiry, your directional call was completely right—yet a binary market pays you **`$0` (`-100%` wipeout)**.
   - To avoid being wiped out by missing a single threshold, a trader would have to manually split funds across **8–10 separate rows** (`$60,000`, `$60,250`, `$60,500`…), paying spread and fees every time.
2. **60 Fragmented Rows—Over Half Dead (`—`) With Zero Liquidity**:
   - To offer multipliers from `1.01x` to `20x`, binary platforms split a single BTC expiry into **60+ `$250`-spaced orderbooks**. More than half sit completely empty (`—`) because quoting dozens of narrow `0-or-1` thresholds exposes market makers to extreme **expiry pin-risk**.
   - Every row is phrased as `$XX,XXX or above`, forcing bearish traders to mentally invert rows and hunt for `No` liquidity instead of simply clicking **DOWN**.
3. **High-Churn "Lottery Economics" vs. Sustainable Trading Retention**:
   - All-or-nothing tickets wipe retail bankrolls to `$0` ~80% of the time on high-multiplier tiers—users bust twice and churn permanently, forcing platforms to burn acquisition spend.
   - *(Meanwhile, switching to **Perpetual Futures** exposes retail traders to sudden overnight wick liquidations even when their next-day view is right.)*
4. **The Expiry Manipulation Cliff**:
   - In a `0-or-1` price market, moving spot by a few dollars at the exact settlement second flips `100%` of the pot from `YES` to `NO`, creating massive incentives for last-second manipulation.

---

## Side-by-Side Reality Check: The Same `$100` `~5x` BTC Bet (`Spot = $60,276`)

Instead of forcing traders to gamble on one razor-thin price cliff, **Payoff** collapses an entire price ladder into **one continuous-payout ticket**: pick **`UP`** or **`DOWN`** and choose one of **4 liquid Target Multiplier tiers** (`~1.6x` cushioned to `~5x` breakout) above an anchored **Start Line**.

Compare what happens tomorrow at settlement with the **exact same `$100` stake** and **comparable `~5x` max upside**:

| Tomorrow's BTC Settlement Price | Move vs. `$60,276` | Traditional Binary Market<br/>(`$61,750 or above`, `5.0x`) | **Payoff Continuous-Payout**<br/>(`$60,000 → $64,000`, `~4.8x`) | Real Trader Takeaway |
|---|---|---|---|---|
| **`$60,276`** (Flat) | `0.0%` | **`$0`** (`-100%` wipeout) | **`~$33`** (recovers ~1/3 stake) | Sideways doesn't wipe you out |
| **`$60,900`** (Small rally) | `+1.0%` | **`$0`** (`-100%` wipeout) | **`~$108`** (**`+8%` profit**) | Already in profit on a `+1%` move |
| **`$61,500`** (Strong rally) | `+2.0%` | **`$0`** (`-100%` wipeout) | **`~$180`** (**`+80%` profit**) | **Nailed a `+$1,224` rally: `+80%` instead of `-100%`** |
| **`$61,800`** (Breakout) | `+2.5%` | **`$500`** (`+400%` cliff pop) | **`~$216`** (`+116%` profit) | Binary's lottery pop zone vs. smooth scaling |
| **`$64,000`** (Full target) | `+6.2%` | **`$500`** (`+400%`) | **`~$480`** (`+380%` full cap) | Both hit full `~5x` ceiling |

> **Honest Trade-Off**: Binary `0-or-1` markets still win for pure lottery buyers chasing an instant cliff pop right past a single threshold (`$61,800`). **Payoff** is built for **directional traders who want prediction-market simplicity without getting wiped out to `$0` when their thesis is right**—roughly doubling directional win rate on the same `~5x` cap while keeping residual value on sideways days.

---

## How Payoff Solves Every Layer of the Stack

1. **Consumer Experience — One Smooth Ticket Instead of 60 Fragmented Rows**:
   - Clean symmetric **`UP` / `DOWN`** toggles + **4 deep fixed-grid target tiers** (no empty `—` rows, no mental `Buy No` inversion).
   - Every ticket shows **5 plain-English numbers**: **Stake (= Max Loss)**, **Breakeven Price**, **If-Flat Return**, **Target Cap & Max Payout**, and **Live Early-Cashout Value**.
   - **Zero Intraday Liquidations & 1-Click Early Cashout**: Your stake (`tUSDT`) is your absolute maximum loss—overnight wicks can never liquidate you, and you can cash out early anytime before the final 30m settlement window.
2. **Market Maker Economics & Real Protocol Revenue**:
   - **Fixes the "Dead Rows" Liquidity Problem**: Wide continuous-payout ranges strictly bound market-maker exposure near expiry (eliminating the extreme pin-risk that causes binary orderbooks to go empty). Liquidity concentrates on **4 hysteresis-anchored grid tiers** backed `1:1` (`1 UP + 1 DOWN = 1 tUSDT`) inside `PayoffSpreadVault.sol`, with **atomic `UP + DOWN` merge unlocks** immediately freeing maker collateral on early exits.
   - **Built for Sustainable Retention & Day-1 Cashflow**: Because traders aren't constantly wiped to `$0` on near-misses or flat days, retail bankrolls last multiple rounds longer—driving higher repeat volume and organic on-chain USDT protocol fees without relying on token subsidies.
3. **Double-Layer Manipulation Resistance — Continuous Slope + Atlas 30-Minute TWAP & `ConsensusScore`**:
   - **No `$1` Settlement Cliff**: Moving spot by `$10` at expiry barely shifts a continuous payout, removing the economic incentive for last-second settlement manipulation.
   - **Trustless 30-Minute TWAP Expiry Settlement via Atlas Pull Oracle**: Aligned with institutional settlement standards, anyone can settle expired markets permissionlessly on BSC Testnet by submitting **30 deterministic 1-minute Atlas Enterprise signed historical proofs** (`07:31–08:00 UTC`, `/v1/price/history`, `signed: true`). `AtlasPullSettlementOracle` verifies all 30 ECDSA signatures against Atlas's official signer (`0x59eD4701224fD9e2a85Ef2946c2ab828C1dDC600`) in one atomic transaction (`0s` exact-second match within 15m after expiry, `±10s` liveness fallback thereafter), computes the equal-weighted mean once for all redemptions, and locks early closes 30 minutes before expiry.
   - **Deep Atlas Enterprise `ConsensusScore` Protection & Dispute Guard**: Live multi-venue consensus health (`HEALTHY` / `DEGRADED` / `WARNING` / `CRITICAL` / `SPLIT_MARKET`) and `priceVolatility` drive real-time UI badges, dynamic odds-maker risk spreads (fail-closed if Atlas goes offline/stale `>60s`), and a 30-minute aggregate health check (`avgConsensusScore < 0.40` automatically freezes the disputed expiry on-chain via a pause-only `pauser` sentinel for transparent admin `emergencyManualSettle` with a public audit reason).

---

## Architecture Overview

Payoff enforces a clean architectural boundary between the **Core Continuous-Payout Protocol** (permissionless 30m TWAP settlement & 100%-collateralized escrow vault) and the **Open-Source Reference Odds / Market Maker** (`packages/mock-maker`), which prices continuous `[Start Line, Target Cap]` payoff tiers openly in this repository so judges can audit the exact financial math driving every live quote.

```mermaid
flowchart LR
  subgraph External["External Oracle & Market Data"]
    AtlasWS["Atlas Enterprise WS & Pull API<br/>/v1/price/latest + ConsensusScore<br/>/v1/price/history (signed=true)"]
    BinanceK["Binance Public Klines<br/>(Historical Cold-Start Bars Only)"]
  end

  subgraph CoreProtocol["Core Protocol"]
    Web["@payoff/web<br/>React 19 + EIP-6963 Wallets<br/>Atlas ConsensusScore Shield"]
    Server["@payoff/server<br/>Atlas WS/Pull Client + RFQ Router<br/>Permissionless Settlement Keeper<br/>Postgres / SQLite Ledger"]
    subgraph BSC["BNB Smart Chain Testnet (Chain ID 97)"]
      Vault["PayoffSpreadVault.sol<br/>ERC-1155 UP/DOWN + tUSDT Escrow"]
      Lens["PayoffVaultLens.sol<br/>Stateless Read Periphery"]
      Oracle["AtlasPullSettlementOracle.sol<br/>ECDSA Verify 0x59eD...DC600<br/>Expiry-Pinned Settlement"]
      USDT["MockUSDT.sol (tUSDT)<br/>6-dec Testnet Collateral + Faucet"]
    end
  end

  subgraph MockExt["Open-Source Reference / Mock Market Maker"]
    MM["@payoff/mock-maker<br/>BS + Put-Call Parity Pricer<br/>Atlas Volatility & ConsensusScore Guard<br/>EIP-712 Quote Signer"]
  end

  AtlasWS -->|"Live Spot + ConsensusScore"| Server
  AtlasWS -->|"Signed History ExtraData"| Server
  BinanceK -->|"120 Historical Bars"| Server
  Server <-->|"RFQ Request / Signed EIP-712 Quote"| MM
  Web <-->|"HTTP / WS"| Server
  Web -->|"fillOpenQuote / fillCloseQuote / redeem"| Vault
  Web -->|"faucet()"| USDT
  Server -->|"settleWithAtlasTwap(30 proofs)"| Oracle
  Vault -->|"getSettlementPrice()"| Oracle
  Lens -->|"Single eth_call"| Vault
  Vault <--> USDT
```

### Monorepo Packages

| Package | Role | Key Highlights |
|---|---|---|
| [`packages/shared`](./packages/shared) | `@payoff/shared` | BSC Testnet chain config (`97`), Atlas feed IDs (`#626`, `#632`), `MOCK_USDT_ABI`, `ATLAS_SETTLEMENT_ORACLE_ABI`, `PAYOFF_VAULT_ABI`, `PAYOFF_LENS_ABI`, EIP-712 types, Black-Scholes & guardrails |
| [`packages/contracts`](./packages/contracts) | `@payoff/contracts` | `AtlasPullSettlementOracle.sol` (built on `oracle-atlas/pull-oracle-consumer`), `PayoffSpreadVault.sol`, `PayoffVaultLens.sol`, `MockUSDT.sol`, Hardhat tests & BSC Testnet deploy/verify scripts |
| [`packages/mock-maker`](./packages/mock-maker) | `@payoff/mock-maker` | Publicly auditable Reference Market Maker: Black-Scholes + strict Put-Call Parity no-arbitrage (`UP_ask + DOWN_ask > width`, `UP_bid + DOWN_bid < width`), hysteresis fixed strike grid, Atlas `ConsensusScore` & `priceVolatility` risk engine, EIP-712 signer |
| [`packages/server`](./packages/server) | `@payoff/server` | Atlas Enterprise WS + HTTP Pull client, permissionless settlement keeper, thin RFQ router, Binance K-line cold-start anchored to live Atlas spot, Postgres/SQLite indexer & WebSocket feed |
| [`packages/web`](./packages/web) | `@payoff/web` | React 19 + Vite consumer trading app, pure EIP-6963 multi-wallet discovery (Binance Web3 Wallet, MetaMask, Trust Wallet, Rabby, etc.), live `AtlasOracleBadge`, `/ops` solvency & circuit-breaker dashboard |

---

## Deployed Contracts — BNB Smart Chain Testnet (Chain ID `97`)

Deployment manifest: [`packages/contracts/deployments/bscTestnet.json`](./packages/contracts/deployments/bscTestnet.json) (Deployment Block: **`144840259`**)

| Contract | Address (BscScan Testnet) | Decentralized Verification (Sourcify v2) | Role |
|---|---|---|---|
| **`MockUSDT` (`tUSDT`)** | [`0x20845985df410F84c2e30Ba44A19dD564baE9bED`](https://testnet.bscscan.com/address/0x20845985df410F84c2e30Ba44A19dD564baE9bED) | [`exact_match`](https://repo.sourcify.dev/97/0x20845985df410F84c2e30Ba44A19dD564baE9bED) | 6-decimal testnet USDT collateral with public `faucet()` |
| **`AtlasPullSettlementOracle`** | [`0x00ea779192dAd354D25016841e3Ff2Bc8f545114`](https://testnet.bscscan.com/address/0x00ea779192dAd354D25016841e3Ff2Bc8f545114) | [`exact_match`](https://repo.sourcify.dev/97/0x00ea779192dAd354D25016841e3Ff2Bc8f545114) | Permissionless 30m (30×1m) Atlas TWAP ECDSA oracle + dispute pause |
| **`PayoffSpreadVault`** | [`0x5a6AaD747cd5313E31fa663fF719b2a18fF00174`](https://testnet.bscscan.com/address/0x5a6AaD747cd5313E31fa663fF719b2a18fF00174) | [`exact_match`](https://repo.sourcify.dev/97/0x5a6AaD747cd5313E31fa663fF719b2a18fF00174) | Core 100%-collateralized ERC-1155 `UP`/`DOWN` escrow vault (30m close lock) |
| **`PayoffVaultLens`** | [`0x831532F56ac6aB2B628a7b6cEAb1Eef3a828d60E`](https://testnet.bscscan.com/address/0x831532F56ac6aB2B628a7b6cEAb1Eef3a828d60E) | [`exact_match`](https://repo.sourcify.dev/97/0x831532F56ac6aB2B628a7b6cEAb1Eef3a828d60E) | Stateless read-only periphery for single-call UI/indexer queries |

> **On-chain protocol parameters**: `protocolOpenFeeBps = 400` (4%, hard-capped ≤ 500 bps), `protocolCloseFeeBps = 0` (hard-capped ≤ 100 bps), `MIN_OPEN_LEAD_TIME = 1h`, `MIN_CLOSE_LEAD_TIME = 30m`, TWAP `30 samples × 60s` (`settlementDelay = 60s`, `exactMatchGracePeriod = 15m`, `fallbackTimestampTolerance = ±10s`), reference market maker pre-funded with `1,000,000 tUSDT` in `makerMargin` using exact finite approval.

---

## Live Verified On-Chain Atlas Pull Oracle Proof

`AtlasPullSettlementOracle` inherits unmodified `PullOracleConsumerBase` (`oracle-atlas/pull-oracle-consumer`), verifies ECDSA signatures from **Atlas Oracle's official production signer** (`0x59eD4701224fD9e2a85Ef2946c2ab828C1dDC600`, trailing calldata marker `0x7096`), and supports:
- **`BTC/USD`**: Feed ID **`#626`** (`bytes4(0x00000272)`)
- **`ETH/USD`**: Feed ID **`#632`** (`bytes4(0x00000278)`)

### Live BSC Testnet Verification Results (`pnpm verify:atlas:bsc`)

1. **Live `eth_call` `verifyLatestAtlasPrice` (Freshness-checked on BSC Testnet)**:
   - `BTC/USD` (`0x00000272`): **`$59,653.75598044`** @ `ts=1795633291` · `ConsensusScore = 93.27% (HEALTHY)`
   - `ETH/USD` (`0x00000278`): **`$1,679.40804865`** @ `ts=1795633291` · `ConsensusScore = 93.49% (HEALTHY)`

2. **Live Permissionless 30-Point 1-Minute TWAP Settlement Transaction (`settleWithAtlasTwap`)**:
   - **Transaction Hash**: [`0xe4b6067ea5ba92d688746adf0ac547406fada9f28a81e0250137b5265de2dc90`](https://testnet.bscscan.com/tx/0xe4b6067ea5ba92d688746adf0ac547406fada9f28a81e0250137b5265de2dc90) (Block **`144840391`**, **`344,021` gas**)
   - **Call**: `settleWithAtlasTwap(keccak256("BTC"), 1795593600, proofs[30])` with 30 signed Atlas Enterprise `/v1/price/history` (`signed: true`) proofs spanning `2026-11-25T07:31:00Z` to `2026-11-25T08:00:00Z` (`maxTimestampDiff = 0s`)
   - **Verified On-Chain State (`getSettlement` & `getSettlementMeta`)**:
     - `settled`: `true`, `isManualOverride`: `false`, `sampleCount`: `30`
     - `price`: **`$58,750.15513875`** (`5875015513875`, exact 30-point equal-weight arithmetic mean scaled safely from 18-dec Atlas prices)
     - `feedId`: `0x00000272` (`#626`), `window`: `[1795591860 .. 1795593600]`

---

## Deep Atlas Enterprise `ConsensusScore` Integration

Rather than treating an oracle as a passive price number, Payoff wires Atlas Enterprise **`consensusScores`** (`consensusScore`, `consensusStatus`, `twapPrice`, `medianPrice`, `priceVolatility`) across all three layers of the stack:

1. **Consumer UI — Real-Time Atlas Oracle Live Shield (`AtlasOracleBadge.tsx`) & Self-Service Settlement**:
   - Displays live `Atlas Oracle · HEALTHY · 93%`, Feed ID (`#626 BTC/USD` / `#632 ETH/USD`), TWAP vs. Median spread, `priceVolatility`, and clearly separated clickable BscScan links for the **Oracle Contract** and **Authorized ECDSA Signer**.
   - On `/positions`, locks Early Close during the final 30m TWAP window and provides a permissionless **"Settle with Atlas 30m TWAP"** wallet action after expiry (or a clear disputed-pause notice if frozen).
2. **Backend — 30m TWAP Health Sentinel & Permissionless Settlement Keeper (`atlasOracle.ts` + `chainService.ts`)**:
   - Streams live updates over `wss://push.atlasoracle.io/ws` (with zombie-socket ping/reconnect watchdog and automatic HTTP fallback to `POST /v1/price/latest`, strict server-side `X-API-KEY` isolation).
   - Aggregates 1-minute bucketed `consensusScore` observations across the final 30 minutes (`07:31–08:00 UTC`). In a two-pass keeper cycle (sentinel freeze checks run before any proof fetch), if coverage reaches `>= 20/30` minutes and the average drops below **`40%` (`0.40`)**—or becomes mathematically irrecoverable before expiry—the `pauser` sentinel immediately calls `pauseExpiry()` on-chain during the 60s pre-permissionless buffer to lock out bad data for transparent admin `emergencyManualSettle(assetId, expiry, price, reason)` (sparse windows with `< 20/30` minutes fail open with a warning so server downtime never halts normal settlement; Gnosis Safe multisig + timelock planned for mainnet).
3. **Reference Market Maker — Dynamic Spread & Fail-Closed Quoting Guard (`packages/mock-maker` + `rfqGateway.ts`)**:
   - `computeConsensusRiskAdjustments(atlasTelemetry)` widens ask/bid spreads (`1.35x` on `DEGRADED`, `1.85x–2.0x` on `WARNING`) and boosts the Black-Scholes IV floor automatically when `priceVolatility > 0.5%` (single-source in `ShelfEngine`, zero double-counting).
   - Halts new `OpenQuote` signing on `CRITICAL` / `SPLIT_MARKET`, and fails closed (HTTP 503) on both Open & Close RFQs if the live Atlas feed goes offline or stale (`>60s` local / `>90s` oracle timestamp).
   - Full mathematical specification and Put-Call Parity proof in [`packages/mock-maker/README.md`](./packages/mock-maker/README.md).

---

## Local Setup, Testing & Deployment

### Prerequisites
- Node.js `>= 20` and `pnpm@10.32.0`
- An Atlas Enterprise API key (`ATLAS_API_KEY`) for live Atlas WS/Pull data (unit tests run 100% offline with embedded production Atlas signature fixtures)

### 1. Install & Configure Environment
```bash
pnpm install
cp .env.example .env
# Edit .env to supply your server-side ATLAS_API_KEY (and TESTNET_WALLET_PK / MM1_PRIVATE_KEY if deploying)
# Never expose ATLAS_API_KEY or private keys to packages/web or commit .env
```

### 2. Build & Run Full Automated Test Suite (`47/47` Passing)
```bash
pnpm build:shared && pnpm test:shared          # 12/12 passing
pnpm build:mock-maker && pnpm test:mock-maker  #  4/4 passing
CI=true pnpm compile:contracts && CI=true pnpm test:contracts  # 16/16 passing (incl. 30-pt TWAP, dispute pause, & real Atlas 0x59eD...DC600 tests)
pnpm test:server && pnpm build:server          # 15/15 passing
pnpm build:web                                 # React 19 + Vite production bundle
pnpm typecheck                                 # Full workspace strict TypeScript check
```

### 3. Run Locally Against Deployed BSC Testnet Contracts
```bash
# Terminal 1: Start API + WebSocket server (reads packages/contracts/deployments/bscTestnet.json)
pnpm dev:server

# Terminal 2: Start React 19 frontend (http://localhost:5173)
pnpm dev:web
```
Optional Docker setup (PostgreSQL 16 + Server):
```bash
docker compose up --build
```

### 4. Deploy & Verify Contracts on BNB Smart Chain Testnet
```bash
# Deploy MockUSDT, AtlasPullSettlementOracle, PayoffSpreadVault, PayoffVaultLens + fund MM margin
pnpm deploy:bsc

# Verify live Atlas Pull eth_call + execute real on-chain 30-point settleWithAtlasTwap tx on BSC Testnet
pnpm verify:atlas:bsc

# Verify all 4 contracts on Sourcify v2 (and BscScan when BSCSCAN_API_KEY is set)
pnpm --filter @payoff/contracts verify:bsc
```

### 5. Emergency Admin Settlement CLI (Disputed Expiries)
When an expiry is frozen on-chain (either automatically by the `pauser` sentinel on `avgConsensusScore < 0.40`, or manually by the admin), automated TWAP settlement is locked and must be resolved via [`packages/contracts/scripts/emergency-settle.ts`](./packages/contracts/scripts/emergency-settle.ts) (owner/pauser private key only, never exposed via HTTP API):

```bash
cd packages/contracts

# 1. Optional: manually freeze a disputed expiry (verifies on-chain configured asset, 08:00 UTC seconds timestamp, and post-tx paused state)
ACTION=pause ASSET=BTC EXPIRY=1795593600 npx hardhat run scripts/emergency-settle.ts --network bscTestnet

# 2. Dry-run irreversible manual settlement (prints live on-chain state & runs staticcall without broadcasting)
ACTION=settle ASSET=BTC EXPIRY=1795593600 PRICE_USD=64250.50 REASON="Atlas 30m avg score < 0.40" npx hardhat run scripts/emergency-settle.ts --network bscTestnet

# 3. Broadcast confirmed manual settlement on BSC Testnet (requires explicit CONFIRM=yes on non-local chains)
ACTION=settle ASSET=BTC EXPIRY=1795593600 PRICE_USD=64250.50 REASON="Atlas 30m avg score < 0.40" CONFIRM=yes npx hardhat run scripts/emergency-settle.ts --network bscTestnet
```
> Built-in safety rails: refuses ephemeral `--network hardhat`, rejects unconfigured asset names or millisecond timestamps (use `FORCE=1` only for non-`08:00 UTC` test expiries), parses `PRICE_USD` strictly with `ethers.parseUnits(raw, 8)` (no float rounding), and requires `CONFIRM=yes` before broadcasting `emergencyManualSettle`.

---

## Security & Privacy Highlights

- **100% Collateralized Vault Invariant**: `usdt.balanceOf(vault) >= totalLockedUsdt + totalMakerMargin + accruedProtocolFees` enforced across every open, early close, atomic merge, redeem, fee pull, and rescue path.
- **Role-Separated Governance & Pause-Exempt Exits**: `Ownable2Step`, `ReentrancyGuard`, `Pausable`, dedicated `pauser` & `feeCollector`; `merge()`, `redeem()`, and `withdrawMakerMargin()` remain intentionally unpaused so users and makers can always recover funds.
- **Server-Side Secret Isolation**: `ATLAS_API_KEY` and maker private keys live exclusively in gitignored `.env` on the backend—never bundled into `packages/web`, never returned by `/api/health` or `/api/oracle/consensus`, and never committed to Git.

## License

- Core protocol (`packages/shared`, `packages/contracts`, `packages/mock-maker`, `packages/server`, `packages/web`): MIT License.
- Vendored Atlas Pull Oracle consumer libraries (`packages/contracts/contracts/atlas/*`): `BUSL-1.1` (original headers preserved from [`oracle-atlas/pull-oracle-consumer`](https://github.com/oracle-atlas/pull-oracle-consumer)).

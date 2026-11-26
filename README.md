# Payoff — A Prediction Market Built for Prices, Not Events

**Pick Direction. Pick Multiplier. Get Paid as Price Moves.**  
*An event is yes or no. A price is continuous, so the payout should be too. Payoff pays by how far the price moves, with no `0-or-1` cliff. Live on BNB Chain testnet with 24/7 `NVDA` (tokenized equity), `BTC`, and `ETH`.*

Built for the **HackQuest BNB Bangkok Hackathon** — targeting the **Developer Track** and the **CoinMarketCap × Atlas Challenge**.

> **Try Live Now (BNB Smart Chain Testnet):** [https://bnb.payoff.finance/](https://bnb.payoff.finance/)  
> *1-click email login · gasless transactions (zero `tBNB` needed) · automatic **`1,000 tUSDT`** welcome airdrop · live 24/7 **`NVDA` RWA**, **`BTC`**, and **`ETH`**.*  
> **1-Page Brief:** [`docs/HACKATHON_ONE_PAGER.md`](./docs/HACKATHON_ONE_PAGER.md) · **Open-Source Pricing Math:** [`packages/mock-maker/README.md`](./packages/mock-maker/README.md)

---

## Why Payoff?

Today, directional traders are stuck between two brutal extremes:

- **Binary Prediction Markets (`0` or `1`)** are unforgiving: get the direction right, miss the strike by `$10`, and you lose `100%`. Fragmented price rows split liquidity and leave users juggling multiple orderbooks.
- **Perpetual Futures (Perps)** pay linearly, but one overnight wick liquidates your position—even when your next-day view is right.

**Payoff bridges both.** You still just pick **Up / Down** and your **target multiplier**—but your payout scales **linearly** with price: **zero intraday liquidation, no instant wipeout on flat days, and the further price moves in your favor, the more you earn.**

| | Binary Prediction Markets | Perpetual Futures | **Payoff (Continuous Payout)** |
|---|---|---|---|
| **UX** | Fragmented `or above` rows | Margin, funding, stop-losses | **Pick `Up / Down` + 1 slider** |
| **Intraday Liquidation** | None | **Yes (wicked out overnight)** | **None (capped max loss)** |
| **Right Direction, Miss Target** | **`$0` (`-100%` wipeout)** | Profitable if not liquidated | **Paid linearly as price moves** |
| **Flat Expiry** | Often `$0` | Fees / funding bleed | **Retains residual value** |
| **Expiry Manipulation** | Severe `$1` binary cliff | Mark-price wicks | **Smooth slope + Atlas 30m TWAP** |

### Quick Example: Same `$100` Stake, `~5x` Max Upside (`BTC Spot = $60,276`)

![Same $100 stake: a binary ticket pays nothing until price crosses its strike, while Payoff pays more as price moves. On a +2% move, binary pays $0 and Payoff pays about $180.](./docs/assets/payoff-vs-binary.svg)

| Tomorrow's Settlement | Binary (`$61,750+`, `5.0x`) | **Payoff (`$60,000 → $64,000`, `~4.8x`)** |
|---|---|---|
| **`$60,276`** (Flat) | `$0` (`-100%`) | **`~$33`** (recovers ~1/3 stake) |
| **`$60,900`** (`+1.0%`) | `$0` (`-100%`) | **`~$108`** (**`+8%` profit**) |
| **`$61,500`** (`+2.0%`) | `$0` (`-100%`) | **`~$180`** (**`+80%` profit**) |
| **`$64,000`** (`+6.2%`) | `$500` (`+400%`) | **`~$480`** (`+380%` full cap) |

> *Binary markets still win for pure lottery buyers chasing an all-or-nothing pop right past a single threshold. Payoff is built for directional traders who want prediction-market simplicity without binary wipeouts or perp liquidations—live on **24/7 `NVDA` RWA**, **`BTC`**, and **`ETH`**, backed by `1:1` collateralized pools (with atomic early-exit merges) and **Atlas Pull Oracle 30-Minute TWAP + `ConsensusScore`** protection.*

---

# Technical Reference & On-Chain Verification

*Everything below is the full protocol specification, Atlas Enterprise oracle integration, deployed BSC Testnet proof, test suite, and operations guide for technical judges and automated review agents.*

## Live Markets & Settlement Specification

Payoff runs **three live continuous-payout markets** on BNB Smart Chain Testnet, landing by default on **NVIDIA (`NVDA`) RWA**:

| Market | Asset Class | Atlas Pull Feed ID | Settlement Schedule (30m TWAP) | Pricing & Risk Engine |
|---|---|---|---|---|
| **`NVDA` (`NVDAB`, Default)** | Tokenized US Equity RWA (`bStock`) | **`#1005`** (`0x000003ed`, `NVDAB/USD`) | **US Equity Close `21:00 UTC`** (`20:31–21:00 UTC`, Mon/Wed/Fri & NYSE holiday calendar) | Real OCC strike ladder (`$1` / `$2.50` / `$5`), ThetaData live NVDA option IV surface, 24/7 session regimes (`RTH` / `EXTENDED` / `WEEKEND`), Binance Perp spot-perp basis buffer, automatic **>1% `shareMultiplier` split & corporate-action circuit breaker** |
| **`BTC`** | Crypto | **`#626`** (`0x00000272`, `BTC/USD`) | **Daily & Weekly `08:00 UTC`** (`07:31–08:00 UTC`) | Fine `$500` strike grid + Black-Scholes & strict Put-Call Parity + Atlas `ConsensusScore` spread/IV guard |
| **`ETH`** | Crypto | **`#632`** (`0x00000278`, `ETH/USD`) | **Daily & Weekly `08:00 UTC`** (`07:31–08:00 UTC`) | Fine `$25` / `$50` strike grid + Black-Scholes & strict Put-Call Parity + Atlas `ConsensusScore` spread/IV guard |

---

## Architecture Overview

Payoff enforces a clean architectural boundary between the **Core Continuous-Payout Protocol** (permissionless 30m TWAP settlement & 100%-collateralized escrow vault) and the **Open-Source Reference Market Maker** (`packages/mock-maker`), which prices continuous `[Start Line, Target Cap]` payoff ranges openly in this repository so judges can audit the exact financial math driving every live quote.

```mermaid
flowchart LR
  subgraph External["External Oracle & RWA Market Data"]
    AtlasWS["Atlas Enterprise WS & Pull API<br/>#626 BTC · #632 ETH · #1005 NVDAB<br/>/v1/price/latest + ConsensusScore<br/>/v1/price/history (signed=true)"]
    RwaData["ThetaData Live NVDA Option IV<br/>Binance Perp Basis & Historical Klines"]
  end

  subgraph CoreProtocol["Core Protocol"]
    Web["@payoff/web<br/>React 19 Pure-OLED App (EN/ZH)<br/>Privy Email + Gasless Embedded Wallet<br/>Custom SVG Forecast + Atlas Shield"]
    Server["@payoff/server<br/>Atlas WS/Pull Client + RwaRiskService<br/>RFQ Router + Welcome Airdrop<br/>Permissionless TWAP Keeper + Indexer"]
    subgraph BSC["BNB Smart Chain Testnet (Chain ID 97)"]
      Vault["PayoffSpreadVault.sol<br/>ERC-1155 UP/DOWN + tUSDT Escrow<br/>batchRedeem & Atomic Merge"]
      Lens["PayoffVaultLens.sol<br/>Stateless Read Periphery"]
      Oracle["AtlasPullSettlementOracle.sol<br/>ECDSA Verify 0x59eD...DC600<br/>30-pt TWAP + Dispute Pause"]
      USDT["MockUSDT.sol (tUSDT)<br/>6-dec Testnet Collateral + Faucet"]
    end
  end

  subgraph MockExt["Open-Source Reference / Mock Market Maker"]
    MM["@payoff/mock-maker<br/>BS + Put-Call Parity + OCC RWA Grid<br/>Quick/Custom Bounds + Consensus Guard<br/>EIP-712 Quote Signer"]
  end

  AtlasWS -->|"Live Spot + ConsensusScore"| Server
  AtlasWS -->|"Signed History ExtraData"| Server
  RwaData -->|"Live IV / Basis / Cold-Start Bars"| Server
  Server <-->|"RFQ Request / Signed EIP-712 Quote"| MM
  Web <-->|"HTTP / WS + Privy Auth"| Server
  Web -->|"fillOpenQuote / fillCloseQuote / batchRedeem"| Vault
  Web -->|"faucet()"| USDT
  Server -->|"settleWithAtlasTwap(30 proofs) / pauseExpiry"| Oracle
  Vault -->|"getSettlementPrice()"| Oracle
  Lens -->|"Single eth_call"| Vault
  Vault <--> USDT
```

### Monorepo Packages

| Package | Role | Key Highlights |
|---|---|---|
| [`packages/shared`](./packages/shared) | `@payoff/shared` | BSC Testnet chain config (`97`), Atlas feed IDs (`#626` BTC, `#632` ETH, `#1005` NVDAB), US equity holiday/MWF expiry calendar, contract ABIs, EIP-712 types, Black-Scholes, Quick/Custom client preview & guardrails |
| [`packages/contracts`](./packages/contracts) | `@payoff/contracts` | `AtlasPullSettlementOracle.sol` (built on `oracle-atlas/pull-oracle-consumer`), `PayoffSpreadVault.sol` (100%-collateralized ERC-1155 `UP`/`DOWN`, `batchRedeem`, atomic `UP+DOWN` merge), `PayoffVaultLens.sol`, `MockUSDT.sol`, Hardhat tests, deploy/verify & RWA registration scripts |
| [`packages/mock-maker`](./packages/mock-maker) | `@payoff/mock-maker` | Publicly auditable Reference Market Maker: Black-Scholes + strict Put-Call Parity no-arbitrage, dense Quick & Custom dual-range shelf, NVDAB OCC strikes & 24/7 RWA session/basis/split guards, Atlas `ConsensusScore` risk engine, EIP-712 signer |
| [`packages/server`](./packages/server) | `@payoff/server` | Atlas Enterprise WS + HTTP Pull client, `RwaRiskService` (ThetaData IV, Binance Perp basis, >1% split guard), Privy token verification & `1,000 tUSDT` welcome airdrop, permissionless TWAP keeper, thin RFQ router, Postgres/SQLite indexer & WebSocket stream |
| [`packages/web`](./packages/web) | `@payoff/web` | React 19 + Vite pure-black OLED consumer app (defaulting to **NVDA RWA**, EN/ZH), Privy email gasless login + faucet/wallet controls, Quick & Custom dual-range sliders, custom SVG forecast & mini PnL charts with price scrubber, Spotlight tour, `Powered by Atlas` live inspector, arbitrary-amount early cashout (`1.5%` slippage guard), single-column `Portfolio` with `batchRedeem`, `/ops` solvency dashboard |

---

## Deployed Contracts — BNB Smart Chain Testnet (Chain ID `97`)

Deployment manifest: [`packages/contracts/deployments/bscTestnet.json`](./packages/contracts/deployments/bscTestnet.json) (Deployment Block: **`144840259`**)

| Contract | Address (BscScan Testnet) | Decentralized Verification (Sourcify v2) | Role |
|---|---|---|---|
| **`MockUSDT` (`tUSDT`)** | [`0x20845985df410F84c2e30Ba44A19dD564baE9bED`](https://testnet.bscscan.com/address/0x20845985df410F84c2e30Ba44A19dD564baE9bED) | [`exact_match`](https://repo.sourcify.dev/97/0x20845985df410F84c2e30Ba44A19dD564baE9bED) | 6-decimal testnet USDT collateral with public `faucet()` & welcome airdrop mint |
| **`AtlasPullSettlementOracle`** | [`0x00ea779192dAd354D25016841e3Ff2Bc8f545114`](https://testnet.bscscan.com/address/0x00ea779192dAd354D25016841e3Ff2Bc8f545114) | [`exact_match`](https://repo.sourcify.dev/97/0x00ea779192dAd354D25016841e3Ff2Bc8f545114) | Permissionless 30m (30×1m) Atlas TWAP ECDSA oracle (`BTC`, `ETH`, `NVDAB`) + dispute pause |
| **`PayoffSpreadVault`** | [`0x5a6AaD747cd5313E31fa663fF719b2a18fF00174`](https://testnet.bscscan.com/address/0x5a6AaD747cd5313E31fa663fF719b2a18fF00174) | [`exact_match`](https://repo.sourcify.dev/97/0x5a6AaD747cd5313E31fa663fF719b2a18fF00174) | Core 100%-collateralized ERC-1155 `UP`/`DOWN` escrow vault (30m close lock + `batchRedeem` + atomic merge) |
| **`PayoffVaultLens`** | [`0x831532F56ac6aB2B628a7b6cEAb1Eef3a828d60E`](https://testnet.bscscan.com/address/0x831532F56ac6aB2B628a7b6cEAb1Eef3a828d60E) | [`exact_match`](https://repo.sourcify.dev/97/0x831532F56ac6aB2B628a7b6cEAb1Eef3a828d60E) | Stateless read-only periphery for single-call UI/indexer queries |

> **On-chain protocol parameters**: `protocolOpenFeeBps = 400` (4%, hard-capped ≤ 500 bps), `protocolCloseFeeBps = 0` (hard-capped ≤ 100 bps), `MIN_OPEN_LEAD_TIME = 1h`, `MIN_CLOSE_LEAD_TIME = 30m`, TWAP `30 samples × 60s` (`settlementDelay = 60s`, `exactMatchGracePeriod = 15m`, `fallbackTimestampTolerance = ±10s`), reference market maker pre-funded with `1,000,000 tUSDT` in `makerMargin` using exact finite approval.

---

## Live Verified On-Chain Atlas Pull Oracle Proof

`AtlasPullSettlementOracle` inherits unmodified `PullOracleConsumerBase` (`oracle-atlas/pull-oracle-consumer`), verifies ECDSA signatures from **Atlas Oracle's official production signer** (`0x59eD4701224fD9e2a85Ef2946c2ab828C1dDC600`, trailing calldata marker `0x7096`), and supports:
- **`NVDAB/USD` (Default RWA)**: Feed ID **`#1005`** (`bytes4(0x000003ed)`), `21:00 UTC` US Close TWAP
- **`BTC/USD`**: Feed ID **`#626`** (`bytes4(0x00000272)`), `08:00 UTC` TWAP
- **`ETH/USD`**: Feed ID **`#632`** (`bytes4(0x00000278)`), `08:00 UTC` TWAP

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

## Deep Atlas Enterprise `ConsensusScore` & RWA Guard Integration

Rather than treating an oracle as a passive price number, Payoff wires Atlas Enterprise **`consensusScores`** (`consensusScore`, `consensusStatus`, `twapPrice`, `medianPrice`, `priceVolatility`) and RWA feed metadata (`shareMultiplier`) across all three layers of the stack:

1. **Consumer UI — `Powered by Atlas` Pill & Real-Time Oracle Shield (`AtlasBrand.tsx` + `AtlasOracleBadge.tsx`)**:
   - Surfaces the official Atlas brand mark directly beside the live spot price on `Trade`; clicking opens the native `<dialog>` **Rules & Oracle** drawer displaying live `HEALTHY` status & `ConsensusScore`, Feed ID (`#1005` / `#626` / `#632`), TWAP vs. Median, `priceVolatility`, separated clickable BscScan links for the **Oracle Contract** and **Authorized ECDSA Signer**, recent official TWAP settlements, and a direct link to [`atlasoracle.io`](https://atlasoracle.io/).
   - Locks Early Close during the final 30m TWAP window and provides a permissionless **"Settle with Atlas 30m TWAP"** action after expiry (or a clear disputed-pause notice if frozen).
2. **Backend — 30m TWAP Health Sentinel, `RwaRiskService` & Permissionless Keeper (`atlasOracle.ts` + `rwaRiskService.ts` + `chainService.ts`)**:
   - Streams live updates over `wss://push.atlasoracle.io/ws` (with zombie-socket ping/reconnect watchdog and automatic HTTP fallback to `POST /v1/price/latest`, strict server-side `X-API-KEY` isolation).
   - Aggregates 1-minute bucketed `consensusScore` observations across each asset's final 30-minute window (`07:31–08:00 UTC` for crypto; `20:31–21:00 UTC` for NVDAB). In a two-pass keeper cycle, if coverage reaches `>= 20/30` minutes and the average drops below **`40%` (`0.40`)**—or becomes mathematically irrecoverable—the `pauser` sentinel immediately calls `pauseExpiry()` on-chain during the 60s pre-permissionless buffer for transparent admin `emergencyManualSettle(assetId, expiry, price, reason)`.
   - For **`NVDAB` RWA**, monitors Atlas `feed-detail` `shareMultiplier` drift (`> 1.0%` triggers an automatic split circuit breaker that blocks opens and pauses the expiry), enforces corporate-action blackouts, classifies DST-aware US equity sessions (`RTH` / `EXTENDED` / `WEEKEND`), and ingests live NVDA option IV via ThetaData + spot-perp basis via Binance Futures.
3. **Reference Market Maker — Dynamic Spread & Fail-Closed Quoting Guard (`packages/mock-maker` + `rfqGateway.ts`)**:
   - `computeConsensusRiskAdjustments(atlasTelemetry)` widens ask/bid spreads (`1.35x` on `DEGRADED`, `1.85x–2.0x` on `WARNING`) and boosts the Black-Scholes IV floor automatically when `priceVolatility > 0.5%` (single-source in `ShelfEngine`, zero double-counting).
   - Halts new `OpenQuote` signing on `CRITICAL` / `SPLIT_MARKET` or active RWA split/blackout guards while keeping `CloseQuote` exits live, and fails closed (HTTP 503) if the live Atlas feed goes offline or stale (`>60s` local / `>90s` oracle timestamp).
   - Full mathematical specification and Put-Call Parity proof in [`packages/mock-maker/README.md`](./packages/mock-maker/README.md).

---

## Local Setup, Testing & Deployment

### Prerequisites
- Node.js `>= 20` and `pnpm@10.32.0`
- An Atlas Enterprise API key (`ATLAS_API_KEY`) for live Atlas WS/Pull data (automated tests run 100% offline with embedded production Atlas signature fixtures)
- A Privy app (`PRIVY_APP_ID` and server-side `PRIVY_APP_SECRET`) for email login, embedded wallet creation, and gasless BSC Testnet execution

### 1. Install & Configure Environment
```bash
pnpm install
cp .env.example .env
# Edit .env to supply server-side ATLAS_API_KEY, PRIVY_APP_ID, PRIVY_APP_SECRET
# (and TESTNET_WALLET_PK / MM1_PRIVATE_KEY if deploying contracts or funding welcome airdrops)
# Never expose ATLAS_API_KEY, PRIVY_APP_SECRET, or private keys to packages/web or commit .env
```

### 2. Build & Run Full Automated Test Suite (`66/66` Passing)
```bash
pnpm build:shared && pnpm test:shared          # 19/19 passing
pnpm build:mock-maker && pnpm test:mock-maker  # 10/10 passing (incl. NVDAB OCC, Quick/Custom & RWA guards)
CI=true pnpm compile:contracts && CI=true pnpm test:contracts  # 17/17 passing (incl. 30-pt TWAP, NVDAB 21:00 UTC, & real Atlas 0x59eD...DC600 tests)
pnpm test:server && pnpm build:server          # 20/20 passing (incl. RwaRiskService, Privy airdrop & Quick/Custom shelf)
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
Optional Docker setup (PostgreSQL 16 + Server with bundled ThetaData Python venv):
```bash
docker compose up --build
```

### 4. Deploy, Register RWA Assets & Verify Contracts on BNB Smart Chain Testnet
```bash
# Deploy MockUSDT, AtlasPullSettlementOracle, PayoffSpreadVault, PayoffVaultLens + fund MM margin
pnpm deploy:bsc

# Register NVDAB tokenized equity RWA (Atlas #1005 / 0x000003ed, 21:00 UTC US Close)
pnpm register:rwa:bsc

# Verify live Atlas Pull eth_call + execute real on-chain 30-point settleWithAtlasTwap tx on BSC Testnet
pnpm verify:atlas:bsc

# Verify all 4 contracts on Sourcify v2 (and BscScan when BSCSCAN_API_KEY is set)
pnpm --filter @payoff/contracts verify:bsc
```

### 5. Emergency Admin Settlement CLI (Disputed Expiries)
When an expiry is frozen on-chain (either automatically by the `pauser` sentinel on `avgConsensusScore < 0.40` or RWA split guard, or manually by the admin), automated TWAP settlement is locked and must be resolved via [`packages/contracts/scripts/emergency-settle.ts`](./packages/contracts/scripts/emergency-settle.ts) (owner/pauser private key only, never exposed via HTTP API):

```bash
cd packages/contracts

# 1. Optional: manually freeze a disputed expiry (verifies on-chain configured asset, settlement UTC hour, and post-tx paused state)
ACTION=pause ASSET=BTC EXPIRY=1795593600 npx hardhat run scripts/emergency-settle.ts --network bscTestnet

# 2. Dry-run irreversible manual settlement (prints live on-chain state & runs staticcall without broadcasting)
ACTION=settle ASSET=BTC EXPIRY=1795593600 PRICE_USD=64250.50 REASON="Atlas 30m avg score < 0.40" npx hardhat run scripts/emergency-settle.ts --network bscTestnet

# 3. Broadcast confirmed manual settlement on BSC Testnet (requires explicit CONFIRM=yes on non-local chains)
ACTION=settle ASSET=BTC EXPIRY=1795593600 PRICE_USD=64250.50 REASON="Atlas 30m avg score < 0.40" CONFIRM=yes npx hardhat run scripts/emergency-settle.ts --network bscTestnet
```
> Built-in safety rails: refuses ephemeral `--network hardhat`, rejects unconfigured asset names or millisecond timestamps (use `FORCE=1` only for non-standard test expiries), parses `PRICE_USD` strictly with `ethers.parseUnits(raw, 8)` (no float rounding), and requires `CONFIRM=yes` before broadcasting `emergencyManualSettle`.

---

## Security & Privacy Highlights

- **100% Collateralized Vault Invariant**: `usdt.balanceOf(vault) >= totalLockedUsdt + totalMakerMargin + accruedProtocolFees` enforced across every open, early close, atomic merge, `redeem` / `batchRedeem`, fee pull, and rescue path.
- **Role-Separated Governance & Pause-Exempt Exits**: `Ownable2Step`, `ReentrancyGuard`, `Pausable`, dedicated `pauser` & `feeCollector`; `merge()`, `redeem()`, `batchRedeem()`, and `withdrawMakerMargin()` remain intentionally unpaused so users and makers can always recover funds.
- **Server-Side Secret Isolation**: `ATLAS_API_KEY`, `PRIVY_APP_SECRET`, and maker private keys live exclusively in gitignored `.env` on the backend—never bundled into `packages/web`, never returned by `/api/health` or `/api/oracle/consensus`, and never committed to Git.

## License

- Core protocol (`packages/shared`, `packages/contracts`, `packages/mock-maker`, `packages/server`, `packages/web`): MIT License.
- Vendored Atlas Pull Oracle consumer libraries (`packages/contracts/contracts/atlas/*`): `BUSL-1.1` (original headers preserved from [`oracle-atlas/pull-oracle-consumer`](https://github.com/oracle-atlas/pull-oracle-consumer)).

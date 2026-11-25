# Payoff on BNB Chain

**Zero-Liquidation, 100%-Collateralized Vertical Spread Tickets with Trustless On-Chain Atlas Pull Oracle Settlement**

Built for the **HackQuest BNB Bangkok Hackathon** — targeting the **Developer Track** and the **CoinMarketCap × Atlas Challenge**.

> **Read the 1-page hackathon submission brief:** [`docs/HACKATHON_ONE_PAGER.md`](./docs/HACKATHON_ONE_PAGER.md)  
> **Inspect the transparent market-making math:** [`packages/mock-maker/README.md`](./packages/mock-maker/README.md)

---

## Why Payoff?

Retail crypto traders face an uncomfortable binary today:
- **Perpetual futures** expose users to sudden wick liquidations and funding drain.
- **Traditional options** bury simple directional bets under Greeks, margin tiers, and illiquid multi-leg books.

**Payoff** packages vertical option spreads into simple, fixed-risk directional tickets on **BNB Smart Chain**:
- **Fixed Max Loss, Zero Liquidations**: Your ticket stake (`tUSDT`) is your absolute maximum loss—no margin calls, no stop-out wicks, ever.
- **100% On-Chain Collateralization**: Every minted spread locks `1 UP + 1 DOWN = 1 tUSDT` inside `PayoffSpreadVault.sol`, backed jointly by taker premium and pre-funded market-maker `makerMargin`.
- **Trustless Expiry Settlement via Atlas Pull Oracle**: Anyone can settle expired markets permissionlessly on BSC Testnet by submitting an **Atlas Enterprise signed historical proof** (`/v1/price/history`, `signed: true`) pinned strictly to `[expiry - 60s, expiry + 60s]`, verified on-chain against Atlas's official ECDSA signer (`0x59eD4701224fD9e2a85Ef2946c2ab828C1dDC600`).
- **Deep Atlas Enterprise `ConsensusScore` Protection**: Live multi-venue consensus health (`HEALTHY` / `DEGRADED` / `WARNING` / `CRITICAL` / `SPLIT_MARKET`) and `priceVolatility` drive real-time UI badges, automated settlement keeper circuit breakers, and dynamic market-maker risk spreads.

---

## Architecture Overview

Payoff enforces a clean architectural boundary between the **Core Protocol** (permissionless settlement & escrow) and the **Open-Source Reference / Mock Market Maker** (`packages/mock-maker`), which is published openly in this repository so judges can audit the exact financial math driving every live quote.

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
  Server -->|"settleWithAtlasProof + extraData"| Oracle
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

Deployment manifest: [`packages/contracts/deployments/bscTestnet.json`](./packages/contracts/deployments/bscTestnet.json) (Deployment Block: **`144779395`**)

| Contract | Address (BscScan Testnet) | Decentralized Verification (Sourcify v2) | Role |
|---|---|---|---|
| **`MockUSDT` (`tUSDT`)** | [`0x1031Ea6993B28AC957f5AD976D030f58ecAdddCe`](https://testnet.bscscan.com/address/0x1031Ea6993B28AC957f5AD976D030f58ecAdddCe) | [`exact_match`](https://repo.sourcify.dev/97/0x1031Ea6993B28AC957f5AD976D030f58ecAdddCe) | 6-decimal testnet USDT collateral with public `faucet()` |
| **`AtlasPullSettlementOracle`** | [`0xB3AcE075249f812064737804a3d4E2195346B54A`](https://testnet.bscscan.com/address/0xB3AcE075249f812064737804a3d4E2195346B54A) | [`exact_match`](https://repo.sourcify.dev/97/0xB3AcE075249f812064737804a3d4E2195346B54A) | Permissionless on-chain Atlas Pull ECDSA settlement oracle |
| **`PayoffSpreadVault`** | [`0x3f0c3606c216895d58fE33A0f5593D665692b9cd`](https://testnet.bscscan.com/address/0x3f0c3606c216895d58fE33A0f5593D665692b9cd) | [`exact_match`](https://repo.sourcify.dev/97/0x3f0c3606c216895d58fE33A0f5593D665692b9cd) | Core 100%-collateralized ERC-1155 `UP`/`DOWN` escrow vault |
| **`PayoffVaultLens`** | [`0x5Bfb86858783a8292c41B0f905C05aA8f112bC66`](https://testnet.bscscan.com/address/0x5Bfb86858783a8292c41B0f905C05aA8f112bC66) | [`exact_match`](https://repo.sourcify.dev/97/0x5Bfb86858783a8292c41B0f905C05aA8f112bC66) | Stateless read-only periphery for single-call UI/indexer queries |

> **On-chain protocol parameters**: `protocolOpenFeeBps = 400` (4%, hard-capped ≤ 500 bps), `protocolCloseFeeBps = 0` (hard-capped ≤ 100 bps), reference market maker pre-funded with `1,000,000 tUSDT` in `makerMargin` using exact finite approval.

---

## Live Verified On-Chain Atlas Pull Oracle Proof

`AtlasPullSettlementOracle` inherits `PullOracleConsumerBase` (`oracle-atlas/pull-oracle-consumer`), verifies ECDSA signatures from **Atlas Oracle's official production signer** (`0x59eD4701224fD9e2a85Ef2946c2ab828C1dDC600`, trailing calldata marker `0x7096`), and supports:
- **`BTC/USD`**: Feed ID **`#626`** (`bytes4(0x00000272)`)
- **`ETH/USD`**: Feed ID **`#632`** (`bytes4(0x00000278)`)

### Live BSC Testnet Verification Results (`pnpm verify:atlas:bsc`)

1. **Live `eth_call` `verifyLatestAtlasPrice` (Freshness-checked on BSC Testnet)**:
   - `BTC/USD` (`0x00000272`): **`$58,629.45988588`** @ `ts=1795605841` · `ConsensusScore = 94.54% (HEALTHY)`
   - `ETH/USD` (`0x00000278`): **`$1,642.64096169`** @ `ts=1795605841` · `ConsensusScore = 94.69% (HEALTHY)`

2. **Live Permissionless Expiry-Pinned Settlement Transaction (`settleWithAtlasProof`)**:
   - **Transaction Hash**: [`0x0965ed4a8d161a25a3ca2ce75b7275dc4e2c8c90044d6b124933c6b99b7ebdbe`](https://testnet.bscscan.com/tx/0x0965ed4a8d161a25a3ca2ce75b7275dc4e2c8c90044d6b124933c6b99b7ebdbe) (Block **`144779429`**)
   - **Call**: `settleWithAtlasProof(keccak256("BTC"), 1795593600)` with trailing Atlas Enterprise `/v1/price/history` (`signed: true`) proof bytes
   - **Verified On-Chain State (`getSettlement(ASSET_BTC, 1795593600)`)**:
     - `settled`: `true`
     - `price`: **`$58,659.31128708`** (`5865931128708`, 8-decimal vault price scaled safely from 18-decimal Atlas price)
     - `feedId`: `0x00000272` (`#626`)
     - `oracleTimestamp`: `1795593600` (`2026-11-25T08:00:00.000Z`, exact 08:00 UTC expiry pin)

---

## Deep Atlas Enterprise `ConsensusScore` Integration

Rather than treating an oracle as a passive price number, Payoff wires Atlas Enterprise **`consensusScores`** (`consensusScore`, `consensusStatus`, `twapPrice`, `medianPrice`, `priceVolatility`) across all three layers of the stack:

1. **Consumer UI — Real-Time Atlas Oracle Live Shield (`AtlasOracleBadge.tsx`)**:
   - Displays live `Atlas Oracle · HEALTHY · 94.5%`, Feed ID (`#626 BTC/USD` / `#632 ETH/USD`), TWAP vs. Median spread, `priceVolatility`, and clickable on-chain ECDSA verifier reference (`0x59eD...DC600` on BSC Testnet).
   - Color-coded in real time (`HEALTHY` teal, `DEGRADED`/`WARNING` amber, `CRITICAL`/`SPLIT_MARKET` crimson).
2. **Backend — Settlement Keeper Circuit Breaker (`atlasOracle.ts` + `chainService.ts`)**:
   - Streams live updates over `wss://push.atlasoracle.io/ws` (with automatic HTTP fallback to `POST /v1/price/latest` and strict server-side `X-API-KEY` isolation).
   - Automatically pauses permissionless settlement submission whenever `consensusStatus` is `WARNING`, `CRITICAL`, or `SPLIT_MARKET` (or `consensusScore < 70%`), surfacing live circuit-breaker telemetry on `GET /api/oracle/consensus`, `GET /api/health`, WebSocket `TICK` broadcasts, and the `/ops` dashboard.
3. **Reference Market Maker — Dynamic Spread & Quoting Circuit Breaker (`packages/mock-maker`)**:
   - `computeConsensusRiskAdjustments(atlasTelemetry)` widens ask/bid spreads (`1.35x` on `DEGRADED`, `1.85x–2.0x` on `WARNING`) and boosts the Black-Scholes IV floor automatically when `priceVolatility > 0.5%`.
   - Halts new `OpenQuote` signing via `ConsensusCircuitBreakerError` on `CRITICAL` / `SPLIT_MARKET`, while intentionally keeping reverse-RFQ `CloseQuote` exits available (with conservative spreads) so existing ticket holders are never trapped.
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
CI=true pnpm compile:contracts && CI=true pnpm test:contracts  # 17/17 passing (incl. real Atlas 0x59eD...DC600 proof tests)
pnpm test:server && pnpm build:server          # 14/14 passing
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

# Verify live Atlas Pull eth_call + execute real on-chain settleWithAtlasProof tx on BSC Testnet
pnpm verify:atlas:bsc

# Verify all 4 contracts on Sourcify v2 (and BscScan when BSCSCAN_API_KEY is set)
pnpm --filter @payoff/contracts verify:bsc
```

---

## Security & Privacy Highlights

- **100% Collateralized Vault Invariant**: `usdt.balanceOf(vault) >= totalLockedUsdt + totalMakerMargin + accruedProtocolFees` enforced across every open, early close, atomic merge, redeem, fee pull, and rescue path.
- **Role-Separated Governance & Pause-Exempt Exits**: `Ownable2Step`, `ReentrancyGuard`, `Pausable`, dedicated `pauser` & `feeCollector`; `merge()`, `redeem()`, and `withdrawMakerMargin()` remain intentionally unpaused so users and makers can always recover funds.
- **Server-Side Secret Isolation**: `ATLAS_API_KEY` and maker private keys live exclusively in gitignored `.env` on the backend—never bundled into `packages/web`, never returned by `/api/health` or `/api/oracle/consensus`, and never committed to Git.

## License

- Core protocol (`packages/shared`, `packages/contracts`, `packages/mock-maker`, `packages/server`, `packages/web`): MIT License.
- Vendored Atlas Pull Oracle consumer libraries (`packages/contracts/contracts/atlas/*`): `BUSL-1.1` (original headers preserved from [`oracle-atlas/pull-oracle-consumer`](https://github.com/oracle-atlas/pull-oracle-consumer)).

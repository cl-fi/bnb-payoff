# Payoff on BNB Chain — Hackathon One-Pager

**Event**: HackQuest BNB Bangkok Hackathon  
**Tracks**: **Developer Track** + **CoinMarketCap × Atlas Challenge**  
**Network**: BNB Smart Chain Testnet (Chain ID `97`)  
**Repository**: `bnb-payoff` (Full-stack TypeScript + Solidity monorepo, **47/47** automated tests passing, all 4 contracts Sourcify v2 `exact_match` verified)

---

## 1. Problem & Target Audience

Active BNB Chain traders want clean directional exposure to BTC and ETH without suffering sudden perp wick liquidations or deciphering complex multi-leg options Greeks.
- **Perpetual futures** liquidate users on temporary intraday spikes even when their end-of-day thesis is right.
- **On-chain option books** require managing strikes, implied volatility, margin collateral, and fragmented liquidity.

**Payoff** delivers **fixed-risk, zero-liquidation vertical spread tickets** settled in `tUSDT` on BNB Chain:
- Users pick an asset (`BTC` / `ETH`), direction (`UP` / `DOWN`), tenor (`Daily` / `Weekly`), and target price tier from a hysteresis-locked 4-tier shelf.
- Every ticket clearly displays **5 retail numbers**: Stake (= Max Loss), Breakeven Price, Max Payout & Multiplier, 08:00 UTC Settlement Time, and Live Indicative Early-Exit Value.
- Users can exit early at any time via competitive reverse-RFQ (with atomic `UP + DOWN` collateral merge unlocks) or hold to deterministic 08:00 UTC expiry settlement with zero risk of liquidation.

---

## 2. Deep Atlas Oracle Integration (CoinMarketCap × Atlas Challenge)

Payoff uses **Atlas Enterprise Pull Oracle** and **ConsensusScore** as load-bearing security primitives—not cosmetic price displays:

| Atlas Capability | Endpoint / Feed | Load-Bearing Role in Payoff |
|---|---|---|
| **Price Feeds** | `#626` (`0x00000272`, BTC/USD)<br/>`#632` (`0x00000278`, ETH/USD) | Single unified source of truth for live UI spot, shelf pricing, chart close anchoring, and on-chain expiry settlement. |
| **Signed Historical Proofs** | `POST /v1/price/history`<br/>(`signed: true`, `timestamp: expirySec`) | Powers **permissionless expiry-pinned settlement** in `AtlasPullSettlementOracle.settleWithAtlasProof(assetId, expiry)`. Enforces `aggregatedTs ∈ [expiry - 60s, expiry + 60s]`, preventing timestamp cherry-picking while allowing settlement even hours after expiry. |
| **Signed Live Pull Proofs** | `POST /v1/price/latest`<br/>(`signed: true`) | Verified on-chain via `verifyLatestAtlasPrice(assetId)` (`maxLiveFreshness = 180s`) and used as HTTP fallback when WebSocket disconnects or an expiry occurred within the last 60s. |
| **Real-Time WebSocket Stream** | `wss://push.atlasoracle.io/ws`<br/>(`modix@auth.price@626`, `632`) | Streams sub-second spot ticks + live `consensusScores` to `@payoff/server`, broadcast to `@payoff/web` over `/ws/stream`. |
| **Enterprise `ConsensusScore`** | `consensusScore`, `consensusStatus`, `twapPrice`, `medianPrice`, `priceVolatility` | Drives **three active safeguards**:<br/>1. **Settlement Keeper Circuit Breaker**: pauses auto-settlement on `WARNING`/`CRITICAL`/`SPLIT_MARKET` or `score < 70%`.<br/>2. **Market Maker Risk Engine** (`@payoff/mock-maker`): widens spreads (`1.35x` `DEGRADED`, `1.85x–2.0x` `WARNING`), scales BS IV floor when `priceVolatility > 0.5%`, and halts new `OpenQuote` signing on `CRITICAL`/`SPLIT_MARKET` (while keeping `CloseQuote` exits open).<br/>3. **Live UI Shield (`AtlasOracleBadge`)**: shows real-time consensus status, score %, TWAP vs. Median, and ECDSA verifier info. |

> **API Key Compliance**: `ATLAS_API_KEY` is read strictly server-side from gitignored `.env`, never exposed via `/api/health` or `/api/oracle/consensus`, never bundled into `packages/web`, and never committed to Git.

---

## 3. BNB Chain Testnet Contracts & Verified On-Chain Proof

All 4 contracts are live on **BNB Smart Chain Testnet (Chain ID `97`, Block `144779395`)** and verified with **Sourcify API v2 `exact_match`**:

| Contract | BSC Testnet Address | Sourcify v2 |
|---|---|---|
| `MockUSDT` (`tUSDT`, 6-dec) | [`0x1031Ea6993B28AC957f5AD976D030f58ecAdddCe`](https://testnet.bscscan.com/address/0x1031Ea6993B28AC957f5AD976D030f58ecAdddCe) | [`exact_match`](https://repo.sourcify.dev/97/0x1031Ea6993B28AC957f5AD976D030f58ecAdddCe) |
| `AtlasPullSettlementOracle` | [`0xB3AcE075249f812064737804a3d4E2195346B54A`](https://testnet.bscscan.com/address/0xB3AcE075249f812064737804a3d4E2195346B54A) | [`exact_match`](https://repo.sourcify.dev/97/0xB3AcE075249f812064737804a3d4E2195346B54A) |
| `PayoffSpreadVault` | [`0x3f0c3606c216895d58fE33A0f5593D665692b9cd`](https://testnet.bscscan.com/address/0x3f0c3606c216895d58fE33A0f5593D665692b9cd) | [`exact_match`](https://repo.sourcify.dev/97/0x3f0c3606c216895d58fE33A0f5593D665692b9cd) |
| `PayoffVaultLens` | [`0x5Bfb86858783a8292c41B0f905C05aA8f112bC66`](https://testnet.bscscan.com/address/0x5Bfb86858783a8292c41B0f905C05aA8f112bC66) | [`exact_match`](https://repo.sourcify.dev/97/0x5Bfb86858783a8292c41B0f905C05aA8f112bC66) |

**Live On-Chain Atlas Pull Proof Executed on BSC Testnet**:
- **Authorized Production Signer**: `0x59eD4701224fD9e2a85Ef2946c2ab828C1dDC600` (magic marker `0x7096`)
- **Live `verifyLatestAtlasPrice` (`eth_call`)**: `BTC/USD` `$58,629.45988588` (`94.54% HEALTHY`) & `ETH/USD` `$1,642.64096169` (`94.69% HEALTHY`)
- **Live `settleWithAtlasProof(ASSET_BTC, 1795593600)` Tx**: [`0x0965ed4a8d161a25a3ca2ce75b7275dc4e2c8c90044d6b124933c6b99b7ebdbe`](https://testnet.bscscan.com/tx/0x0965ed4a8d161a25a3ca2ce75b7275dc4e2c8c90044d6b124933c6b99b7ebdbe) (Block `144779429`)
- **Verified On-Chain Settlement**: `settled = true`, `price = $58,659.31128708`, `feedId = 0x00000272`, `oracleTimestamp = 1795593600` (`2026-11-25T08:00:00.000Z`)

---

## 4. Technical Safety & Modular Architecture

- **100% Solvency Invariant**: Every minted `UP`/`DOWN` pair locks full `maxPayout` in `tUSDT` (`vaultHealth()` continuously proves `usdtBalance >= lockedUsdt + makerMarginUsdt + protocolFeesUsdt`), eliminating bad debt and liquidation cascades.
- **Cryptographic Settlement Security**: `AtlasPullSettlementOracle` inherits `PullOracleConsumerBase` (`oracle-atlas/pull-oracle-consumer`), enforces EIP-2 low-S ECDSA verification against `authorizedSigner`, rejects zero/future-drifted timestamps, blocks duplicate settlements, and exposes an owner emergency pause (`setSettlementPaused`).
- **Battle-Tested Vault Controls**: `Ownable2Step`, `ReentrancyGuard`, `Pausable` (with `merge`, `redeem`, and `withdrawMakerMargin` pause-exempt), EIP-712 + EIP-1271 maker signatures, delegated hot signers, 256-bit bitmap nonces, maker epoch kill switch, self-trade guard, and finite maker approvals (no `MaxUint256`).
- **Transparent Open-Source Reference Market Maker (`packages/mock-maker`)**: Cleanly decoupled from the core protocol via standard EIP-712 `OpenQuote`/`CloseQuote` structs. Judges can inspect the exact Black-Scholes valuation, Put-Call Parity no-arbitrage proofs (`UP_ask + DOWN_ask > width`, `UP_bid + DOWN_bid < width`), hysteresis strike grid, and atomic-merge `+25 bps` early-exit improvement—proving live testnet quotes come from real financial math while enabling any third-party MM to drop in and compete.
- **BNB-Native Wallet UX**: Pure EIP-6963 multi-wallet discovery (Binance Web3 Wallet, MetaMask, Trust Wallet, Rabby, etc.) with one-click Chain ID `97` switching and in-app `tUSDT` faucet.

---

## 5. Roadmap

1. **BNB Smart Chain Mainnet Launch**: Security audit of `PayoffSpreadVault` & `AtlasPullSettlementOracle`, native USDT collateral integration, and BscScan + Sourcify verification.
2. **Multi-MM Competitive RFQ Network**: Onboard independent professional market makers competing on the same EIP-712 `OpenQuote` / `CloseQuote` standard, maximizing user multipliers and early-exit liquidity via atomic merge competition.
3. **BNB, Altcoin & RWA Spread Markets via Atlas Custom Feeds**: Expand beyond BTC (`#626`) and ETH (`#632`) to **BNB/USD**, major BNB ecosystem assets, and tokenized equity/gold RWA spreads backed by Atlas Pull Oracle custom feeds and `ConsensusScore` guardrails.

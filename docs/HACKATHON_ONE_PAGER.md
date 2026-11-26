# Payoff — Continuous-Payout Prediction Markets on BNB Chain (Hackathon One-Pager)

**Event**: HackQuest BNB Bangkok Hackathon  
**Tracks**: **Developer Track** + **CoinMarketCap × Atlas Challenge**  
**Network**: BNB Smart Chain Testnet (Chain ID `97`)  
**Repository**: `bnb-payoff` (Full-stack TypeScript + Solidity monorepo, **47/47** automated tests passing, all 4 contracts Sourcify v2 `exact_match` verified)

---

## 1. Problem & Real Product Edge vs. Existing Prediction Markets

Short-term crypto price markets are one of the highest-frequency daily categories on Polymarket and Kalshi—yet forcing continuous asset prices into **`0-or-1` binary contracts** breaks both user experience and liquidity:
- **All-or-Nothing Wipeouts on Right Calls**: With BTC at `$60,276`, buying a `5.0x` binary ticket (`$61,750 or above`) pays **`$0` (`-100%`)** even if BTC surges `+$1,224` (`+2.0%`) to `$61,500`. Meanwhile, perpetual futures liquidate users on sudden overnight wicks.
- **60 Fragmented Rows & Empty Orderbooks (`—`)**: Binary platforms split one BTC expiry into dozens of `$250`-spaced `or above` rows; over half sit empty (`—`) because extreme expiry pin-risk deters market makers, and bearish traders have to mentally invert `or above → Buy No`.
- **High Churn & Expiry Manipulation Cliff**: Binary lotteries wipe out retail bankrolls ~80% of the time on high-multiplier tiers, and a tiny spot push at expiry flips `100%` of the pool.

**Payoff** delivers **Continuous-Payout Prediction Markets** settled in `tUSDT` on BNB Chain—collapsing 60 fragmented binary rows into **one smooth, zero-liquidation ticket**:
- Users pick an asset (`BTC` / `ETH`), **`UP`** or **`DOWN`**, tenor (`Daily` / `Weekly`), and one of **4 deep fixed-grid Target Multiplier tiers** (`~1.6x` cushioned to `~5x` breakout) above an anchored **Start Line**.
- On the exact same `$100` `~5x` BTC bet (`$60,000 → $64,000`, spot `$60,276`), a `+$1,224` rally to `$61,500` pays **`~$180` (`+80%` profit)** instead of **`$0` (`-100%`)**, starts profiting at `+1%`, and still recovers `~1/3` of stake if flat—roughly doubling directional win rate, lifting retail retention, and generating organic on-chain USDT protocol fees from Day 1.
- Every ticket surfaces **5 plain retail numbers**: Stake (= Max Loss), Breakeven Price, If-Flat Return, Target Cap & Max Multiplier, and Live Early-Cashout Value—with 1-click early exits via competitive EIP-712 RFQ (plus atomic `UP + DOWN` merge unlocks) and zero risk of intraday liquidation.

---

## 2. Deep Atlas Oracle Integration (CoinMarketCap × Atlas Challenge)

Payoff uses **Atlas Enterprise Pull Oracle** and **ConsensusScore** as load-bearing security primitives—not cosmetic price displays:

| Atlas Capability | Endpoint / Feed | Load-Bearing Role in Payoff |
|---|---|---|
| **Price Feeds** | `#626` (`0x00000272`, BTC/USD)<br/>`#632` (`0x00000278`, ETH/USD) | Single unified source of truth for live UI spot, shelf pricing, chart close anchoring, and on-chain expiry settlement. |
| **Signed Historical Proofs (30m TWAP)** | `POST /v1/price/history`<br/>(`signed: true`, 30× 1-min points `07:31–08:00 UTC`) | Powers **permissionless 30-minute TWAP settlement** in `AtlasPullSettlementOracle.settleWithAtlasTwap(assetId, expiry, proofs[30])` (aligned with Deribit/OKX/Binance). Enforces `0s` exact timestamp match within 15m after expiry (`±10s` fallback thereafter), eliminating cherry-picking in one atomic tx (`~344k gas`), with 30m pre-expiry early-close lock. |
| **Signed Live Pull Proofs** | `POST /v1/price/latest`<br/>(`signed: true`) | Verified on-chain via `verifyLatestAtlasPrice(assetId)` (`maxLiveFreshness = 180s`) and used as HTTP fallback when WebSocket disconnects. |
| **Real-Time WebSocket Stream** | `wss://push.atlasoracle.io/ws`<br/>(`modix@auth.price@626`, `632`) | Streams sub-second spot ticks + live `consensusScores` with zombie-socket ping watchdog to `@payoff/server`, broadcast to `@payoff/web` over `/ws/stream`. |
| **Enterprise `ConsensusScore`** | `consensusScore`, `consensusStatus`, `twapPrice`, `medianPrice`, `priceVolatility` | Drives **three active safeguards**:<br/>1. **30m TWAP Health Sentinel**: aggregates 1-minute bucketed scores over `07:31–08:00 UTC` (two-pass keeper checks pauses before proof fetches); if `>= 20/30m` coverage averages `< 40%` (or becomes mathematically irrecoverable), `pauser` freezes the disputed expiry on-chain during the 60s buffer for transparent `owner` `emergencyManualSettle` with public audit reason.<br/>2. **Market Maker Risk Engine** (`@payoff/mock-maker` + `rfqGateway`): widens spreads (`1.35x` `DEGRADED`, `1.85x–2.0x` `WARNING`), scales BS IV floor when `priceVolatility > 0.5%`, halts `OpenQuote` on `CRITICAL`/`SPLIT_MARKET`, and fails closed (HTTP 503) if Atlas goes offline/stale (`>60s`).<br/>3. **Live UI Shield (`AtlasOracleBadge` + `/positions`)**: displays real-time consensus score, separated Oracle Contract vs Signer links, and permissionless 30m TWAP self-settlement. |

> **API Key Compliance**: `ATLAS_API_KEY` is read strictly server-side from gitignored `.env`, never exposed via `/api/health` or `/api/oracle/consensus`, never bundled into `packages/web`, and never committed to Git.

---

## 3. BNB Chain Testnet Contracts & Verified On-Chain Proof

All 4 contracts are live on **BNB Smart Chain Testnet (Chain ID `97`, Block `144840259`)** and verified with **Sourcify API v2 `exact_match`**:

| Contract | BSC Testnet Address | Sourcify v2 |
|---|---|---|
| `MockUSDT` (`tUSDT`, 6-dec) | [`0x20845985df410F84c2e30Ba44A19dD564baE9bED`](https://testnet.bscscan.com/address/0x20845985df410F84c2e30Ba44A19dD564baE9bED) | [`exact_match`](https://repo.sourcify.dev/97/0x20845985df410F84c2e30Ba44A19dD564baE9bED) |
| `AtlasPullSettlementOracle` | [`0x00ea779192dAd354D25016841e3Ff2Bc8f545114`](https://testnet.bscscan.com/address/0x00ea779192dAd354D25016841e3Ff2Bc8f545114) | [`exact_match`](https://repo.sourcify.dev/97/0x00ea779192dAd354D25016841e3Ff2Bc8f545114) |
| `PayoffSpreadVault` | [`0x5a6AaD747cd5313E31fa663fF719b2a18fF00174`](https://testnet.bscscan.com/address/0x5a6AaD747cd5313E31fa663fF719b2a18fF00174) | [`exact_match`](https://repo.sourcify.dev/97/0x5a6AaD747cd5313E31fa663fF719b2a18fF00174) |
| `PayoffVaultLens` | [`0x831532F56ac6aB2B628a7b6cEAb1Eef3a828d60E`](https://testnet.bscscan.com/address/0x831532F56ac6aB2B628a7b6cEAb1Eef3a828d60E) | [`exact_match`](https://repo.sourcify.dev/97/0x831532F56ac6aB2B628a7b6cEAb1Eef3a828d60E) |

**Live On-Chain 30-Point Atlas TWAP Proof Executed on BSC Testnet**:
- **Authorized Production Signer**: `0x59eD4701224fD9e2a85Ef2946c2ab828C1dDC600` (magic marker `0x7096`)
- **Live `verifyLatestAtlasPrice` (`eth_call`)**: `BTC/USD` `$59,653.75598044` (`93.27% HEALTHY`) & `ETH/USD` `$1,679.40804865` (`93.49% HEALTHY`)
- **Live `settleWithAtlasTwap(ASSET_BTC, 1795593600, proofs[30])` Tx**: [`0xe4b6067ea5ba92d688746adf0ac547406fada9f28a81e0250137b5265de2dc90`](https://testnet.bscscan.com/tx/0xe4b6067ea5ba92d688746adf0ac547406fada9f28a81e0250137b5265de2dc90) (Block `144840391`, `344,021` gas)
- **Verified On-Chain Settlement**: `settled = true`, `price = $58,750.15513875`, `samples = 30` (`maxTimestampDiff = 0s`), `window = [1795591860..1795593600]`, `isManualOverride = false`

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
3. **BNB, Altcoin & RWA Continuous-Payout Markets via Atlas Custom Feeds**: Expand beyond BTC (`#626`) and ETH (`#632`) to **BNB/USD**, high-volatility BNB ecosystem assets, and tokenized equity/gold RWA price prediction markets backed by Atlas Pull Oracle custom feeds and `ConsensusScore` guardrails.

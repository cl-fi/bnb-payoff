# Payoff Pitch Script

Deck: [`deck.html`](./deck.html) · 8 slides · about 2.5 minutes.

Controls: `→` or `Space` for next, `←` for back, `F` for fullscreen. Clicking or swiping also works.

---

## 1. Cover (20s)

*On screen: A prediction market built for prices, not events.*

Hi everyone. I'm building Payoff on BNB Chain: a prediction market built for prices, not events. An event is yes or no. A price is continuous: it can move a little or a lot. So on Payoff you pick a direction and a multiplier, and you get paid by how far the price moves.

## 2. Problem (20s)

*On screen: Right direction. Still lose.*

Today, a directional trader is stuck between two extremes. Binary prediction markets are simple but unforgiving: call the direction right, miss the strike by ten dollars, and you lose 100%. Perps pay linearly, but one overnight wick liquidates you, even when your view was right.

## 3. Solution (20s)

*On screen: Payoff pays as price moves.*

Payoff bridges both. You still just pick Up or Down and slide to your target multiplier. But the payout is linear: the further price moves your way, the more you get paid. Same $100, same 5x cap. On a 2% move, the binary ticket pays zero. Payoff pays about $180.

## 4. Live product (15s)

*On screen: Live on BNB testnet.*

This is live right now at bnb.payoff.finance. Sign in with email, pay zero gas, and get 1,000 test USDT automatically. We default to 24/7 NVIDIA, alongside BTC and ETH, and you can cash out any amount early, up to 30 minutes before settlement.

## 5. Why it scales (20s)

*On screen: Better for everyone.*

The design helps every side. Traders aren't wiped to zero on every near miss, so bankrolls last longer. Market makers have no all-or-nothing cliff to hedge at expiry, and every position is fully collateralized. The protocol charges a 4% open fee, so revenue starts on day one.

## 6. Oracle and security (25s)

*On screen: Settled by Atlas.*

Atlas is a load-bearing security layer here, not just a price ticker. Anyone can settle a market by submitting 30 signed one-minute Atlas prices in a single transaction. Live ConsensusScore widens maker spreads and halts new opens when consensus is weak. And if it averages below 40%, or NVDA has a stock split, that expiry is paused automatically.

## 7. Proof (15s)

*On screen: Shipped and verified.*

Everything is deployed and verified on BNB testnet. All four contracts are exact-match verified on Sourcify. We ran a live 30-proof Atlas settlement on-chain in 344 thousand gas. The vault is 100% collateralized, and all 66 automated tests pass.

## 8. Next and call to action (15s)

*On screen: Next.*

Next: audit and launch on BNB mainnet, open quoting to competing market makers, and expand from NVDA to more 24/7 assets. Scan the code, sign in with your email, and place your first trade in ten seconds. Thank you.

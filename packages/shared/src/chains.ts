import { keccak256, toBytes } from "viem";

export interface ChainConfig {
  chainId: number;
  name: string;
  rpcUrl: string;
  explorerUrl?: string;
  usdtAddress?: `0x${string}`;
  usdtDecimals: number;
  nativeSymbol: string;
}

export const BSC_TESTNET: ChainConfig = {
  chainId: 97,
  name: "BNB Smart Chain Testnet",
  rpcUrl: "https://data-seed-prebsc-1-s1.bnbchain.org:8545",
  explorerUrl: "https://testnet.bscscan.com",
  usdtDecimals: 6,
  nativeSymbol: "tBNB",
};

export const LOCAL_HARDHAT: ChainConfig = {
  chainId: 31337,
  name: "Payoff Local Devnet",
  rpcUrl: "http://127.0.0.1:8545",
  usdtDecimals: 6,
  nativeSymbol: "ETH",
};

export enum Underlying {
  BTC = 0,
  ETH = 1,
}

export type UnderlyingSymbol = "BTC" | "ETH";

export const ASSET_BTC_ID: `0x${string}` = keccak256(toBytes("BTC"));
export const ASSET_ETH_ID: `0x${string}` = keccak256(toBytes("ETH"));

export const ASSET_IDS: Record<UnderlyingSymbol, `0x${string}`> = {
  BTC: ASSET_BTC_ID,
  ETH: ASSET_ETH_ID,
};

export interface AtlasFeedConfig {
  feedId: string;
  feedIdHex: `0x${string}`;
  pair: string;
}

export const ATLAS_FEEDS: Record<UnderlyingSymbol, AtlasFeedConfig> = {
  BTC: { feedId: "626", feedIdHex: "0x00000272", pair: "BTC/USD" },
  ETH: { feedId: "632", feedIdHex: "0x00000278", pair: "ETH/USD" },
};

/** Official Atlas Oracle production ECDSA signer verified on-chain */
export const ATLAS_OFFICIAL_SIGNER: `0x${string}` =
  "0x59eD4701224fD9e2a85Ef2946c2ab828C1dDC600";

/** Atlas Pull Oracle trailing calldata magic marker */
export const ATLAS_MAGIC_MARKER: `0x${string}` = "0x7096";

export function symbolToAssetId(
  symbol: UnderlyingSymbol | string
): `0x${string}` {
  const upper = symbol.toUpperCase();
  if (upper === "BTC") return ASSET_BTC_ID;
  if (upper === "ETH") return ASSET_ETH_ID;
  return keccak256(toBytes(upper));
}

export function assetIdToSymbol(
  assetId: `0x${string}` | string
): UnderlyingSymbol {
  const lower = assetId.toLowerCase();
  if (lower === ASSET_BTC_ID.toLowerCase()) return "BTC";
  if (lower === ASSET_ETH_ID.toLowerCase()) return "ETH";
  throw new Error(`Unsupported assetId: ${assetId}`);
}

export function underlyingToSymbol(u: Underlying | number): UnderlyingSymbol {
  if (u === Underlying.BTC) return "BTC";
  if (u === Underlying.ETH) return "ETH";
  throw new Error(`Unsupported underlying: ${u}`);
}

export function symbolToUnderlying(s: string): Underlying {
  if (s === "BTC") return Underlying.BTC;
  if (s === "ETH") return Underlying.ETH;
  throw new Error(`Unsupported underlying symbol: ${s}`);
}

export const PRICE_DECIMALS = 8;
export const USDT_DECIMALS = 6;
export const PRICE_SCALE = 10n ** 8n;
export const USDT_SCALE = 10n ** 6n;

/** Hard protocol cap on open markup: 5% (500 bps) */
export const MAX_OPEN_FEE_BPS = 500;
/** Default disciplined markup: 4% (400 bps) within 3-5% target */
export const DEFAULT_OPEN_FEE_BPS = 400;
/** Hard protocol cap on early close fee: 1% (100 bps) */
export const MAX_CLOSE_FEE_BPS = 100;
export const DEFAULT_CLOSE_FEE_BPS = 0;

/** Unified daily/weekly option settlement hour in UTC */
export const SETTLEMENT_UTC_HOUR = 8;

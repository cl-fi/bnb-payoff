import { encodeAbiParameters, keccak256 } from "viem";

export function getPayoffEip712Domain(
  chainId: number,
  verifyingContract: `0x${string}`
) {
  return {
    name: "PayoffSpreadVault",
    version: "2",
    chainId,
    verifyingContract,
  } as const;
}

export const OPEN_QUOTE_TYPES = {
  OpenQuote: [
    { name: "taker", type: "address" },
    { name: "maker", type: "address" },
    { name: "assetId", type: "bytes32" },
    { name: "isUp", type: "bool" },
    { name: "lowerStrike", type: "uint64" },
    { name: "upperStrike", type: "uint64" },
    { name: "expiry", type: "uint64" },
    { name: "userPayAmount", type: "uint256" },
    { name: "maxPayout", type: "uint256" },
    { name: "maxProtocolFeeBps", type: "uint16" },
    { name: "makerEpoch", type: "uint64" },
    { name: "validUntil", type: "uint64" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

export const CLOSE_QUOTE_TYPES = {
  CloseQuote: [
    { name: "taker", type: "address" },
    { name: "maker", type: "address" },
    { name: "seriesId", type: "bytes32" },
    { name: "isUp", type: "bool" },
    { name: "amount", type: "uint256" },
    { name: "buybackAmount", type: "uint256" },
    { name: "maxCloseFeeBps", type: "uint16" },
    { name: "makerEpoch", type: "uint64" },
    { name: "validUntil", type: "uint64" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

/**
 * Matches Solidity 4-tuple:
 * keccak256(abi.encode(assetId, lowerStrike, upperStrike, expiry))
 */
export function computeSeriesId(
  assetId: `0x${string}`,
  lowerStrike8: bigint,
  upperStrike8: bigint,
  expiry: bigint | number
): `0x${string}` {
  const encoded = encodeAbiParameters(
    [
      { type: "bytes32" },
      { type: "uint64" },
      { type: "uint64" },
      { type: "uint64" },
    ],
    [assetId, lowerStrike8, upperStrike8, BigInt(expiry)]
  );
  return keccak256(encoded);
}

/** Matches Solidity: uint256(seriesId) & ~uint256(1) (even = UP / bullish) */
export function computeUpTokenId(seriesId: `0x${string}`): bigint {
  return BigInt(seriesId) & ~1n;
}

/** Matches Solidity: uint256(seriesId) | uint256(1) (odd = DOWN / bearish) */
export function computeDownTokenId(seriesId: `0x${string}`): bigint {
  return BigInt(seriesId) | 1n;
}

export function computeTokenId(
  seriesId: `0x${string}`,
  isUp: boolean
): bigint {
  return isUp ? computeUpTokenId(seriesId) : computeDownTokenId(seriesId);
}

/** Matches AtlasPullSettlementOracle.settlementKey(assetId, expiry) */
export function computeSettlementKey(
  assetId: `0x${string}`,
  expiry: bigint | number
): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint64" }],
      [assetId, BigInt(expiry)]
    )
  );
}

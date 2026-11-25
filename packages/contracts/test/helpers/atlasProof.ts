import { ethers } from "hardhat";
import type { ContractTransactionResponse, Signer } from "ethers";

export const ATLAS_MAGIC_MARKER = "0x7096";
export const ATLAS_OFFICIAL_SIGNER = "0x59eD4701224fD9e2a85Ef2946c2ab828C1dDC600";

export const FEED_ID_BTC = "0x00000272"; // #626 BTC/USD
export const FEED_ID_ETH = "0x00000278"; // #632 ETH/USD

export const DEFAULT_TWAP_SAMPLE_COUNT = 30;
export const DEFAULT_TWAP_SAMPLE_INTERVAL = 60;

export interface AtlasFeedPackageInput {
  feedId: string; // 4-byte hex e.g. "0x00000272"
  price18: bigint; // 18-decimal unsigned integer (fits in uint80 / 10 bytes)
  timestamp: number | bigint; // unix seconds (fits in uint48 / 6 bytes)
}

export interface SignedAtlasProof {
  payload: string;
  signature: string;
  magicMarker: string;
  extraData: string;
}

/**
 * Computes deterministic chronologically ordered TWAP target timestamps:
 * `[expiry - (count - 1) * interval, ..., expiry]`.
 */
export function buildTwapSampleTimestamps(
  expiry: number | bigint,
  count: number = DEFAULT_TWAP_SAMPLE_COUNT,
  interval: number = DEFAULT_TWAP_SAMPLE_INTERVAL
): bigint[] {
  const exp = BigInt(expiry);
  const step = BigInt(interval);
  const out: bigint[] = [];
  for (let i = 0; i < count; i++) {
    out.push(exp - BigInt(count - 1 - i) * step);
  }
  return out;
}

/**
 * Encodes a single 20-byte Atlas feed package:
 * [4B FeedID][10B Price (uint80)][6B Timestamp (uint48)]
 */
export function encodeAtlasPackage(pkg: AtlasFeedPackageInput): string {
  const feedBytes = ethers.getBytes(pkg.feedId);
  if (feedBytes.length !== 4) {
    throw new Error(`feedId must be 4 bytes, got ${feedBytes.length}`);
  }
  const priceHex = ethers.toBeHex(pkg.price18, 10);
  const tsHex = ethers.toBeHex(BigInt(pkg.timestamp), 6);
  return ethers.concat([pkg.feedId, priceHex, tsHex]);
}

/**
 * Encodes and signs an Atlas Pull Oracle extraData suffix matching PullOracleCodec
 * and PullOracleSignature (raw keccak256 over [Packages][Count], no EIP-191 prefix).
 */
export function buildSignedAtlasProof(
  signerPrivateKey: string,
  packages: AtlasFeedPackageInput[],
  magicMarker: string = ATLAS_MAGIC_MARKER
): SignedAtlasProof {
  const encodedPackages = packages.map(encodeAtlasPackage);
  const countByte = ethers.toBeHex(packages.length, 1);
  const payload = ethers.concat([...encodedPackages, countByte]);

  const digest = ethers.keccak256(payload);
  const signingKey = new ethers.SigningKey(signerPrivateKey);
  const sig = signingKey.sign(digest);
  const signature = ethers.concat([sig.r, sig.s, ethers.toBeHex(sig.v, 1)]);
  const extraData = ethers.concat([payload, signature, magicMarker]);

  return { payload, signature, magicMarker, extraData };
}

/**
 * Signs a full array of chronologically ordered Atlas Pull proofs for `settleWithAtlasTwap`.
 */
export function buildSignedAtlasTwapProofs(params: {
  signerPrivateKey: string;
  feedId: string;
  expiry: number | bigint;
  prices18: bigint | bigint[];
  count?: number;
  interval?: number;
  timestampOffsets?: number[];
  magicMarker?: string;
}): { timestamps: bigint[]; extraDatas: string[]; expectedPrice8: bigint } {
  const count = params.count ?? DEFAULT_TWAP_SAMPLE_COUNT;
  const interval = params.interval ?? DEFAULT_TWAP_SAMPLE_INTERVAL;
  const targets = buildTwapSampleTimestamps(params.expiry, count, interval);

  let sumPrice18 = 0n;
  const extraDatas: string[] = [];
  const timestamps: bigint[] = [];

  for (let i = 0; i < count; i++) {
    const price18 = Array.isArray(params.prices18)
      ? params.prices18[i]!
      : params.prices18;
    const offset = params.timestampOffsets?.[i] ?? 0;
    const ts = targets[i]! + BigInt(offset);
    timestamps.push(ts);
    sumPrice18 += price18;

    const proof = buildSignedAtlasProof(
      params.signerPrivateKey,
      [{ feedId: params.feedId, price18, timestamp: ts }],
      params.magicMarker ?? ATLAS_MAGIC_MARKER
    );
    extraDatas.push(proof.extraData);
  }

  const expectedPrice8 = sumPrice18 / (BigInt(count) * 10n ** 10n);
  return { timestamps, extraDatas, expectedPrice8 };
}

/**
 * Builds calldata for `verifyLatestAtlasPrice(assetId)` with trailing Atlas extraData.
 */
export function encodeVerifyLatestAtlasPriceCalldata(
  oracleInterface: ethers.Interface,
  assetId: string,
  extraData: string
): string {
  const baseCalldata = oracleInterface.encodeFunctionData("verifyLatestAtlasPrice", [
    assetId,
  ]);
  return ethers.concat([baseCalldata, extraData]);
}

/**
 * Builds calldata for `verifyAtlasFeedProof(feedId)` with trailing Atlas extraData.
 */
export function encodeVerifyAtlasFeedProofCalldata(
  oracleInterface: ethers.Interface,
  feedId: string,
  extraData: string
): string {
  const baseCalldata = oracleInterface.encodeFunctionData("verifyAtlasFeedProof", [
    feedId,
  ]);
  return ethers.concat([baseCalldata, extraData]);
}

/**
 * Convenience helper to sign 30 equal-weighted Atlas proofs (or custom count) for an
 * 8-decimal USD settlement price and submit `settleWithAtlasTwap` on-chain.
 */
export async function settleExpiryWithCustomAtlasTwap(params: {
  oracle: any;
  caller: Signer;
  signerPrivateKey: string;
  assetId: string;
  feedId: string;
  expiry: number | bigint;
  price8: bigint;
  count?: number;
  interval?: number;
  timestampOffsets?: number[];
}): Promise<ContractTransactionResponse> {
  const { extraDatas } = buildSignedAtlasTwapProofs({
    signerPrivateKey: params.signerPrivateKey,
    feedId: params.feedId,
    expiry: params.expiry,
    prices18: params.price8 * 10n ** 10n,
    count: params.count,
    interval: params.interval,
    timestampOffsets: params.timestampOffsets,
  });

  return params.oracle
    .connect(params.caller)
    .settleWithAtlasTwap(params.assetId, params.expiry, extraDatas);
}

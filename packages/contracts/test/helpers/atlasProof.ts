import { ethers } from "hardhat";
import type { ContractTransactionResponse, Signer } from "ethers";

export const ATLAS_MAGIC_MARKER = "0x7096";
export const ATLAS_OFFICIAL_SIGNER = "0x59eD4701224fD9e2a85Ef2946c2ab828C1dDC600";

export const FEED_ID_BTC = "0x00000272"; // #626 BTC/USD
export const FEED_ID_ETH = "0x00000278"; // #632 ETH/USD

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
 * Builds calldata for `settleWithAtlasProof(assetId, expiry)` with trailing Atlas extraData.
 */
export function encodeSettleWithAtlasProofCalldata(
  oracleInterface: ethers.Interface,
  assetId: string,
  expiry: number | bigint,
  extraData: string
): string {
  const baseCalldata = oracleInterface.encodeFunctionData("settleWithAtlasProof", [
    assetId,
    expiry,
  ]);
  return ethers.concat([baseCalldata, extraData]);
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
 * Convenience helper to sign an 8-decimal USD settlement price into an 18-decimal
 * Atlas proof and submit `settleWithAtlasProof` on-chain.
 */
export async function settleExpiryWithCustomAtlasProof(params: {
  oracle: {
    getAddress(): Promise<string>;
    interface: ethers.Interface;
  };
  caller: Signer;
  signerPrivateKey: string;
  assetId: string;
  feedId: string;
  expiry: number | bigint;
  price8: bigint;
  oracleTimestamp?: number | bigint;
}): Promise<ContractTransactionResponse> {
  const proof = buildSignedAtlasProof(params.signerPrivateKey, [
    {
      feedId: params.feedId,
      price18: params.price8 * 10n ** 10n,
      timestamp: params.oracleTimestamp ?? params.expiry,
    },
  ]);

  const data = encodeSettleWithAtlasProofCalldata(
    params.oracle.interface,
    params.assetId,
    params.expiry,
    proof.extraData
  );

  return params.caller.sendTransaction({
    to: await params.oracle.getAddress(),
    data,
  });
}

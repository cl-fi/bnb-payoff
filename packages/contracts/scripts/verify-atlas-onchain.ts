import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const ATLAS_API_BASE = "https://api.atlasoracle.io/report";
const ASSET_BTC = ethers.keccak256(ethers.toUtf8Bytes("BTC"));
const ASSET_ETH = ethers.keccak256(ethers.toUtf8Bytes("ETH"));

interface AtlasSignedResponse {
  data?: {
    payload: string;
    signature: string;
    magicMarker: string;
    parsedPayload?: string;
    consensusScores?: Array<{
      feedId: string;
      consensusScore: number;
      consensusStatus: string;
      twapPrice: string;
      medianPrice: string;
    }>;
    priceDetails?: Array<{
      feedId: string;
      timestampSeconds: string;
      price: number;
    }>;
  };
  status?: {
    error_code: string;
    error_message: string;
  };
}

interface ParsedFeedEntry {
  feedId: string;
  price: string | number;
  timestampSeconds: string;
}

function getExplorerTxUrl(chainId: number, txHash: string): string {
  if (chainId === 97) return `https://testnet.bscscan.com/tx/${txHash}`;
  if (chainId === 56) return `https://bscscan.com/tx/${txHash}`;
  return txHash;
}

function computeMostRecent08Utc(nowSec: number): number {
  const daySec = 86400;
  const offset = 8 * 3600;
  let expiry = Math.floor((nowSec - offset) / daySec) * daySec + offset;
  if (nowSec - expiry < 60) {
    expiry -= daySec;
  }
  return expiry;
}

async function fetchAtlasSigned(
  endpoint: string,
  body: Record<string, unknown>,
  apiKey: string
): Promise<NonNullable<AtlasSignedResponse["data"]>> {
  const response = await fetch(`${ATLAS_API_BASE}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Atlas API ${endpoint} failed with HTTP ${response.status}`);
  }

  const json = (await response.json()) as AtlasSignedResponse;
  if (!json.data || !json.data.payload || !json.data.signature || !json.data.magicMarker) {
    throw new Error(
      `Atlas API ${endpoint} returned invalid signed payload (${json.status?.error_message ?? "unknown"})`
    );
  }
  return json.data;
}

function extractParsedPrice18(
  data: NonNullable<AtlasSignedResponse["data"]>,
  targetFeedId: string
): bigint {
  if (data.parsedPayload) {
    // Parse large 18-decimal integer price strings accurately without Number precision loss
    const normalized = data.parsedPayload.replace(
      /"price"\s*:\s*(\d+)/g,
      '"price":"$1"'
    );
    const entries = JSON.parse(normalized) as ParsedFeedEntry[];
    const match = entries.find((e) => String(e.feedId) === targetFeedId);
    if (match) {
      return BigInt(String(match.price));
    }
  }
  const detail = data.priceDetails?.find((d) => String(d.feedId) === targetFeedId);
  if (!detail) {
    throw new Error(`Feed #${targetFeedId} not found in Atlas response`);
  }
  return ethers.parseUnits(detail.price.toFixed(8), 18);
}

async function main() {
  const apiKey = process.env.ATLAS_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("Missing ATLAS_API_KEY in environment (.env)");
  }

  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const manifestFile =
    chainId === 31337 ? "localhost.json" : `${network.name}.json`;
  const manifestPath = path.resolve(__dirname, "../deployments", manifestFile);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Deployment manifest not found: ${manifestPath}`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    settlementOracleAddress: string;
    atlasSignerAddress: string;
  };
  const oracleAddress = manifest.settlementOracleAddress;

  const [signer] = await ethers.getSigners();
  const oracle = await ethers.getContractAt("AtlasPullSettlementOracle", oracleAddress, signer);

  console.log(`Verifying AtlasPullSettlementOracle on ${network.name} (chainId=${chainId})`);
  console.log(`Oracle Contract: ${oracleAddress}`);
  console.log(`Authorized Signer: ${await oracle.authorizedSigner()}`);

  // -------------------------------------------------------------------------
  // Step 1: Live /v1/price/latest verification via eth_call (BTC #626 & ETH #632)
  // -------------------------------------------------------------------------
  console.log("\n[1/2] Fetching live signed Atlas prices (/v1/price/latest for #626 & #632)...");
  const latestData = await fetchAtlasSigned(
    "/v1/price/latest",
    { feedIds: ["626", "632"], signed: true },
    apiKey
  );
  const latestExtraData = ethers.concat([
    latestData.payload,
    latestData.signature,
    latestData.magicMarker,
  ]);

  for (const [symbol, assetId, feedNum] of [
    ["BTC", ASSET_BTC, "626"],
    ["ETH", ASSET_ETH, "632"],
  ] as const) {
    const callData = ethers.concat([
      oracle.interface.encodeFunctionData("verifyLatestAtlasPrice", [assetId]),
      latestExtraData,
    ]);
    const rawResult = await ethers.provider.call({
      to: oracleAddress,
      data: callData,
    });
    const decoded = oracle.interface.decodeFunctionResult(
      "verifyLatestAtlasPrice",
      rawResult
    );
    const price8 = decoded[0] as bigint;
    const aggregatedTimestamp = decoded[2] as bigint;
    const feedIdHex = decoded[3] as string;
    const cs = latestData.consensusScores?.find((c) => c.feedId === feedNum);
    console.log(
      `  ✓ ${symbol}/USD (${feedIdHex}): $${ethers.formatUnits(price8, 8)} @ ts=${aggregatedTimestamp}` +
        (cs
          ? ` | ConsensusScore=${(cs.consensusScore * 100).toFixed(2)}% (${cs.consensusStatus})`
          : "")
    );
  }

  // -------------------------------------------------------------------------
  // Step 2: Historical /v1/price/history (08:00 UTC) on-chain settlement proof
  // -------------------------------------------------------------------------
  const latestBlock = await ethers.provider.getBlock("latest");
  const chainNow = latestBlock ? Number(latestBlock.timestamp) : Math.floor(Date.now() / 1000);
  const expiry = process.env.VERIFY_EXPIRY_TS
    ? Number(process.env.VERIFY_EXPIRY_TS)
    : computeMostRecent08Utc(chainNow);

  console.log(
    `\n[2/2] Verifying historical 08:00 UTC expiry settlement for BTC (expiry=${expiry}, ${new Date(expiry * 1000).toISOString()})...`
  );

  const historyData = await fetchAtlasSigned(
    "/v1/price/history",
    { feedIds: ["626"], timestamp: expiry, signed: true },
    apiKey
  );
  const expectedPrice18 = extractParsedPrice18(historyData, "626");
  const expectedPrice8 = expectedPrice18 / 10n ** 10n;
  const historyExtraData = ethers.concat([
    historyData.payload,
    historyData.signature,
    historyData.magicMarker,
  ]);

  const existing = await oracle.getSettlement(ASSET_BTC, expiry);
  if (existing.settled) {
    console.log(
      `  ℹ Expiry ${expiry} is already settled on-chain at $${ethers.formatUnits(existing.price, 8)}`
    );
  } else {
    console.log(
      `  Submitting settleWithAtlasProof(ASSET_BTC, ${expiry}) with signed Atlas history proof...`
    );
    const settleCalldata = ethers.concat([
      oracle.interface.encodeFunctionData("settleWithAtlasProof", [ASSET_BTC, expiry]),
      historyExtraData,
    ]);
    const tx = await signer.sendTransaction({
      to: oracleAddress,
      data: settleCalldata,
      ...(chainId === 31337 ? {} : { gasPrice: ethers.parseUnits("1", "gwei") }),
    });
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
      throw new Error("settleWithAtlasProof transaction failed");
    }
    console.log(`  ✓ Settlement confirmed in block ${receipt.blockNumber}`);
    console.log(`  ✓ Explorer TX: ${getExplorerTxUrl(chainId, receipt.hash)}`);
  }

  let settled = await oracle.getSettlement(ASSET_BTC, expiry);
  for (let attempt = 0; attempt < 6 && !settled.settled; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    settled = await oracle.getSettlement(ASSET_BTC, expiry);
  }
  const [metaFeedId, metaOracleTs] = await oracle.getSettlementMeta(ASSET_BTC, expiry);

  if (!settled.settled) {
    throw new Error("Verification failed: getSettlement returned settled=false");
  }
  if (settled.price !== expectedPrice8) {
    throw new Error(
      `Verification failed: on-chain price ${settled.price} != expected Atlas price ${expectedPrice8}`
    );
  }

  console.log(
    `  ✓ Verified on-chain getSettlement(BTC, ${expiry}): settled=true, price=$${ethers.formatUnits(settled.price, 8)}, feedId=${metaFeedId}, oracleTs=${metaOracleTs}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

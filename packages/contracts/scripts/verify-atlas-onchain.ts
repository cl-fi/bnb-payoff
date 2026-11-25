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
  // Require at least 120s past expiry so settlementDelay (60s) & Atlas history indexing are ready
  if (nowSec - expiry < 120) {
    expiry -= daySec;
  }
  return expiry;
}

async function fetchAtlasSigned(
  endpoint: string,
  body: Record<string, unknown>,
  apiKey: string
): Promise<NonNullable<AtlasSignedResponse["data"]>> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
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
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw lastErr;
}

function extractParsedEntry(
  data: NonNullable<AtlasSignedResponse["data"]>,
  targetFeedId: string
): { price18: bigint; timestampSeconds: number } {
  if (data.parsedPayload) {
    const normalized = data.parsedPayload.replace(
      /"price"\s*:\s*(\d+)/g,
      '"price":"$1"'
    );
    const entries = JSON.parse(normalized) as ParsedFeedEntry[];
    const match = entries.find((e) => String(e.feedId) === targetFeedId);
    if (match) {
      return {
        price18: BigInt(String(match.price)),
        timestampSeconds: Number(match.timestampSeconds),
      };
    }
  }
  // Fallback: decode exact 18-decimal price & 48-bit timestamp directly from signed payload bytes
  // Layout per 20-byte package: [4B feedId][10B uint80 price18][6B uint48 timestamp], followed by 1B count
  const cleanPayload = data.payload.startsWith("0x")
    ? data.payload.slice(2)
    : data.payload;
  const targetFeedHex = Number(targetFeedId).toString(16).padStart(8, "0");
  if (cleanPayload.length >= 42) {
    const count = parseInt(cleanPayload.slice(-2), 16);
    const bodyHex = cleanPayload.slice(0, cleanPayload.length - 2);
    if (count > 0 && bodyHex.length === count * 40) {
      for (let i = 0; i < count; i++) {
        const pkgHex = bodyHex.slice(i * 40, (i + 1) * 40);
        if (pkgHex.slice(0, 8).toLowerCase() === targetFeedHex) {
          return {
            price18: BigInt("0x" + pkgHex.slice(8, 28)),
            timestampSeconds: Number(BigInt("0x" + pkgHex.slice(28, 40))),
          };
        }
      }
    }
  }
  const detail = data.priceDetails?.find((d) => String(d.feedId) === targetFeedId);
  if (!detail) {
    throw new Error(`Feed #${targetFeedId} not found in Atlas response`);
  }
  return {
    price18: ethers.parseUnits(detail.price.toFixed(8), 18),
    timestampSeconds: Number(detail.timestampSeconds),
  };
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

  const sampleCount = Number(await oracle.twapSampleCount());
  const sampleInterval = Number(await oracle.twapSampleInterval());
  const settlementDelay = Number(await oracle.settlementDelay());

  console.log(`Verifying AtlasPullSettlementOracle on ${network.name} (chainId=${chainId})`);
  console.log(`Oracle Contract: ${oracleAddress}`);
  console.log(`Authorized Signer: ${await oracle.authorizedSigner()}`);
  console.log(
    `TWAP Config: ${sampleCount} samples @ ${sampleInterval}s interval, delay=${settlementDelay}s`
  );

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
  // Step 2: 30-Point 1-Minute Historical TWAP Settlement on BSC Testnet
  // -------------------------------------------------------------------------
  const latestBlock = await ethers.provider.getBlock("latest");
  const chainNow = latestBlock ? Number(latestBlock.timestamp) : Math.floor(Date.now() / 1000);
  const expiry = process.env.VERIFY_EXPIRY_TS
    ? Number(process.env.VERIFY_EXPIRY_TS)
    : computeMostRecent08Utc(chainNow);

  const schedule = (await oracle.getTwapSampleTimestamps(expiry)).map((t) => Number(t));
  console.log(
    `\n[2/2] Fetching ${schedule.length} historical 1-min signed Atlas proofs for BTC expiry=${expiry} (${new Date(expiry * 1000).toISOString()})...`
  );
  console.log(
    `  Window: ${new Date(schedule[0]! * 1000).toISOString()} -> ${new Date(schedule[schedule.length - 1]! * 1000).toISOString()}`
  );

  // Fetch 30 proofs in controlled batches of 6
  const proofs: string[] = new Array(schedule.length);
  const fetchedEntries: Array<{ targetTs: number; actualTs: number; price18: bigint }> = new Array(
    schedule.length
  );
  const CONCURRENCY = 6;
  for (let start = 0; start < schedule.length; start += CONCURRENCY) {
    const slice = schedule.slice(start, start + CONCURRENCY);
    await Promise.all(
      slice.map(async (targetTs, offset) => {
        const idx = start + offset;
        const data = await fetchAtlasSigned(
          "/v1/price/history",
          { feedIds: ["626"], timestamp: targetTs, signed: true },
          apiKey
        );
        const entry = extractParsedEntry(data, "626");
        proofs[idx] = ethers.concat([data.payload, data.signature, data.magicMarker]);
        fetchedEntries[idx] = {
          targetTs,
          actualTs: entry.timestampSeconds,
          price18: entry.price18,
        };
      })
    );
  }

  let sumPrice18 = 0n;
  let maxAbsDiff = 0;
  for (const e of fetchedEntries) {
    sumPrice18 += e.price18;
    const diff = Math.abs(e.actualTs - e.targetTs);
    if (diff > maxAbsDiff) maxAbsDiff = diff;
  }
  const expectedTwapPrice8 = sumPrice18 / (BigInt(schedule.length) * 10n ** 10n);
  console.log(
    `  ✓ Fetched ${schedule.length} signed proofs | maxTimestampDiff=${maxAbsDiff}s | expected 30m TWAP=$${ethers.formatUnits(expectedTwapPrice8, 8)}`
  );
  if (maxAbsDiff > 0) {
    console.warn(`  ⚠ Note: non-zero timestamp diff observed (${maxAbsDiff}s)`);
  }

  const existing = await oracle.getSettlement(ASSET_BTC, expiry);
  if (existing.settled) {
    console.log(
      `  ℹ Expiry ${expiry} is already settled on-chain at $${ethers.formatUnits(existing.price, 8)}`
    );
  } else {
    console.log(
      `  Submitting settleWithAtlasTwap(ASSET_BTC, ${expiry}, proofs[${proofs.length}])...`
    );
    const tx = await oracle.settleWithAtlasTwap(
      ASSET_BTC,
      expiry,
      proofs,
      chainId === 31337 ? {} : { gasPrice: ethers.parseUnits("1", "gwei") }
    );
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
      throw new Error("settleWithAtlasTwap transaction failed");
    }
    console.log(
      `  ✓ Settlement confirmed in block ${receipt.blockNumber} (gasUsed=${receipt.gasUsed.toString()})`
    );
    console.log(`  ✓ Explorer TX: ${getExplorerTxUrl(chainId, receipt.hash)}`);
  }

  let settled = await oracle.getSettlement(ASSET_BTC, expiry);
  for (let attempt = 0; attempt < 6 && !settled.settled; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    settled = await oracle.getSettlement(ASSET_BTC, expiry);
  }
  const meta = await oracle.getSettlementMeta(ASSET_BTC, expiry);

  if (!settled.settled) {
    throw new Error("Verification failed: getSettlement returned settled=false");
  }
  if (settled.price !== expectedTwapPrice8) {
    throw new Error(
      `Verification failed: on-chain price ${settled.price} != expected 30m TWAP ${expectedTwapPrice8}`
    );
  }
  if (Number(meta.sampleCount) !== schedule.length || meta.isManualOverride) {
    throw new Error(
      `Verification failed: unexpected meta sampleCount=${meta.sampleCount}, isManualOverride=${meta.isManualOverride}`
    );
  }

  console.log(
    `  ✓ Verified on-chain getSettlement(BTC, ${expiry}): settled=true, price=$${ethers.formatUnits(settled.price, 8)}, samples=${meta.sampleCount}, window=[${meta.windowStartTimestamp}..${meta.windowEndTimestamp}], isManualOverride=${meta.isManualOverride}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const ATLAS_API_BASE = "https://api.atlasoracle.io/report";
const ASSET_BTC = ethers.keccak256(ethers.toUtf8Bytes("BTC"));
const ASSET_ETH = ethers.keccak256(ethers.toUtf8Bytes("ETH"));
const ASSET_NVDAB = ethers.keccak256(ethers.toUtf8Bytes("NVDAB"));

type SupportedVerifySymbol = "BTC" | "ETH" | "NVDAB";

interface VerifyAssetConfig {
  symbol: SupportedVerifySymbol;
  assetId: string;
  feedId: string;
  feedIdHex: string;
  settlementUtcHour: number;
  isUsEquityMwf: boolean;
}

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

function parseSettlementUtcHour(raw: string | number | undefined, defaultHour: number): number {
  if (raw === undefined || raw === null) return defaultHour;
  const trimmed = String(raw).trim();
  if (!trimmed) return defaultHour;
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Invalid settlement UTC hour "${trimmed}" (expected integer 0-23)`);
  }
  const hour = Number(trimmed);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error(`Settlement UTC hour ${hour} out of range (expected 0-23)`);
  }
  return hour;
}

function computeMostRecentUtcAtOffset(nowSec: number, offsetSec: number): number {
  const daySec = 86400;
  let expiry = Math.floor((nowSec - offsetSec) / daySec) * daySec + offsetSec;
  // Require at least 120s past expiry so settlementDelay (60s) & Atlas history indexing are ready
  if (nowSec - expiry < 120) {
    expiry -= daySec;
  }
  return expiry;
}

function computeMostRecentMwfUtc(nowSec: number, settlementUtcHour: number): number {
  const daySec = 86400;
  const offsetSec = settlementUtcHour * 3600;
  let candidate = computeMostRecentUtcAtOffset(nowSec, offsetSec);
  // Walk backwards to most recent Mon (1), Wed (3), or Fri (5) US equity expiry close
  for (let i = 0; i < 7; i++) {
    const dow = new Date(candidate * 1000).getUTCDay();
    if (dow === 1 || dow === 3 || dow === 5) {
      return candidate;
    }
    candidate -= daySec;
  }
  return candidate;
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
    atlasFeeds?: Record<
      string,
      { feedId: string; feedIdHex: string; pair: string; settlementUtcHour?: number }
    >;
  };
  const oracleAddress = manifest.settlementOracleAddress;

  const nvdabSettlementUtcHour = parseSettlementUtcHour(
    process.env.NVDAB_SETTLEMENT_UTC_HOUR ?? manifest.atlasFeeds?.NVDAB?.settlementUtcHour,
    21
  );

  const assetConfigs: Record<SupportedVerifySymbol, VerifyAssetConfig> = {
    BTC: {
      symbol: "BTC",
      assetId: ASSET_BTC,
      feedId: "626",
      feedIdHex: "0x00000272",
      settlementUtcHour: 8,
      isUsEquityMwf: false,
    },
    ETH: {
      symbol: "ETH",
      assetId: ASSET_ETH,
      feedId: "632",
      feedIdHex: "0x00000278",
      settlementUtcHour: 8,
      isUsEquityMwf: false,
    },
    NVDAB: {
      symbol: "NVDAB",
      assetId: ASSET_NVDAB,
      feedId: "1005",
      feedIdHex: "0x000003ed",
      settlementUtcHour: nvdabSettlementUtcHour,
      isUsEquityMwf: true,
    },
  };

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
  // Step 1: Live /v1/price/latest verification via eth_call (BTC, ETH, and NVDAB when configured)
  // -------------------------------------------------------------------------
  const step1Candidates: VerifyAssetConfig[] = [
    assetConfigs.BTC,
    assetConfigs.ETH,
    assetConfigs.NVDAB,
  ];
  const configuredFeedIds = await Promise.all(
    step1Candidates.map((c) => oracle.assetFeedIds(c.assetId))
  );
  const step1Assets: VerifyAssetConfig[] = [];
  for (let i = 0; i < step1Candidates.length; i++) {
    const candidate = step1Candidates[i]!;
    const onChainFeed = configuredFeedIds[i]!.toLowerCase();
    if (onChainFeed !== "0x00000000") {
      step1Assets.push(candidate);
    } else {
      console.log(
        `  ℹ Skipping ${candidate.symbol} (#${candidate.feedId}) in Step 1: not yet registered on oracle`
      );
    }
  }
  if (step1Assets.length === 0) {
    throw new Error("No supported assets configured on oracle");
  }

  const step1FeedIds = step1Assets.map((a) => a.feedId);
  console.log(
    `\n[1/2] Fetching live signed Atlas prices (/v1/price/latest for ${step1Assets.map((a) => `${a.symbol} #${a.feedId}`).join(", ")})...`
  );
  const latestData = await fetchAtlasSigned(
    "/v1/price/latest",
    { feedIds: step1FeedIds, signed: true },
    apiKey
  );
  const latestExtraData = ethers.concat([
    latestData.payload,
    latestData.signature,
    latestData.magicMarker,
  ]);

  for (const spec of step1Assets) {
    const callData = ethers.concat([
      oracle.interface.encodeFunctionData("verifyLatestAtlasPrice", [spec.assetId]),
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
    const cs = latestData.consensusScores?.find((c) => c.feedId === spec.feedId);
    console.log(
      `  ✓ ${spec.symbol}/USD (${feedIdHex}): $${ethers.formatUnits(price8, 8)} @ ts=${aggregatedTimestamp}` +
        (cs
          ? ` | ConsensusScore=${(cs.consensusScore * 100).toFixed(2)}% (${cs.consensusStatus})`
          : "")
    );
  }

  // -------------------------------------------------------------------------
  // Step 2: 30-Point 1-Minute Historical TWAP Settlement on BSC Testnet / Local
  // -------------------------------------------------------------------------
  const verifyAssetRaw = (process.env.VERIFY_ASSET || "BTC").trim().toUpperCase();
  if (!(verifyAssetRaw in assetConfigs)) {
    throw new Error(
      `Unsupported VERIFY_ASSET="${verifyAssetRaw}". Supported values: BTC, ETH, NVDAB.`
    );
  }
  const targetAsset = assetConfigs[verifyAssetRaw as SupportedVerifySymbol];
  const targetOnChainFeed = (await oracle.assetFeedIds(targetAsset.assetId)).toLowerCase();
  if (targetOnChainFeed === "0x00000000") {
    throw new Error(
      `VERIFY_ASSET=${targetAsset.symbol} is NOT registered on oracle ${oracleAddress}. Run pnpm register:rwa:${chainId === 31337 ? "local" : "bsc"} first.`
    );
  }
  if (targetOnChainFeed !== targetAsset.feedIdHex.toLowerCase()) {
    throw new Error(
      `Oracle feedId mismatch for ${targetAsset.symbol}: on-chain=${targetOnChainFeed}, expected=${targetAsset.feedIdHex}`
    );
  }

  const latestBlock = await ethers.provider.getBlock("latest");
  const chainNow = latestBlock ? Number(latestBlock.timestamp) : Math.floor(Date.now() / 1000);
  let expiry: number;
  if (process.env.VERIFY_EXPIRY_TS?.trim()) {
    expiry = Number(process.env.VERIFY_EXPIRY_TS.trim());
    if (!Number.isInteger(expiry) || expiry <= 0 || expiry >= 1e11) {
      throw new Error(
        `Invalid VERIFY_EXPIRY_TS="${process.env.VERIFY_EXPIRY_TS}" (expected unix seconds)`
      );
    }
  } else if (targetAsset.isUsEquityMwf) {
    expiry = computeMostRecentMwfUtc(chainNow, targetAsset.settlementUtcHour);
  } else {
    expiry = computeMostRecentUtcAtOffset(chainNow, targetAsset.settlementUtcHour * 3600);
  }

  const schedule = (await oracle.getTwapSampleTimestamps(expiry)).map((t) => Number(t));
  console.log(
    `\n[2/2] Fetching ${schedule.length} historical 1-min signed Atlas proofs for ${targetAsset.symbol} (#${targetAsset.feedId}) expiry=${expiry} (${new Date(expiry * 1000).toISOString()})...`
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
          { feedIds: [targetAsset.feedId], timestamp: targetTs, signed: true },
          apiKey
        );
        const entry = extractParsedEntry(data, targetAsset.feedId);
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

  const existing = await oracle.getSettlement(targetAsset.assetId, expiry);
  if (existing.settled) {
    console.log(
      `  ℹ ${targetAsset.symbol} expiry ${expiry} is already settled on-chain at $${ethers.formatUnits(existing.price, 8)}`
    );
  } else {
    console.log(
      `  Submitting settleWithAtlasTwap(ASSET_${targetAsset.symbol}, ${expiry}, proofs[${proofs.length}])...`
    );
    const tx = await oracle.settleWithAtlasTwap(
      targetAsset.assetId,
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

  let settled = await oracle.getSettlement(targetAsset.assetId, expiry);
  for (let attempt = 0; attempt < 6 && !settled.settled; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    settled = await oracle.getSettlement(targetAsset.assetId, expiry);
  }
  const meta = await oracle.getSettlementMeta(targetAsset.assetId, expiry);

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
    `  ✓ Verified on-chain getSettlement(${targetAsset.symbol}, ${expiry}): settled=true, price=$${ethers.formatUnits(settled.price, 8)}, samples=${meta.sampleCount}, window=[${meta.windowStartTimestamp}..${meta.windowEndTimestamp}], isManualOverride=${meta.isManualOverride}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

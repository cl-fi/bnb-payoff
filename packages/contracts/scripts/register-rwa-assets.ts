import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const ASSET_NVDAB = ethers.keccak256(ethers.toUtf8Bytes("NVDAB"));
const NVDAB_FEED_ID = "1005";
const NVDAB_FEED_ID_HEX = "0x000003ed";
const NVDAB_PAIR = "NVDAB/USD";
const NVDAB_EXPIRY_INTERVAL = 86400n;

interface AtlasFeedManifestEntry {
  feedId: string;
  feedIdHex: string;
  pair: string;
  settlementUtcHour?: number;
}

interface DeploymentManifest {
  network: string;
  chainId: number;
  usdtAddress: string;
  vaultAddress: string;
  lensAddress: string;
  settlementOracleAddress: string;
  atlasSignerAddress: string;
  atlasFeeds?: Record<string, AtlasFeedManifestEntry>;
  [key: string]: unknown;
}

function parseSettlementUtcHour(raw: string | undefined, defaultHour: number): number {
  const trimmed = raw?.trim();
  if (!trimmed) return defaultHour;
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(
      `Invalid NVDAB_SETTLEMENT_UTC_HOUR="${trimmed}" (expected integer UTC hour 0-23, e.g. 21 for EST or 20 for EDT)`
    );
  }
  const hour = Number(trimmed);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error(
      `NVDAB_SETTLEMENT_UTC_HOUR=${hour} out of range (expected integer UTC hour 0-23)`
    );
  }
  return hour;
}

function getExplorerTxUrl(chainId: number, txHash: string): string {
  if (chainId === 97) return `https://testnet.bscscan.com/tx/${txHash}`;
  if (chainId === 56) return `https://bscscan.com/tx/${txHash}`;
  return txHash;
}

function writeJsonAtomically(filePath: string, payload: unknown): boolean {
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  if (fs.existsSync(filePath) && fs.readFileSync(filePath, "utf8") === serialized) {
    return false;
  }
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, serialized, "utf8");
  fs.renameSync(tmpPath, filePath);
  return true;
}

async function main() {
  if (network.name === "hardhat") {
    throw new Error(
      "Refusing to run against ephemeral in-process `hardhat` network. Pass `--network bscTestnet` or `--network localhost`."
    );
  }

  const settlementUtcHour = parseSettlementUtcHour(
    process.env.NVDAB_SETTLEMENT_UTC_HOUR,
    21
  );
  if (settlementUtcHour !== 21 && settlementUtcHour !== 20) {
    console.warn(
      `⚠ Unusual NVDAB_SETTLEMENT_UTC_HOUR=${settlementUtcHour} (standard US equity close is 21 UTC EST / 20 UTC EDT)`
    );
  }
  const targetOffset = BigInt(settlementUtcHour) * 3600n;

  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const isLocal = chainId === 31337 || network.name === "localhost";
  const manifestFile = isLocal ? "localhost.json" : `${network.name}.json`;
  const manifestPath = path.resolve(__dirname, "../deployments", manifestFile);

  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Deployment manifest not found: ${manifestPath}`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as DeploymentManifest;
  if (!manifest.vaultAddress || !ethers.isAddress(manifest.vaultAddress)) {
    throw new Error(`Invalid or missing vaultAddress in ${manifestPath}`);
  }
  if (
    !manifest.settlementOracleAddress ||
    !ethers.isAddress(manifest.settlementOracleAddress)
  ) {
    throw new Error(`Invalid or missing settlementOracleAddress in ${manifestPath}`);
  }

  const [signer] = await ethers.getSigners();
  if (!signer) {
    throw new Error(`No signer configured for network ${network.name}`);
  }

  const txOverrides = isLocal ? {} : { gasPrice: ethers.parseUnits("1", "gwei") };
  const vault = await ethers.getContractAt(
    "PayoffSpreadVault",
    manifest.vaultAddress,
    signer
  );
  const oracle = await ethers.getContractAt(
    "AtlasPullSettlementOracle",
    manifest.settlementOracleAddress,
    signer
  );

  console.log(
    `[RegisterRWA] network=${network.name} (chainId=${chainId}) caller=${signer.address}`
  );
  console.log(
    `[RegisterRWA] Vault=${manifest.vaultAddress} Oracle=${manifest.settlementOracleAddress}`
  );
  console.log(
    `[RegisterRWA] Target asset=NVDAB (${ASSET_NVDAB}) feed=${NVDAB_FEED_ID_HEX} (#${NVDAB_FEED_ID}) settlement=${String(settlementUtcHour).padStart(2, "0")}:00 UTC (offset=${targetOffset}s, cadence=${NVDAB_EXPIRY_INTERVAL}s)`
  );

  // -------------------------------------------------------------------------
  // 1. PayoffSpreadVault.setAssetConfig(ASSET_NVDAB, true, true, offset, 86400)
  // -------------------------------------------------------------------------
  const currentCfg = await vault.assetConfigs(ASSET_NVDAB);
  const vaultAlreadyMatches =
    currentCfg.enabled === true &&
    currentCfg.enforceStandardExpiry === true &&
    BigInt(currentCfg.settlementUtcOffset) === targetOffset &&
    BigInt(currentCfg.expiryInterval) === NVDAB_EXPIRY_INTERVAL;

  if (vaultAlreadyMatches) {
    console.log(
      `  [SKIP] Vault assetConfigs(NVDAB) already matches: enabled=true, enforceStandardExpiry=true, offset=${currentCfg.settlementUtcOffset}s, interval=${currentCfg.expiryInterval}s`
    );
  } else {
    console.log(
      `  [TX] Calling vault.setAssetConfig(NVDAB, true, true, ${targetOffset}, ${NVDAB_EXPIRY_INTERVAL})...`
    );
    await vault.setAssetConfig.staticCall(
      ASSET_NVDAB,
      true,
      true,
      targetOffset,
      NVDAB_EXPIRY_INTERVAL
    );
    const tx = await vault.setAssetConfig(
      ASSET_NVDAB,
      true,
      true,
      targetOffset,
      NVDAB_EXPIRY_INTERVAL,
      txOverrides
    );
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
      throw new Error("vault.setAssetConfig(NVDAB) transaction failed");
    }
    console.log(
      `  ✓ Vault asset config updated in block ${receipt.blockNumber}: ${getExplorerTxUrl(chainId, receipt.hash)}`
    );

    let verifiedCfg = await vault.assetConfigs(ASSET_NVDAB);
    for (
      let attempt = 0;
      attempt < 6 &&
      !(
        verifiedCfg.enabled === true &&
        verifiedCfg.enforceStandardExpiry === true &&
        BigInt(verifiedCfg.settlementUtcOffset) === targetOffset &&
        BigInt(verifiedCfg.expiryInterval) === NVDAB_EXPIRY_INTERVAL
      );
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      verifiedCfg = await vault.assetConfigs(ASSET_NVDAB);
    }
    if (
      verifiedCfg.enabled !== true ||
      verifiedCfg.enforceStandardExpiry !== true ||
      BigInt(verifiedCfg.settlementUtcOffset) !== targetOffset ||
      BigInt(verifiedCfg.expiryInterval) !== NVDAB_EXPIRY_INTERVAL
    ) {
      throw new Error(
        `Post-tx verification failed for vault.assetConfigs(NVDAB): enabled=${verifiedCfg.enabled}, enforceStandardExpiry=${verifiedCfg.enforceStandardExpiry}, offset=${verifiedCfg.settlementUtcOffset}, interval=${verifiedCfg.expiryInterval}`
      );
    }
  }

  // -------------------------------------------------------------------------
  // 2. AtlasPullSettlementOracle.setAssetFeedId(ASSET_NVDAB, 0x000003ed)
  // -------------------------------------------------------------------------
  const currentFeedId = (await oracle.assetFeedIds(ASSET_NVDAB)).toLowerCase();
  const oracleAlreadyMatches = currentFeedId === NVDAB_FEED_ID_HEX.toLowerCase();

  if (oracleAlreadyMatches) {
    console.log(
      `  [SKIP] Oracle assetFeedIds(NVDAB) already mapped to ${currentFeedId} (#${NVDAB_FEED_ID})`
    );
  } else {
    console.log(
      `  [TX] Calling oracle.setAssetFeedId(NVDAB, ${NVDAB_FEED_ID_HEX})...`
    );
    await oracle.setAssetFeedId.staticCall(ASSET_NVDAB, NVDAB_FEED_ID_HEX);
    const tx = await oracle.setAssetFeedId(ASSET_NVDAB, NVDAB_FEED_ID_HEX, txOverrides);
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
      throw new Error("oracle.setAssetFeedId(NVDAB) transaction failed");
    }
    console.log(
      `  ✓ Oracle feed mapping updated in block ${receipt.blockNumber}: ${getExplorerTxUrl(chainId, receipt.hash)}`
    );

    let verifiedFeedId = (await oracle.assetFeedIds(ASSET_NVDAB)).toLowerCase();
    for (
      let attempt = 0;
      attempt < 6 && verifiedFeedId !== NVDAB_FEED_ID_HEX.toLowerCase();
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      verifiedFeedId = (await oracle.assetFeedIds(ASSET_NVDAB)).toLowerCase();
    }
    if (verifiedFeedId !== NVDAB_FEED_ID_HEX.toLowerCase()) {
      throw new Error(
        `Post-tx verification failed for oracle.assetFeedIds(NVDAB): got ${verifiedFeedId}, expected ${NVDAB_FEED_ID_HEX}`
      );
    }
  }

  // -------------------------------------------------------------------------
  // 3. Update deployments/<network>.json manifest with atlasFeeds.NVDAB
  // -------------------------------------------------------------------------
  const updatedManifest: DeploymentManifest = {
    ...manifest,
    atlasFeeds: {
      ...(manifest.atlasFeeds ?? {}),
      NVDAB: {
        feedId: NVDAB_FEED_ID,
        feedIdHex: NVDAB_FEED_ID_HEX,
        pair: NVDAB_PAIR,
        settlementUtcHour,
      },
    },
  };

  const manifestChanged = writeJsonAtomically(manifestPath, updatedManifest);
  if (manifestChanged) {
    console.log(
      `  ✓ Updated deployments/${manifestFile} with atlasFeeds.NVDAB (feedId=${NVDAB_FEED_ID}, feedIdHex=${NVDAB_FEED_ID_HEX}, settlementUtcHour=${settlementUtcHour})`
    );
  } else {
    console.log(`  [SKIP] deployments/${manifestFile} already up to date`);
  }

  console.log("[RegisterRWA] Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

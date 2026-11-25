import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Operator CLI for AtlasPullSettlementOracle dispute resolution (owner/pauser key only,
 * never exposed via HTTP API).
 *
 * Usage (via env vars because Hardhat intercepts CLI flags):
 *   ACTION=pause   ASSET=BTC EXPIRY=1795593600 npx hardhat run scripts/emergency-settle.ts --network bscTestnet
 *   ACTION=unpause ASSET=BTC EXPIRY=1795593600 npx hardhat run scripts/emergency-settle.ts --network bscTestnet
 *   ACTION=settle  ASSET=BTC EXPIRY=1795593600 PRICE_USD=64250.50 REASON="Atlas 30m avg score 0.28 < 0.40" CONFIRM=yes npx hardhat run scripts/emergency-settle.ts --network bscTestnet
 */
async function main() {
  if (network.name === "hardhat") {
    throw new Error(
      "Refusing to run against ephemeral in-process `hardhat` network. Pass `--network bscTestnet` or `--network localhost`."
    );
  }

  const action = (process.env.ACTION || "").trim().toLowerCase();
  const assetSym = (process.env.ASSET || "").trim().toUpperCase();
  const expiry = Number(process.env.EXPIRY || 0);
  const force = process.env.FORCE === "1";

  if (!["pause", "unpause", "settle"].includes(action)) {
    throw new Error("Set ACTION=pause|unpause|settle");
  }
  if (!assetSym) {
    throw new Error("Set ASSET=BTC or ASSET=ETH explicitly");
  }
  if (!Number.isInteger(expiry) || expiry <= 0 || expiry >= 1e11) {
    throw new Error(
      "Set valid unix timestamp EXPIRY in seconds (e.g. 1795593600, NOT milliseconds)"
    );
  }
  const isStandard08Utc = expiry >= 28800 && (expiry - 28800) % 86400 === 0;
  if (!isStandard08Utc && !force) {
    throw new Error(
      `EXPIRY=${expiry} (${new Date(expiry * 1000).toISOString()}) is not aligned to 08:00 UTC. Pass FORCE=1 to override.`
    );
  }

  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const manifestFile = chainId === 31337 ? "localhost.json" : `${network.name}.json`;
  const manifestPath = path.resolve(__dirname, "../deployments", manifestFile);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Deployment manifest not found: ${manifestPath}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    settlementOracleAddress: string;
  };

  const [signer] = await ethers.getSigners();
  const oracle = await ethers.getContractAt(
    "AtlasPullSettlementOracle",
    manifest.settlementOracleAddress,
    signer
  );
  const assetId = ethers.keccak256(ethers.toUtf8Bytes(assetSym));
  const configuredFeedId = await oracle.assetFeedIds(assetId);
  if (configuredFeedId === "0x00000000") {
    throw new Error(
      `ASSET=${assetSym} is NOT configured on oracle ${manifest.settlementOracleAddress} (assetFeedIds=0x00000000). Use BTC or ETH.`
    );
  }

  const [latestBlock, currentlyPaused, currentSettlement] = await Promise.all([
    ethers.provider.getBlock("latest"),
    oracle.isExpiryPaused(assetId, expiry),
    oracle.getSettlement(assetId, expiry),
  ]);
  const blockTs = Number(latestBlock?.timestamp ?? 0);

  const txOverrides =
    chainId === 31337 ? {} : { gasPrice: ethers.parseUnits("1", "gwei") };

  console.log(
    `[EmergencyCLI] network=${network.name} (chainId=${chainId}) oracle=${manifest.settlementOracleAddress} caller=${signer.address}`
  );
  console.log(
    `[EmergencyCLI] action=${action} asset=${assetSym} (feedId=${configuredFeedId}) expiry=${expiry} (${new Date(expiry * 1000).toISOString()})`
  );
  console.log(
    `[EmergencyCLI] on-chain state: blockTime=${blockTs} (${new Date(blockTs * 1000).toISOString()}) paused=${currentlyPaused} settled=${currentSettlement.settled} price8=${currentSettlement.price}`
  );

  if (action === "pause") {
    await oracle.pauseExpiry.staticCall(assetId, expiry);
    const tx = await oracle.pauseExpiry(assetId, expiry, txOverrides);
    const receipt = await tx.wait();
    const verifiedPaused = await oracle.isExpiryPaused(assetId, expiry);
    if (!verifiedPaused) {
      throw new Error(`Post-tx verification failed: isExpiryPaused(${assetSym}, ${expiry}) is still false`);
    }
    console.log(
      `✓ Paused ${assetSym} expiry ${expiry} (verified on-chain) in block ${receipt?.blockNumber} tx=${receipt?.hash}`
    );
    return;
  }

  if (action === "unpause") {
    await oracle.unpauseExpiry.staticCall(assetId, expiry);
    const tx = await oracle.unpauseExpiry(assetId, expiry, txOverrides);
    const receipt = await tx.wait();
    console.log(
      `✓ Unpaused ${assetSym} expiry ${expiry} in block ${receipt?.blockNumber} tx=${receipt?.hash}`
    );
    return;
  }

  const priceUsdRaw = (process.env.PRICE_USD || "").trim();
  const reason = (process.env.REASON || "").trim();
  if (!priceUsdRaw || !/^\d+(\.\d{1,8})?$/.test(priceUsdRaw)) {
    throw new Error(
      "Set exact positive decimal USD price PRICE_USD with up to 8 decimals (e.g. PRICE_USD=64250.50)"
    );
  }
  const price8 = ethers.parseUnits(priceUsdRaw, 8);
  if (price8 <= 0n) {
    throw new Error("PRICE_USD must be strictly greater than 0");
  }
  if (!reason) {
    throw new Error("Set non-empty public audit REASON");
  }

  console.log(
    `[EmergencyCLI] Dry-running IRREVERSIBLE emergencyManualSettle: price=$${ethers.formatUnits(price8, 8)} (price8=${price8}) reason="${reason}"`
  );
  await oracle.emergencyManualSettle.staticCall(assetId, expiry, price8, reason);

  if (chainId !== 31337 && process.env.CONFIRM !== "yes") {
    console.log(
      `[EmergencyCLI] Dry-run succeeded. Re-run with CONFIRM=yes to broadcast irreversible settlement on ${network.name}.`
    );
    return;
  }

  const tx = await oracle.emergencyManualSettle(assetId, expiry, price8, reason, txOverrides);
  const receipt = await tx.wait();
  console.log(
    `✓ Emergency settled ${assetSym} expiry=${expiry} at $${ethers.formatUnits(price8, 8)} in block ${receipt?.blockNumber} tx=${receipt?.hash}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

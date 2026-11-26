import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const ATLAS_OFFICIAL_SIGNER = "0x59eD4701224fD9e2a85Ef2946c2ab828C1dDC600";
const ASSET_NVDAB = ethers.keccak256(ethers.toUtf8Bytes("NVDAB"));

function parseSettlementUtcHour(raw: string | undefined, defaultHour: number): number {
  const trimmed = raw?.trim();
  if (!trimmed) return defaultHour;
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(
      `Invalid NVDAB_SETTLEMENT_UTC_HOUR="${trimmed}" (expected integer UTC hour 0-23)`
    );
  }
  const hour = Number(trimmed);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error(`NVDAB_SETTLEMENT_UTC_HOUR=${hour} out of range (expected 0-23)`);
  }
  return hour;
}

const NVDAB_SETTLEMENT_UTC_HOUR = parseSettlementUtcHour(
  process.env.NVDAB_SETTLEMENT_UTC_HOUR,
  21
);

const ATLAS_FEEDS = {
  BTC: { feedId: "626", feedIdHex: "0x00000272", pair: "BTC/USD" },
  ETH: { feedId: "632", feedIdHex: "0x00000278", pair: "ETH/USD" },
  NVDAB: {
    feedId: "1005",
    feedIdHex: "0x000003ed",
    pair: "NVDAB/USD",
    settlementUtcHour: NVDAB_SETTLEMENT_UTC_HOUR,
  },
};

function normalizePrivateKey(raw?: string): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  return trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
}

async function main() {
  const signers = await ethers.getSigners();
  const deployer = signers[0];
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const isLocal =
    chainId === 31337 || network.name === "localhost" || network.name === "hardhat";
  const txOverrides = isLocal ? {} : { gasPrice: ethers.parseUnits("1", "gwei") };

  console.log(`Deploying Payoff contracts on ${network.name} (chainId=${chainId})`);

  // 1. MockUSDT (6-decimal testnet collateral with public faucet)
  const MockUSDT = await ethers.getContractFactory("MockUSDT");
  const mockUsdt = await MockUSDT.deploy(deployer.address, txOverrides);
  await mockUsdt.waitForDeployment();
  const usdtAddress = await mockUsdt.getAddress();
  console.log("Deployed MockUSDT (tUSDT):", usdtAddress);

  // 2. AtlasPullSettlementOracle (30m TWAP ECDSA Pull Oracle consumer)
  const atlasSignerAddress =
    process.env.ATLAS_SIGNER_ADDRESS?.trim() || ATLAS_OFFICIAL_SIGNER;
  const Oracle = await ethers.getContractFactory("AtlasPullSettlementOracle");
  const oracle = await Oracle.deploy(deployer.address, atlasSignerAddress, txOverrides);
  await oracle.waitForDeployment();
  const settlementOracleAddress = await oracle.getAddress();
  console.log("Deployed AtlasPullSettlementOracle:", settlementOracleAddress);
  console.log("Configured Atlas Authorized Signer:", atlasSignerAddress);

  const customPauser = process.env.ORACLE_PAUSER_ADDRESS?.trim();
  if (customPauser && customPauser.toLowerCase() !== deployer.address.toLowerCase()) {
    await (await oracle.setPauser(customPauser, txOverrides)).wait();
    console.log("Configured dedicated Oracle Pauser:", customPauser);
  }

  // 3. PayoffSpreadVault (Core)
  const protocolOpenFeeBps = Number(process.env.PROTOCOL_FEE_BPS || 400);
  const protocolCloseFeeBps = Number(process.env.CLOSE_FEE_BPS || 0);

  const PayoffSpreadVault = await ethers.getContractFactory("PayoffSpreadVault");
  const vault = await PayoffSpreadVault.deploy(
    usdtAddress,
    settlementOracleAddress,
    deployer.address,
    protocolOpenFeeBps,
    protocolCloseFeeBps,
    txOverrides
  );
  await vault.waitForDeployment();
  const vaultAddress = await vault.getAddress();
  const deployTx = vault.deploymentTransaction();
  const deployReceipt = deployTx ? await deployTx.wait() : null;
  const deploymentBlock =
    deployReceipt?.blockNumber ?? (await ethers.provider.getBlockNumber());
  console.log(
    `Deployed PayoffSpreadVault (Core): ${vaultAddress} (block ${deploymentBlock})`
  );

  // 4. PayoffVaultLens (Read-Only Periphery)
  const Lens = await ethers.getContractFactory("PayoffVaultLens");
  const lens = await Lens.deploy(txOverrides);
  await lens.waitForDeployment();
  const lensAddress = await lens.getAddress();
  console.log("Deployed PayoffVaultLens (Periphery):", lensAddress);

  // 4b. Auto-register NVDAB RWA asset (US Close 21:00 UTC EST, Atlas feed #1005 / 0x000003ed)
  await (
    await oracle.setAssetFeedId(ASSET_NVDAB, ATLAS_FEEDS.NVDAB.feedIdHex, txOverrides)
  ).wait();
  await (
    await vault.setAssetConfig(
      ASSET_NVDAB,
      true,
      true,
      NVDAB_SETTLEMENT_UTC_HOUR * 3600,
      86400,
      txOverrides
    )
  ).wait();
  console.log(
    `Registered NVDAB RWA asset: feedId=${ATLAS_FEEDS.NVDAB.feedIdHex} (#${ATLAS_FEEDS.NVDAB.feedId}), settlementUtc=${String(NVDAB_SETTLEMENT_UTC_HOUR).padStart(2, "0")}:00 UTC, cadence=86400s`
  );

  // 5. Whitelist & pre-fund market maker margin (exact finite approval, zero standing MaxUint256)
  const targetMargin = ethers.parseUnits(
    process.env.INITIAL_MAKER_MARGIN_USDT || "1000000",
    6
  );

  if (isLocal) {
    const mmSigners = [signers[1], signers[2], signers[3]].filter(Boolean);
    for (const mm of mmSigners) {
      await (await vault.setWhitelistedMaker(mm.address, true)).wait();
      await (await mockUsdt.mint(mm.address, targetMargin)).wait();
      await (await mockUsdt.connect(mm).approve(vaultAddress, targetMargin)).wait();
      await (await vault.connect(mm).depositMakerMargin(targetMargin)).wait();
      console.log(
        `Whitelisted & deposited ${ethers.formatUnits(targetMargin, 6)} tUSDT makerMargin (local MM)`
      );
    }

    if (signers[4]) {
      await (
        await mockUsdt.mint(signers[4].address, ethers.parseUnits("10000", 6))
      ).wait();
      console.log("Funded local demo taker (Account #4) with 10,000 tUSDT");
    }
  } else {
    const envKeys = [
      normalizePrivateKey(process.env.MM1_PRIVATE_KEY),
      normalizePrivateKey(process.env.MM2_PRIVATE_KEY),
      normalizePrivateKey(process.env.MM3_PRIVATE_KEY),
    ].filter((pk): pk is string => Boolean(pk));

    const envAddrs = (process.env.MM_ADDRESSES || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const mmWallets = envKeys.map((pk) => new ethers.Wallet(pk, ethers.provider));

    // Fall back to second configured Hardhat signer if present, else deployer
    const fundingWallets =
      mmWallets.length > 0
        ? mmWallets
        : signers.length > 1
          ? [signers[1]]
          : [deployer];

    const uniqueMakers = Array.from(
      new Set([...fundingWallets.map((w) => w.address), ...envAddrs])
    );

    for (const makerAddr of uniqueMakers) {
      await (await vault.setWhitelistedMaker(makerAddr, true, txOverrides)).wait();
    }
    console.log(`Whitelisted ${uniqueMakers.length} market maker(s) on ${network.name}`);

    for (const mmWallet of fundingWallets) {
      const bal: bigint = await mockUsdt.balanceOf(mmWallet.address);
      if (bal < targetMargin) {
        const deficit = targetMargin - bal;
        await (await mockUsdt.mint(mmWallet.address, deficit, txOverrides)).wait();
      }
      // Exact finite approval only for initial depositMakerMargin (never MaxUint256)
      await (
        await mockUsdt.connect(mmWallet).approve(vaultAddress, targetMargin, txOverrides)
      ).wait();
      await (
        await vault.connect(mmWallet).depositMakerMargin(targetMargin, txOverrides)
      ).wait();
      console.log(
        `Deposited ${ethers.formatUnits(targetMargin, 6)} tUSDT into makerMargin`
      );
    }
  }

  // Write clean public deployment manifest (contract addresses & chain metadata ONLY — no personal EOAs)
  const deploymentsDir = path.resolve(__dirname, "../deployments");
  fs.mkdirSync(deploymentsDir, { recursive: true });
  const fileName = isLocal ? "localhost.json" : `${network.name}.json`;
  const deploymentInfo = {
    network: network.name,
    chainId,
    usdtAddress,
    vaultAddress,
    lensAddress,
    settlementOracleAddress,
    atlasSignerAddress,
    atlasFeeds: ATLAS_FEEDS,
    twapConfig: {
      sampleCount: 30,
      sampleIntervalSec: 60,
      settlementDelaySec: 60,
      exactMatchGracePeriodSec: 900,
      fallbackTimestampToleranceSec: 10,
    },
    deploymentBlock,
    protocolOpenFeeBps,
    protocolCloseFeeBps,
    deployedAt: new Date().toISOString(),
  };

  fs.writeFileSync(
    path.join(deploymentsDir, fileName),
    `${JSON.stringify(deploymentInfo, null, 2)}\n`
  );
  console.log(`Saved deployment manifest to deployments/${fileName}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

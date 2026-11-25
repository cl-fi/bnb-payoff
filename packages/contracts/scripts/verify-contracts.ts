import hre, { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const SOURCIFY_V2_API = "https://sourcify.dev/server/v2";
const USER_AGENT = "bnb-payoff-verifier/1.0 (https://github.com/cl-fi/bnb-payoff)";

async function verifyOnSourcifyV2(
  chainId: number,
  label: string,
  address: string,
  contractIdentifier: string
): Promise<boolean> {
  // 1. Check existing verification status on Sourcify v2
  const checkRes = await fetch(`${SOURCIFY_V2_API}/contract/${chainId}/${address}`, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (checkRes.ok) {
    const existing = (await checkRes.json()) as { match?: string | null };
    if (existing.match === "exact_match" || existing.match === "match") {
      console.log(
        `  ✓ ${label} already verified on Sourcify v2 (${existing.match}): https://repo.sourcify.dev/${chainId}/${address}`
      );
      return true;
    }
  }

  // 2. Load Hardhat Standard JSON input & exact solcLongVersion
  const buildInfo = await hre.artifacts.getBuildInfo(contractIdentifier);
  if (!buildInfo) {
    throw new Error(`Build info not found for ${contractIdentifier} (run compile first)`);
  }

  const submitRes = await fetch(`${SOURCIFY_V2_API}/verify/${chainId}/${address}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({
      stdJsonInput: buildInfo.input,
      compilerVersion: buildInfo.solcLongVersion,
      contractIdentifier,
    }),
  });

  const submitBody = (await submitRes.json()) as {
    verificationId?: string;
    customCode?: string;
    message?: string;
    detail?: string;
  };

  if (submitRes.status === 409 && submitBody.customCode === "already_verified") {
    console.log(
      `  ✓ ${label} already verified on Sourcify v2: https://repo.sourcify.dev/${chainId}/${address}`
    );
    return true;
  }

  if (!submitRes.ok || !submitBody.verificationId) {
    throw new Error(
      `HTTP ${submitRes.status}: ${submitBody.message || submitBody.detail || JSON.stringify(submitBody)}`
    );
  }

  // 3. Poll Sourcify v2 async verification job
  const jobId = submitBody.verificationId;
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const jobRes = await fetch(`${SOURCIFY_V2_API}/verify/${jobId}`, {
      headers: { "User-Agent": USER_AGENT },
    });
    if (!jobRes.ok) continue;
    const job = (await jobRes.json()) as {
      isJobCompleted?: boolean;
      error?: { message?: string; customCode?: string };
      contract?: { match?: string | null; runtimeMatch?: string | null };
    };
    if (!job.isJobCompleted) continue;
    if (job.error) {
      throw new Error(job.error.message || job.error.customCode || "Sourcify job error");
    }
    const matchKind = job.contract?.match || job.contract?.runtimeMatch || "verified";
    console.log(
      `  ✓ Verified ${label} on Sourcify v2 (${matchKind}): https://repo.sourcify.dev/${chainId}/${address}`
    );
    return true;
  }

  throw new Error(`Timed out waiting for Sourcify v2 verification job ${jobId}`);
}

async function verifyContract(
  chainId: number,
  label: string,
  address: string,
  contractIdentifier: string,
  constructorArguments: unknown[]
) {
  console.log(`\nVerifying ${label} at ${address}...`);

  // 1. Always run decentralized Sourcify API v2 verification (requires no API key)
  try {
    await verifyOnSourcifyV2(chainId, label, address, contractIdentifier);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ✗ Sourcify v2 verification failed for ${label}: ${msg}`);
  }

  // 2. Run BscScan/Etherscan verification when BSCSCAN_API_KEY is configured
  if (process.env.BSCSCAN_API_KEY?.trim()) {
    try {
      await hre.run("verify:etherscan", {
        address,
        contract: contractIdentifier,
        constructorArgsParams: constructorArguments.map((arg) => String(arg)),
      });
      console.log(`  ✓ Verified ${label} on BscScan`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes("already verified")) {
        console.log(`  ℹ ${label} is already verified on BscScan`);
      } else {
        console.error(`  ✗ BscScan verification failed for ${label}: ${msg}`);
      }
    }
  } else {
    console.log(`  ℹ Skipping BscScan verification for ${label} (BSCSCAN_API_KEY not set)`);
  }
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const manifestPath = path.resolve(
    __dirname,
    "../deployments",
    `${network.name}.json`
  );
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Deployment manifest not found: ${manifestPath}`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    usdtAddress: string;
    settlementOracleAddress: string;
    vaultAddress: string;
    lensAddress: string;
    atlasSignerAddress: string;
    protocolOpenFeeBps: number;
    protocolCloseFeeBps: number;
  };

  await verifyContract(
    chainId,
    "MockUSDT",
    manifest.usdtAddress,
    "contracts/MockUSDT.sol:MockUSDT",
    [deployer.address]
  );
  await verifyContract(
    chainId,
    "AtlasPullSettlementOracle",
    manifest.settlementOracleAddress,
    "contracts/AtlasPullSettlementOracle.sol:AtlasPullSettlementOracle",
    [deployer.address, manifest.atlasSignerAddress]
  );
  await verifyContract(
    chainId,
    "PayoffSpreadVault",
    manifest.vaultAddress,
    "contracts/PayoffSpreadVault.sol:PayoffSpreadVault",
    [
      manifest.usdtAddress,
      manifest.settlementOracleAddress,
      deployer.address,
      manifest.protocolOpenFeeBps,
      manifest.protocolCloseFeeBps,
    ]
  );
  await verifyContract(
    chainId,
    "PayoffVaultLens",
    manifest.lensAddress,
    "contracts/PayoffVaultLens.sol:PayoffVaultLens",
    []
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

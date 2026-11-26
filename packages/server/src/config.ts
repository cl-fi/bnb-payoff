import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { privateKeyToAccount } from "viem/accounts";
import {
  ASSET_SPECS,
  ATLAS_FEEDS,
  ATLAS_OFFICIAL_SIGNER,
  BSC_TESTNET,
  DEFAULT_CLOSE_FEE_BPS,
  DEFAULT_OPEN_FEE_BPS,
  LOCAL_HARDHAT,
  MAX_CLOSE_FEE_BPS,
  MAX_OPEN_FEE_BPS,
  type VenueName,
} from "@payoff/shared";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "../../../");
const localEnvPath = path.resolve(__dirname, "../../../.env");
if (fs.existsSync(localEnvPath)) {
  dotenv.config({ path: localEnvPath });
}

function normalizePk(pk?: string): `0x${string}` | undefined {
  if (!pk) return undefined;
  const trimmed = pk.trim();
  if (!trimmed) return undefined;
  return (trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`) as `0x${string}`;
}

export interface MakerConfig {
  id: string;
  name: string;
  privateKey: `0x${string}`;
  address: `0x${string}`;
  preferredVenue: VenueName;
  /** Spread/margin bps over fair spread value */
  openMarkupBps: number;
  /** Competitiveness skew in bps for reverse-RFQ close auctions */
  closeCompetitivenessBps: number;
}

export interface ServerConfig {
  port: number;
  host: string;
  corsOrigin?: string;
  chainId: number;
  rpcUrl: string;
  usdtAddress: `0x${string}`;
  vaultAddress: `0x${string}`;
  lensAddress: `0x${string}`;
  settlementOracleAddress: `0x${string}`;
  atlasSignerAddress: `0x${string}`;
  atlasApiKey?: string;
  atlasBtcFeedId: string;
  atlasEthFeedId: string;
  atlasNvdabFeedId: string;
  nvdabSettlementUtcHour: number;
  thetaDataApiKey?: string;
  thetaDataPythonBin?: string;
  privyAppId?: string;
  privyAppSecret?: string;
  welcomeAirdropUsdt: number;
  enableRwaFeeds: boolean;
  nvdabBlackoutDates: string[];
  enableLiveAtlas: boolean;
  enableBinanceKlines: boolean;
  deploymentBlock: number;
  feeRecipient: `0x${string}`;
  oraclePrivateKey: `0x${string}`;
  oracleAddress: `0x${string}`;
  pauserPrivateKey: `0x${string}`;
  pauserAddress: `0x${string}`;
  protocolFeeBps: number;
  closeFeeBps: number;
  databaseUrl?: string;
  dbEngine: "postgres" | "sqlite";
  dbPath: string;
  pollIntervalMs: number;
  makers: MakerConfig[];
  demoTakerPrivateKey?: `0x${string}`;
  demoTakerAddress?: `0x${string}`;
  isLocalDev: boolean;
}

interface DeploymentManifest {
  usdtAddress?: string;
  vaultAddress?: string;
  lensAddress?: string;
  settlementOracleAddress?: string;
  atlasSignerAddress?: string;
  deploymentBlock?: number;
  protocolOpenFeeBps?: number;
  protocolCloseFeeBps?: number;
  atlasFeeds?: {
    NVDAB?: {
      feedId?: string;
      settlementUtcHour?: number;
    };
  };
}

function loadDeploymentManifest(chainId: number): DeploymentManifest {
  const fileName =
    chainId === BSC_TESTNET.chainId ? "bscTestnet.json" : "localhost.json";
  const manifestPath = path.join(
    ROOT_DIR,
    "packages/contracts/deployments",
    fileName
  );
  if (fs.existsSync(manifestPath)) {
    try {
      return JSON.parse(fs.readFileSync(manifestPath, "utf8")) as DeploymentManifest;
    } catch {
      return {};
    }
  }
  return {};
}

// Default Hardhat deterministic accounts #0..#4 (local devnet only)
const HH_ACC0_PK =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const HH_ACC1_PK =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const HH_ACC2_PK =
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as const;
const HH_ACC3_PK =
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6" as const;
const HH_ACC4_PK =
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a" as const;

const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as const;

export function loadConfig(chainIdOverride?: number): ServerConfig {
  const chainId =
    chainIdOverride ?? Number(process.env.CHAIN_ID || BSC_TESTNET.chainId);
  const isLocalDev = chainId === LOCAL_HARDHAT.chainId;
  const manifest = loadDeploymentManifest(chainId);

  const envRpcUrl = process.env.RPC_URL?.trim();
  const useEnvRpc =
    Boolean(envRpcUrl) &&
    (!isLocalDev || Number(process.env.CHAIN_ID) === LOCAL_HARDHAT.chainId);
  const rpcUrl = useEnvRpc
    ? (envRpcUrl as string)
    : isLocalDev
      ? LOCAL_HARDHAT.rpcUrl
      : BSC_TESTNET.rpcUrl;

  const usdtAddress = (process.env.USDT_ADDRESS?.trim() ||
    manifest.usdtAddress ||
    ZERO_ADDR) as `0x${string}`;

  const vaultAddress = (process.env.VAULT_ADDRESS?.trim() ||
    manifest.vaultAddress ||
    ZERO_ADDR) as `0x${string}`;

  const lensAddress = (process.env.LENS_ADDRESS?.trim() ||
    manifest.lensAddress ||
    ZERO_ADDR) as `0x${string}`;

  const settlementOracleAddress = (process.env.SETTLEMENT_ORACLE_ADDRESS?.trim() ||
    manifest.settlementOracleAddress ||
    ZERO_ADDR) as `0x${string}`;

  const atlasSignerAddress = (process.env.ATLAS_SIGNER_ADDRESS?.trim() ||
    manifest.atlasSignerAddress ||
    ATLAS_OFFICIAL_SIGNER) as `0x${string}`;

  const testnetWalletPk = normalizePk(process.env.TESTNET_WALLET_PK);
  const oraclePrivateKey = (normalizePk(process.env.ORACLE_PRIVATE_KEY) ||
    (!isLocalDev ? testnetWalletPk : undefined) ||
    HH_ACC0_PK) as `0x${string}`;
  const oracleAccount = privateKeyToAccount(oraclePrivateKey);

  const pauserPrivateKey = (normalizePk(process.env.PAUSER_PRIVATE_KEY) ||
    oraclePrivateKey) as `0x${string}`;
  const pauserAccount = privateKeyToAccount(pauserPrivateKey);

  const feeRecipient = (process.env.FEE_RECIPIENT_ADDRESS?.trim() ||
    oracleAccount.address) as `0x${string}`;

  let makers: MakerConfig[];
  if (isLocalDev) {
    const mm1Pk = (normalizePk(process.env.MM1_PRIVATE_KEY) ||
      HH_ACC1_PK) as `0x${string}`;
    const mm2Pk = (normalizePk(process.env.MM2_PRIVATE_KEY) ||
      HH_ACC2_PK) as `0x${string}`;
    const mm3Pk = (normalizePk(process.env.MM3_PRIVATE_KEY) ||
      HH_ACC3_PK) as `0x${string}`;
    makers = [
      {
        id: "mm1",
        name: "Payoff Reference Desk",
        privateKey: mm1Pk,
        address: privateKeyToAccount(mm1Pk).address,
        preferredVenue: "MOCK_MAKER",
        openMarkupBps: 110,
        closeCompetitivenessBps: 90,
      },
      {
        id: "mm2",
        name: "BNB Liquidity Desk",
        privateKey: mm2Pk,
        address: privateKeyToAccount(mm2Pk).address,
        preferredVenue: "MOCK_MAKER",
        openMarkupBps: 120,
        closeCompetitivenessBps: 85,
      },
      {
        id: "mm3",
        name: "External Arb Desk",
        privateKey: mm3Pk,
        address: privateKeyToAccount(mm3Pk).address,
        preferredVenue: "MOCK_MAKER",
        openMarkupBps: 145,
        closeCompetitivenessBps: 115,
      },
    ];
  } else {
    const pk1 =
      normalizePk(process.env.MM1_PRIVATE_KEY) || testnetWalletPk || HH_ACC1_PK;
    const pk2 = normalizePk(process.env.MM2_PRIVATE_KEY);
    const pk3 = normalizePk(process.env.MM3_PRIVATE_KEY);
    makers = [
      {
        id: "mm1",
        name: "Payoff Reference Desk",
        privateKey: pk1,
        address: privateKeyToAccount(pk1).address,
        preferredVenue: "MOCK_MAKER",
        openMarkupBps: 110,
        closeCompetitivenessBps: 90,
      },
    ];
    if (pk2) {
      makers.push({
        id: "mm2",
        name: "BNB Liquidity Desk",
        privateKey: pk2,
        address: privateKeyToAccount(pk2).address,
        preferredVenue: "MOCK_MAKER",
        openMarkupBps: 120,
        closeCompetitivenessBps: 85,
      });
    }
    if (pk3) {
      makers.push({
        id: "mm3",
        name: "External Arb Desk",
        privateKey: pk3,
        address: privateKeyToAccount(pk3).address,
        preferredVenue: "MOCK_MAKER",
        openMarkupBps: 145,
        closeCompetitivenessBps: 115,
      });
    }
  }

  const databaseUrl = process.env.DATABASE_URL?.trim() || undefined;
  const dbEngine: "postgres" | "sqlite" = databaseUrl ? "postgres" : "sqlite";
  const dbPath = path.isAbsolute(process.env.DB_PATH || "")
    ? (process.env.DB_PATH as string)
    : path.resolve(ROOT_DIR, process.env.DB_PATH || "data/payoff.sqlite");

  const demoTakerPrivateKey = isLocalDev ? HH_ACC4_PK : undefined;
  const demoTakerAddress = demoTakerPrivateKey
    ? privateKeyToAccount(demoTakerPrivateKey).address
    : undefined;

  const atlasApiKey = process.env.ATLAS_API_KEY?.trim() || undefined;
  const atlasBtcFeedId =
    process.env.ATLAS_BTC_FEED_ID?.trim() || ATLAS_FEEDS.BTC.feedId;
  const atlasEthFeedId =
    process.env.ATLAS_ETH_FEED_ID?.trim() || ATLAS_FEEDS.ETH.feedId;
  const atlasNvdabFeedId =
    process.env.ATLAS_NVDAB_FEED_ID?.trim() ||
    manifest.atlasFeeds?.NVDAB?.feedId ||
    ATLAS_FEEDS.NVDAB.feedId;

  const rawNvdabSettlementHour =
    process.env.NVDAB_SETTLEMENT_UTC_HOUR ??
    manifest.atlasFeeds?.NVDAB?.settlementUtcHour ??
    ASSET_SPECS.NVDAB.settlementUtcHour;
  const parsedNvdabHour = Number(rawNvdabSettlementHour);
  const nvdabSettlementUtcHour =
    Number.isInteger(parsedNvdabHour) &&
    parsedNvdabHour >= 0 &&
    parsedNvdabHour <= 23
      ? parsedNvdabHour
      : ASSET_SPECS.NVDAB.settlementUtcHour;

  const thetaDataApiKey = process.env.THETADATA_API_KEY?.trim() || undefined;
  const thetaDataPythonBin =
    process.env.THETADATA_PYTHON_BIN?.trim() || undefined;
  const privyAppId = process.env.PRIVY_APP_ID?.trim() || undefined;
  const privyAppSecret = process.env.PRIVY_APP_SECRET?.trim() || undefined;
  const rawWelcomeAirdrop = Number(process.env.WELCOME_AIRDROP_USDT ?? 1000);
  const welcomeAirdropUsdt =
    Number.isFinite(rawWelcomeAirdrop) && rawWelcomeAirdrop >= 0
      ? Math.min(100_000, rawWelcomeAirdrop)
      : 1000;
  const enableRwaFeeds = process.env.ENABLE_RWA_FEEDS !== "false";
  const nvdabBlackoutDates = (process.env.NVDAB_BLACKOUT_DATES || "")
    .split(",")
    .map((d) => d.trim())
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));

  return {
    port: Number(process.env.PORT || 4000),
    host: process.env.HOST || "127.0.0.1",
    corsOrigin: process.env.CORS_ORIGIN?.trim() || undefined,
    chainId,
    rpcUrl,
    usdtAddress,
    vaultAddress,
    lensAddress,
    settlementOracleAddress,
    atlasSignerAddress,
    atlasApiKey,
    atlasBtcFeedId,
    atlasEthFeedId,
    atlasNvdabFeedId,
    nvdabSettlementUtcHour,
    thetaDataApiKey,
    thetaDataPythonBin,
    privyAppId,
    privyAppSecret,
    welcomeAirdropUsdt,
    enableRwaFeeds,
    nvdabBlackoutDates,
    enableLiveAtlas: process.env.ENABLE_LIVE_ATLAS !== "false",
    enableBinanceKlines: process.env.ENABLE_BINANCE_KLINES !== "false",
    deploymentBlock: Number(
      process.env.DEPLOYMENT_BLOCK || manifest.deploymentBlock || 0
    ),
    feeRecipient,
    oraclePrivateKey,
    oracleAddress: oracleAccount.address,
    pauserPrivateKey,
    pauserAddress: pauserAccount.address,
    protocolFeeBps: Math.min(
      MAX_OPEN_FEE_BPS,
      Number(
        process.env.PROTOCOL_FEE_BPS ??
          manifest.protocolOpenFeeBps ??
          DEFAULT_OPEN_FEE_BPS
      )
    ),
    closeFeeBps: Math.min(
      MAX_CLOSE_FEE_BPS,
      Number(
        process.env.CLOSE_FEE_BPS ??
          manifest.protocolCloseFeeBps ??
          DEFAULT_CLOSE_FEE_BPS
      )
    ),
    databaseUrl,
    dbEngine,
    dbPath,
    pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 5000),
    makers,
    demoTakerPrivateKey,
    demoTakerAddress,
    isLocalDev,
  };
}

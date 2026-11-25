import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

const localEnv = path.resolve(__dirname, "../../.env");
if (fs.existsSync(localEnv)) {
  dotenv.config({ path: localEnv });
}

function normalizePrivateKey(raw?: string): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  return trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
}

const bscAccounts = Array.from(
  new Set(
    [
      normalizePrivateKey(process.env.TESTNET_WALLET_PK || process.env.DEPLOYER_PRIVATE_KEY),
      normalizePrivateKey(process.env.MM1_PRIVATE_KEY),
    ].filter((key): key is string => Boolean(key))
  )
);

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.28",
    settings: {
      evmVersion: "paris",
      optimizer: {
        enabled: true,
        runs: 200,
      },
      viaIR: true,
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
    },
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
    },
    bscTestnet: {
      url: process.env.RPC_URL || "https://data-seed-prebsc-1-s1.bnbchain.org:8545",
      chainId: 97,
      gasPrice: 1_000_000_000,
      accounts: bscAccounts,
    },
  },
  etherscan: {
    enabled: Boolean(process.env.BSCSCAN_API_KEY?.trim()),
    apiKey: {
      bscTestnet: process.env.BSCSCAN_API_KEY?.trim() || "",
    },
  },
  sourcify: {
    enabled: true,
  },
};

export default config;

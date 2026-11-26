import { getWagmiConnectorV2 } from "@binance/w3w-wagmi-connector-v2";
import { BSC_TESTNET, LOCAL_HARDHAT } from "@payoff/shared";
import { defineChain, fallback, http, type Chain } from "viem";
import { bscTestnet as viemBscTestnet } from "viem/chains";
import {
  createConfig,
  type Connector,
  type CreateConnectorFn,
} from "wagmi";
import { injected, walletConnect } from "wagmi/connectors";

export const BSC_TESTNET_PRIMARY_RPC = BSC_TESTNET.rpcUrl;
export const BSC_TESTNET_FALLBACK_RPC = "https://bsc-testnet-rpc.publicnode.com";
export const BSC_TESTNET_TERTIARY_RPC =
  "https://data-seed-prebsc-2-s1.bnbchain.org:8545";

export const bscTestnetChain: Chain = {
  ...viemBscTestnet,
  name: BSC_TESTNET.name,
  nativeCurrency: {
    name: BSC_TESTNET.nativeSymbol,
    symbol: BSC_TESTNET.nativeSymbol,
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: [
        BSC_TESTNET_PRIMARY_RPC,
        BSC_TESTNET_FALLBACK_RPC,
        BSC_TESTNET_TERTIARY_RPC,
      ],
    },
  },
  blockExplorers: {
    default: {
      name: "BscScan Testnet",
      url: BSC_TESTNET.explorerUrl || "https://testnet.bscscan.com",
    },
  },
  testnet: true,
};

export const localHardhatChain: Chain = defineChain({
  id: LOCAL_HARDHAT.chainId,
  name: LOCAL_HARDHAT.name,
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [LOCAL_HARDHAT.rpcUrl] },
  },
  testnet: true,
});

export function getBscTestnetRpcUrls(preferredRpcUrl?: string): string[] {
  const candidates = [
    preferredRpcUrl?.trim(),
    BSC_TESTNET_PRIMARY_RPC,
    BSC_TESTNET_FALLBACK_RPC,
    BSC_TESTNET_TERTIARY_RPC,
  ].filter((url): url is string => Boolean(url));

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const url of candidates) {
    const key = url.replace(/\/+$/, "").toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(url);
    }
  }
  return unique;
}

export function isBinanceWalletExtensionDetected(): boolean {
  if (typeof window === "undefined") return false;
  const win = window as any;
  return Boolean(
    win.binancew3w?.isExtension ||
      win.binancew3w?.ethereum ||
      win.ethereum?.isBinance ||
      win.ethereum?.isBinanceWallet ||
      win.BinanceChain
  );
}

/** Official Binance diamond mark as an inline SVG data URI for connector icons */
export const BINANCE_WALLET_ICON =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="10" fill="#181A20"/><path d="M20 9.5l3.6 3.6-8.4 8.4-3.6-3.6L20 9.5zm0 7.2l3.6 3.6-3.6 3.6-3.6-3.6 3.6-3.6zm8.4 1.2l3.6 3.6-12 12-3.6-3.6 12-12zm-16.8 0l3.6 3.6-3.6 3.6-3.6-3.6 3.6-3.6z" fill="#F0B90B"/></svg>'
  );

export const WALLETCONNECT_ICON =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="10" fill="#3B99FC"/><path d="M13.2 16.5c3.75-3.67 9.85-3.67 13.6 0l.45.44a.46.46 0 0 1 0 .66l-1.55 1.52a.24.24 0 0 1-.34 0l-.62-.61c-2.62-2.56-6.86-2.56-9.48 0l-.67.65a.24.24 0 0 1-.34 0L12.7 17.64a.46.46 0 0 1 0-.66l.5-.48zm16.8 3.13l1.38 1.35a.46.46 0 0 1 0 .66l-6.23 6.1a.48.48 0 0 1-.67 0l-4.42-4.33a.12.12 0 0 0-.17 0l-4.42 4.33a.48.48 0 0 1-.67 0l-6.23-6.1a.46.46 0 0 1 0-.66l1.38-1.35a.48.48 0 0 1 .67 0l4.42 4.33a.12.12 0 0 0 .17 0l4.42-4.33a.48.48 0 0 1 .67 0l4.42 4.33a.12.12 0 0 0 .17 0l4.42-4.33a.48.48 0 0 1 .67 0z" fill="#FFFFFF"/></svg>'
  );

function buildBinanceConnector(): CreateConnectorFn {
  const factory = getWagmiConnectorV2();
  if ("type" in factory && factory.type === "binanceWallet") {
    return factory({
      chainId: bscTestnetChain.id,
      lng: "en",
      showQrCodeModal: true,
      rpc: {
        [bscTestnetChain.id]: BSC_TESTNET_PRIMARY_RPC,
      },
    }) as unknown as CreateConnectorFn;
  }
  return (factory as () => CreateConnectorFn)();
}

function buildConnectors(): CreateConnectorFn[] {
  const list: CreateConnectorFn[] = [
    buildBinanceConnector(),
    injected({ shimDisconnect: true }),
  ];

  const wcProjectId = (
    (import.meta as any).env?.VITE_WALLETCONNECT_PROJECT_ID || ""
  ).trim();
  if (wcProjectId) {
    list.push(
      walletConnect({
        projectId: wcProjectId,
        showQrModal: true,
        metadata: {
          name: "Payoff · BNB Chain",
          description:
            "A prediction market built for prices, not events · BNB Smart Chain",
          url:
            typeof window !== "undefined"
              ? window.location.origin
              : "https://bnb.payoff.finance",
          icons: ["https://bnb.payoff.finance/icon.svg"],
        },
      })
    );
  }

  return list;
}

export const wagmiConfig = createConfig({
  chains: [bscTestnetChain, localHardhatChain],
  connectors: buildConnectors(),
  multiInjectedProviderDiscovery: true,
  transports: {
    [bscTestnetChain.id]: fallback(
      [
        http(BSC_TESTNET_PRIMARY_RPC),
        http(BSC_TESTNET_FALLBACK_RPC),
        http(BSC_TESTNET_TERTIARY_RPC),
      ],
      { rank: false }
    ),
    [localHardhatChain.id]: http(LOCAL_HARDHAT.rpcUrl),
  },
});

export interface WalletConnectorOption {
  uid: string;
  id: string;
  name: string;
  icon: string;
  isBinanceOfficial: boolean;
  isBnbFeatured: boolean;
  isWalletConnect: boolean;
  isQrFallback: boolean;
  priority: number;
  connector: Connector;
}

function classifyConnector(connector: Connector): {
  priority: number;
  isBinanceOfficial: boolean;
  isBnbFeatured: boolean;
  isWalletConnect: boolean;
  isQrFallback: boolean;
} {
  const hay = `${connector.id} ${connector.name} ${connector.type}`.toLowerCase();
  if (
    connector.id === "wallet.binance.com" ||
    connector.type === "binanceWallet" ||
    hay.includes("binance")
  ) {
    return {
      priority: 1,
      isBinanceOfficial: true,
      isBnbFeatured: true,
      isWalletConnect: false,
      isQrFallback:
        connector.type === "binanceWallet" &&
        !isBinanceWalletExtensionDetected(),
    };
  }
  if (hay.includes("trust")) {
    return {
      priority: 2,
      isBinanceOfficial: false,
      isBnbFeatured: true,
      isWalletConnect: false,
      isQrFallback: false,
    };
  }
  if (hay.includes("metamask")) {
    return {
      priority: 3,
      isBinanceOfficial: false,
      isBnbFeatured: true,
      isWalletConnect: false,
      isQrFallback: false,
    };
  }
  if (hay.includes("rabby")) {
    return {
      priority: 4,
      isBinanceOfficial: false,
      isBnbFeatured: false,
      isWalletConnect: false,
      isQrFallback: false,
    };
  }
  if (hay.includes("coinbase")) {
    return {
      priority: 5,
      isBinanceOfficial: false,
      isBnbFeatured: false,
      isWalletConnect: false,
      isQrFallback: false,
    };
  }
  if (connector.id === "walletConnect" || hay.includes("walletconnect")) {
    return {
      priority: 8,
      isBinanceOfficial: false,
      isBnbFeatured: false,
      isWalletConnect: true,
      isQrFallback: true,
    };
  }
  return {
    priority: 10,
    isBinanceOfficial: false,
    isBnbFeatured: false,
    isWalletConnect: false,
    isQrFallback: false,
  };
}

/**
 * Deduplicates and prioritizes Wagmi v2 connectors (Official Binance Wallet SDK,
 * EIP-6963 browser extensions, legacy injected fallback, and optional WalletConnect).
 */
export function getOrderedWalletConnectors(
  connectors: readonly Connector[]
): WalletConnectorOption[] {
  const hasSpecificInjected = connectors.some(
    (c) =>
      c.type === "injected" &&
      c.id !== "injected" &&
      c.id !== "wallet.binance.com"
  );
  const hasLegacyWindowEthereum =
    typeof window !== "undefined" && Boolean((window as any).ethereum);

  // If EIP-6963 discovered a Binance Wallet extension alongside the official Binance connector,
  // merge them into a single Binance Wallet entry (preferring the EIP-6963 extension connector/icon).
  const eip6963Binance = connectors.find(
    (c) =>
      c.type === "injected" &&
      c.id !== "injected" &&
      c.id !== "wallet.binance.com" &&
      `${c.id} ${c.name}`.toLowerCase().includes("binance")
  );

  const byKey = new Map<string, WalletConnectorOption>();

  for (const connector of connectors) {
    if (connector.id === "injected") {
      if (hasSpecificInjected || !hasLegacyWindowEthereum) {
        continue;
      }
    }

    const meta = classifyConnector(connector);

    if (meta.isBinanceOfficial) {
      if (eip6963Binance && connector.uid !== eip6963Binance.uid) {
        continue;
      }
      const key = "binance-official";
      if (!byKey.has(key)) {
        byKey.set(key, {
          uid: connector.uid,
          id: connector.id,
          name: "Binance Wallet",
          icon: connector.icon || eip6963Binance?.icon || BINANCE_WALLET_ICON,
          isBinanceOfficial: true,
          isBnbFeatured: true,
          isWalletConnect: false,
          isQrFallback: meta.isQrFallback && !eip6963Binance,
          priority: 1,
          connector,
        });
      }
      continue;
    }

    const dedupeKey = connector.id.toLowerCase();
    if (byKey.has(dedupeKey)) continue;

    byKey.set(dedupeKey, {
      uid: connector.uid,
      id: connector.id,
      name: connector.name,
      icon:
        connector.icon || (meta.isWalletConnect ? WALLETCONNECT_ICON : ""),
      isBinanceOfficial: false,
      isBnbFeatured: meta.isBnbFeatured,
      isWalletConnect: meta.isWalletConnect,
      isQrFallback: meta.isQrFallback,
      priority: meta.priority,
      connector,
    });
  }

  return Array.from(byKey.values()).sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.name.localeCompare(b.name);
  });
}

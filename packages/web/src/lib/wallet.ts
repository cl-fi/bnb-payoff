import {
  createPublicClient,
  defineChain,
  encodeFunctionData,
  http,
  maxUint256,
  parseUnits,
  type Chain,
  type PublicClient,
} from "viem";
import {
  ATLAS_SETTLEMENT_ORACLE_ABI,
  BSC_TESTNET,
  LOCAL_HARDHAT,
  MOCK_USDT_ABI,
  PAYOFF_VAULT_ABI,
  unitsToUsdt,
  type CloseRfqResponse,
  type OpenRfqResponse,
} from "@payoff/shared";

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | object }): Promise<any>;
  on?(event: string, listener: (...args: any[]) => void): void;
  removeListener?(event: string, listener: (...args: any[]) => void): void;
}

export interface DiscoveredWallet {
  id: string;
  name: string;
  icon: string;
  rdns: string;
  isBnbFeatured: boolean;
  priority: number;
  provider: Eip1193Provider;
}

export type WalletTransportKind = "NONE" | "INJECTED";

export interface ConnectedWallet {
  kind: WalletTransportKind;
  walletName?: string;
  walletIcon?: string;
  address?: `0x${string}`;
  /** Target app chain (97 = BNB Smart Chain Testnet) */
  chainId: number;
  /** Wallet's actual currently selected EVM chain ID */
  walletChainId?: number;
  usdtBalance: number;
  provider?: Eip1193Provider;
}

function getWalletPriority(rdns: string, name: string): {
  priority: number;
  isBnbFeatured: boolean;
} {
  const hay = `${rdns} ${name}`.toLowerCase();
  if (hay.includes("binance")) {
    return { priority: 1, isBnbFeatured: true };
  }
  if (hay.includes("metamask")) {
    return { priority: 2, isBnbFeatured: true };
  }
  if (hay.includes("trust")) {
    return { priority: 3, isBnbFeatured: true };
  }
  if (hay.includes("rabby")) {
    return { priority: 4, isBnbFeatured: false };
  }
  if (hay.includes("coinbase")) {
    return { priority: 5, isBnbFeatured: false };
  }
  return { priority: 10, isBnbFeatured: false };
}

/**
 * Discovers installed EVM wallets via standard EIP-6963 multi-wallet discovery,
 * with legacy `window.BinanceChain` / `window.ethereum` fallback.
 * Prioritizes BNB-friendly wallets (Binance Web3 Wallet, MetaMask, Trust Wallet)
 * cleanly without vendor lock-in.
 */
export function subscribeDiscoveredWallets(
  onUpdate: (wallets: DiscoveredWallet[]) => void
): () => void {
  const map = new Map<string, DiscoveredWallet>();

  const emit = () => {
    const list = Array.from(map.values()).sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.name.localeCompare(b.name);
    });
    onUpdate(list);
  };

  const handleAnnounce = (event: Event) => {
    const detail = (event as CustomEvent)?.detail;
    if (!detail?.info || !detail?.provider) return;
    const rdns: string = detail.info.rdns || detail.info.name || "unknown";
    const name: string = detail.info.name || "EVM Wallet";
    const { priority, isBnbFeatured } = getWalletPriority(rdns, name);

    map.set(rdns, {
      id: rdns,
      name,
      icon: detail.info.icon || "",
      rdns,
      isBnbFeatured,
      priority,
      provider: detail.provider as Eip1193Provider,
    });
    emit();
  };

  window.addEventListener("eip6963:announceProvider", handleAnnounce);
  window.dispatchEvent(new Event("eip6963:requestProvider"));

  // Legacy fallback for browsers or extensions that do not announce EIP-6963
  const timer = setTimeout(() => {
    const win = window as any;
    let added = false;

    if (
      win.BinanceChain &&
      !Array.from(map.values()).some((w) =>
        `${w.rdns} ${w.name}`.toLowerCase().includes("binance")
      )
    ) {
      map.set("com.binance.wallet.legacy", {
        id: "com.binance.wallet.legacy",
        name: "Binance Wallet",
        icon: "",
        rdns: "com.binance.wallet",
        isBnbFeatured: true,
        priority: 1,
        provider: win.BinanceChain as Eip1193Provider,
      });
      added = true;
    }

    if (win.ethereum && map.size === 0) {
      const isBinance = Boolean(win.ethereum.isBinance || win.ethereum.isBinanceWallet);
      const isMetaMask = Boolean(win.ethereum.isMetaMask);
      const isTrust = Boolean(win.ethereum.isTrust || win.ethereum.isTrustWallet);
      const isRabby = Boolean(win.ethereum.isRabby);
      const isCoinbase = Boolean(win.ethereum.isCoinbaseWallet);

      const name = isBinance
        ? "Binance Wallet"
        : isRabby
          ? "Rabby Wallet"
          : isTrust
            ? "Trust Wallet"
            : isCoinbase
              ? "Coinbase Wallet"
              : isMetaMask
                ? "MetaMask"
                : "Browser Wallet";

      const rdns = isBinance
        ? "com.binance.wallet"
        : isRabby
          ? "io.rabby"
          : isTrust
            ? "com.trustwallet.app"
            : isCoinbase
              ? "com.coinbase.wallet"
              : isMetaMask
                ? "io.metamask"
                : "injected.legacy";

      const { priority, isBnbFeatured } = getWalletPriority(rdns, name);
      map.set("injected.legacy", {
        id: "injected.legacy",
        name,
        icon: "",
        rdns,
        isBnbFeatured,
        priority,
        provider: win.ethereum as Eip1193Provider,
      });
      added = true;
    }

    if (added) emit();
  }, 150);

  return () => {
    clearTimeout(timer);
    window.removeEventListener("eip6963:announceProvider", handleAnnounce);
  };
}

export function getChainDef(chainId: number, rpcUrl: string): Chain {
  if (chainId === BSC_TESTNET.chainId) {
    return defineChain({
      id: BSC_TESTNET.chainId,
      name: BSC_TESTNET.name,
      nativeCurrency: {
        name: BSC_TESTNET.nativeSymbol,
        symbol: BSC_TESTNET.nativeSymbol,
        decimals: 18,
      },
      rpcUrls: { default: { http: [rpcUrl || BSC_TESTNET.rpcUrl] } },
      blockExplorers: {
        default: {
          name: "BscScan Testnet",
          url: BSC_TESTNET.explorerUrl || "https://testnet.bscscan.com",
        },
      },
      testnet: true,
    });
  }
  return defineChain({
    id: LOCAL_HARDHAT.chainId,
    name: LOCAL_HARDHAT.name,
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl || LOCAL_HARDHAT.rpcUrl] } },
  });
}

export function getExplorerBaseUrl(chainId: number): string | undefined {
  if (chainId === BSC_TESTNET.chainId) {
    return BSC_TESTNET.explorerUrl || "https://testnet.bscscan.com";
  }
  return undefined;
}

export function createClientForRpc(chainId: number, rpcUrl: string): PublicClient {
  return createPublicClient({
    chain: getChainDef(chainId, rpcUrl),
    transport: http(rpcUrl),
  });
}

export async function readUsdtBalance(
  publicClient: PublicClient,
  usdtAddress: `0x${string}` | undefined,
  owner: `0x${string}`
): Promise<number> {
  if (
    !usdtAddress ||
    usdtAddress === "0x0000000000000000000000000000000000000000"
  ) {
    return 0;
  }
  try {
    const raw = await publicClient.readContract({
      address: usdtAddress,
      abi: MOCK_USDT_ABI,
      functionName: "balanceOf",
      args: [owner],
    });
    return unitsToUsdt(raw);
  } catch {
    return 0;
  }
}

export async function ensureTargetChain(
  provider: Eip1193Provider,
  targetChainId: number,
  rpcUrl: string
) {
  const hexChain = `0x${targetChainId.toString(16)}`;
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: hexChain }],
    });
  } catch (err: any) {
    const msg = String(err?.message || "").toLowerCase();
    if (
      err?.code === 4902 ||
      msg.includes("4902") ||
      msg.includes("unrecognized chain") ||
      msg.includes("unknown chain")
    ) {
      const def = getChainDef(targetChainId, rpcUrl);
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: hexChain,
            chainName: def.name,
            nativeCurrency: def.nativeCurrency,
            rpcUrls: [rpcUrl || BSC_TESTNET.rpcUrl],
            blockExplorerUrls: def.blockExplorers?.default?.url
              ? [def.blockExplorers.default.url]
              : undefined,
          },
        ],
      });
    } else {
      throw err;
    }
  }
}

export async function switchConnectedWalletChain(
  wallet: ConnectedWallet,
  targetChainId: number,
  rpcUrl: string
): Promise<number> {
  if (wallet.kind === "INJECTED" && wallet.provider) {
    await ensureTargetChain(wallet.provider, targetChainId, rpcUrl);
    const hex = await wallet.provider.request({ method: "eth_chainId" });
    return parseInt(String(hex), 16);
  }
  return targetChainId;
}

export async function connectInjectedWallet(
  discovered: DiscoveredWallet,
  targetChainId: number,
  rpcUrl: string
): Promise<ConnectedWallet> {
  const accounts = (await discovered.provider.request({
    method: "eth_requestAccounts",
  })) as `0x${string}`[];

  if (!accounts || accounts.length === 0) {
    throw new Error("No wallet account authorized");
  }

  await ensureTargetChain(discovered.provider, targetChainId, rpcUrl).catch(
    () => {}
  );

  let walletChainId = targetChainId;
  try {
    const hex = await discovered.provider.request({ method: "eth_chainId" });
    walletChainId = parseInt(String(hex), 16);
  } catch {
    walletChainId = targetChainId;
  }

  return {
    kind: "INJECTED",
    walletName: discovered.name,
    walletIcon: discovered.icon,
    address: accounts[0],
    chainId: targetChainId,
    walletChainId,
    usdtBalance: 0,
    provider: discovered.provider,
  };
}

export async function disconnectWalletSession(_wallet: ConnectedWallet) {
  // EIP-1193 injected sessions are cleared client-side on disconnect
}

async function sendEvmTx(params: {
  wallet: ConnectedWallet;
  to: `0x${string}`;
  data: `0x${string}`;
}): Promise<`0x${string}`> {
  const { wallet, to, data } = params;
  if (!wallet.address || wallet.kind !== "INJECTED" || !wallet.provider) {
    throw new Error("Please connect a wallet first");
  }

  const txHash = (await wallet.provider.request({
    method: "eth_sendTransaction",
    params: [{ from: wallet.address, to, data, value: "0x0" }],
  })) as `0x${string}`;
  return txHash;
}

export async function waitForConfirmedReceipt(
  publicClient: PublicClient,
  hash: `0x${string}`
) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status === "reverted") {
    throw new Error(`On-chain transaction reverted: ${hash}`);
  }
  return receipt;
}

async function ensureWalletOnTargetChain(
  wallet: ConnectedWallet,
  rpcUrl: string
): Promise<void> {
  if (wallet.walletChainId && wallet.walletChainId !== wallet.chainId) {
    await switchConnectedWalletChain(wallet, wallet.chainId, rpcUrl);
  }
}

export async function ensureUsdtApproval(params: {
  wallet: ConnectedWallet;
  rpcUrl: string;
  usdtAddress: `0x${string}`;
  spender: `0x${string}`;
  amountUsdt: number;
  amountUnits?: bigint;
  onApproving?: () => void;
  publicClient?: PublicClient;
}): Promise<{ approvedNow: boolean; approveHash?: `0x${string}` }> {
  const { wallet, rpcUrl, usdtAddress, spender, amountUsdt, onApproving } =
    params;
  if (!wallet.address) throw new Error("Please connect a wallet first");
  await ensureWalletOnTargetChain(wallet, rpcUrl);
  const publicClient =
    params.publicClient ?? createClientForRpc(wallet.chainId, rpcUrl);

  const requiredUnits =
    params.amountUnits ?? parseUnits(Math.max(0, amountUsdt).toFixed(6), 6);

  const allowance = await publicClient.readContract({
    address: usdtAddress,
    abi: MOCK_USDT_ABI,
    functionName: "allowance",
    args: [wallet.address, spender],
  });

  if (allowance >= requiredUnits) {
    return { approvedNow: false };
  }

  onApproving?.();
  const approveData = encodeFunctionData({
    abi: MOCK_USDT_ABI,
    functionName: "approve",
    args: [spender, maxUint256],
  });
  const approveHash = await sendEvmTx({
    wallet,
    to: usdtAddress,
    data: approveData,
  });
  await waitForConfirmedReceipt(publicClient, approveHash);
  return { approvedNow: true, approveHash };
}

export async function executeOpenTicketTx(params: {
  wallet: ConnectedWallet;
  rpcUrl: string;
  rfq: OpenRfqResponse;
  onStage?: (stage: "APPROVING" | "FILLING") => void;
  publicClient?: PublicClient;
}): Promise<`0x${string}`> {
  const { wallet, rpcUrl, rfq, onStage } = params;
  if (!wallet.address) throw new Error("Please connect a wallet first");
  await ensureWalletOnTargetChain(wallet, rpcUrl);
  const publicClient =
    params.publicClient ?? createClientForRpc(wallet.chainId, rpcUrl);

  const quoteArg = {
    taker: rfq.quote.taker,
    maker: rfq.quote.maker,
    assetId: rfq.quote.assetId,
    isUp: rfq.quote.isUp,
    lowerStrike: BigInt(rfq.quote.lowerStrike),
    upperStrike: BigInt(rfq.quote.upperStrike),
    expiry: BigInt(rfq.quote.expiry),
    userPayAmount: BigInt(rfq.quote.userPayAmount),
    maxPayout: BigInt(rfq.quote.maxPayout),
    maxProtocolFeeBps: rfq.quote.maxProtocolFeeBps,
    makerEpoch: BigInt(rfq.quote.makerEpoch),
    validUntil: BigInt(rfq.quote.validUntil),
    nonce: BigInt(rfq.quote.nonce),
  };

  // Internal safety check: if pre-approval already succeeded, allowance is sufficient and skips approve immediately
  const payAmt = BigInt(rfq.quote.userPayAmount);
  await ensureUsdtApproval({
    wallet,
    rpcUrl,
    usdtAddress: rfq.usdtAddress,
    spender: rfq.verifyingContract,
    amountUsdt: unitsToUsdt(payAmt),
    amountUnits: payAmt,
    onApproving: () => onStage?.("APPROVING"),
    publicClient,
  });

  // Pre-simulate fillOpenQuote so Vault custom errors (e.g. SelfTradeNotAllowed, QuoteExpired)
  // decode cleanly before prompting the wallet to broadcast.
  await publicClient.simulateContract({
    account: wallet.address,
    address: rfq.verifyingContract,
    abi: PAYOFF_VAULT_ABI,
    functionName: "fillOpenQuote",
    args: [quoteArg, rfq.signature],
  });

  onStage?.("FILLING");
  const fillData = encodeFunctionData({
    abi: PAYOFF_VAULT_ABI,
    functionName: "fillOpenQuote",
    args: [quoteArg, rfq.signature],
  });

  const openHash = await sendEvmTx({
    wallet,
    to: rfq.verifyingContract,
    data: fillData,
  });
  await waitForConfirmedReceipt(publicClient, openHash);
  return openHash;
}

export async function executeCloseTicketTx(params: {
  wallet: ConnectedWallet;
  rpcUrl: string;
  rfq: CloseRfqResponse;
  publicClient?: PublicClient;
}): Promise<`0x${string}`> {
  const { wallet, rpcUrl, rfq } = params;
  if (!wallet.address) throw new Error("Please connect a wallet first");
  await ensureWalletOnTargetChain(wallet, rpcUrl);
  const publicClient =
    params.publicClient ?? createClientForRpc(wallet.chainId, rpcUrl);

  const quoteArg = {
    taker: rfq.quote.taker,
    maker: rfq.quote.maker,
    seriesId: rfq.quote.seriesId,
    isUp: rfq.quote.isUp,
    amount: BigInt(rfq.quote.amount),
    buybackAmount: BigInt(rfq.quote.buybackAmount),
    maxCloseFeeBps: rfq.quote.maxCloseFeeBps,
    makerEpoch: BigInt(rfq.quote.makerEpoch),
    validUntil: BigInt(rfq.quote.validUntil),
    nonce: BigInt(rfq.quote.nonce),
  };

  // Pre-simulate fillCloseQuote so Vault custom errors decode cleanly before prompting the wallet.
  await publicClient.simulateContract({
    account: wallet.address,
    address: rfq.verifyingContract,
    abi: PAYOFF_VAULT_ABI,
    functionName: "fillCloseQuote",
    args: [quoteArg, rfq.signature],
  });

  const closeData = encodeFunctionData({
    abi: PAYOFF_VAULT_ABI,
    functionName: "fillCloseQuote",
    args: [quoteArg, rfq.signature],
  });

  const hash = await sendEvmTx({
    wallet,
    to: rfq.verifyingContract,
    data: closeData,
  });
  await waitForConfirmedReceipt(publicClient, hash);
  return hash;
}

export async function executeRedeemTx(params: {
  wallet: ConnectedWallet;
  rpcUrl: string;
  vaultAddress: `0x${string}`;
  seriesId: `0x${string}`;
  publicClient?: PublicClient;
}): Promise<`0x${string}`> {
  const { wallet, rpcUrl, vaultAddress, seriesId } = params;
  if (!wallet.address) throw new Error("Please connect a wallet first");
  await ensureWalletOnTargetChain(wallet, rpcUrl);
  const publicClient =
    params.publicClient ?? createClientForRpc(wallet.chainId, rpcUrl);

  const redeemData = encodeFunctionData({
    abi: PAYOFF_VAULT_ABI,
    functionName: "redeem",
    args: [seriesId],
  });

  const hash = await sendEvmTx({
    wallet,
    to: vaultAddress,
    data: redeemData,
  });
  await waitForConfirmedReceipt(publicClient, hash);
  return hash;
}

/**
 * Permissionlessly submits 30 signed Atlas historical proofs to
 * `AtlasPullSettlementOracle.settleWithAtlasTwap(assetId, expiry, proofs)`.
 */
export async function executeSettleWithAtlasTwapTx(params: {
  wallet: ConnectedWallet;
  rpcUrl: string;
  oracleAddress: `0x${string}`;
  assetId: `0x${string}`;
  expiry: number;
  proofs: `0x${string}`[];
  publicClient?: PublicClient;
}): Promise<`0x${string}`> {
  const { wallet, rpcUrl, oracleAddress, assetId, expiry, proofs } = params;
  if (!wallet.address) throw new Error("Please connect a wallet first");
  await ensureWalletOnTargetChain(wallet, rpcUrl);
  const publicClient =
    params.publicClient ?? createClientForRpc(wallet.chainId, rpcUrl);

  await publicClient.simulateContract({
    account: wallet.address,
    address: oracleAddress,
    abi: ATLAS_SETTLEMENT_ORACLE_ABI,
    functionName: "settleWithAtlasTwap",
    args: [assetId, BigInt(expiry), proofs],
  });

  const data = encodeFunctionData({
    abi: ATLAS_SETTLEMENT_ORACLE_ABI,
    functionName: "settleWithAtlasTwap",
    args: [assetId, BigInt(expiry), proofs],
  });

  const hash = await sendEvmTx({
    wallet,
    to: oracleAddress,
    data,
  });
  await waitForConfirmedReceipt(publicClient, hash);
  return hash;
}

/**
 * Claims BNB Smart Chain Testnet MockUSDT (tUSDT)
 * directly via on-chain `MockUSDT.faucet(uint256 amount)`.
 */
export async function executeClaimTestUsdtTx(params: {
  wallet: ConnectedWallet;
  rpcUrl: string;
  usdtAddress: `0x${string}`;
  amountUsdt: number;
  publicClient?: PublicClient;
}): Promise<`0x${string}`> {
  const { wallet, rpcUrl, usdtAddress, amountUsdt } = params;
  if (!wallet.address) throw new Error("Please connect a wallet first");
  if (!Number.isFinite(amountUsdt) || amountUsdt <= 0) {
    throw new Error("Please enter an amount greater than 0");
  }

  await ensureWalletOnTargetChain(wallet, rpcUrl);

  const publicClient =
    params.publicClient ?? createClientForRpc(wallet.chainId, rpcUrl);
  const amountUnits = parseUnits(String(amountUsdt), 6);
  const data = encodeFunctionData({
    abi: MOCK_USDT_ABI,
    functionName: "faucet",
    args: [amountUnits],
  });

  const hash = await sendEvmTx({
    wallet,
    to: usdtAddress,
    data,
  });
  await waitForConfirmedReceipt(publicClient, hash);
  return hash;
}

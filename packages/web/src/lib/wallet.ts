import {
  createPublicClient,
  defineChain,
  encodeFunctionData,
  fallback,
  http,
  maxUint256,
  parseUnits,
  type Chain,
  type PublicClient,
} from "viem";
import {
  disconnect as wagmiDisconnect,
  getAccount,
  sendTransaction,
  switchChain,
} from "wagmi/actions";
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
import { getBscTestnetRpcUrls, wagmiConfig } from "./wagmi";

export type WalletTransportKind = "NONE" | "WAGMI";

export interface ConnectedWallet {
  kind: WalletTransportKind;
  walletName?: string;
  walletIcon?: string;
  connectorId?: string;
  address?: `0x${string}`;
  /** Target app chain (97 = BNB Smart Chain Testnet) */
  chainId: number;
  /** Wallet's actual currently selected EVM chain ID */
  walletChainId?: number;
  usdtBalance: number;
}

/**
 * BSC Testnet blocks report `baseFeePerGas = 0x0`, and `eth_feeHistory` reward percentiles
 * intermittently return `0`, causing EIP-1559 wallet estimators to propose `0 tBNB` and
 * get rejected at the mempool ("Transaction failed").
 * Enforcing a legacy `gasPrice` with a safe 0.1 Gwei floor avoids zero-fee rejections.
 */
const BSC_TESTNET_MIN_GAS_PRICE_WEI = 100_000_000n; // 0.1 Gwei
const BSC_MAINNET_MIN_GAS_PRICE_WEI = 100_000_000n; // 0.1 Gwei
const GAS_PRICE_BUFFER_NUM = 120n;
const GAS_PRICE_BUFFER_DEN = 100n;
const GAS_LIMIT_BUFFER_NUM = 120n;
const GAS_LIMIT_BUFFER_DEN = 100n;

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
      rpcUrls: {
        default: { http: getBscTestnetRpcUrls(rpcUrl) },
      },
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

export function createClientForRpc(
  chainId: number,
  rpcUrl: string
): PublicClient {
  if (chainId === BSC_TESTNET.chainId) {
    const urls = getBscTestnetRpcUrls(rpcUrl);
    return createPublicClient({
      chain: getChainDef(chainId, rpcUrl),
      transport: fallback(
        urls.map((u) => http(u)),
        { rank: false }
      ),
    });
  }
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

/**
 * Extracts a clear, user-readable reason from Wagmi/Viem/EIP-1193 wallet errors
 * so wallet/RPC rejections are surfaced cleanly instead of opaque fallbacks.
 */
export function extractWalletErrorMessage(
  err: any,
  fallbackMsg: string
): string {
  if (!err) return fallbackMsg;
  const code = err?.code ?? err?.cause?.code;
  if (code === 4001 || code === 100001 || code === 100002 || code === 200001) {
    return "Transaction cancelled in wallet";
  }

  const candidates = [
    err?.cause?.data?.errorName
      ? `${err?.shortMessage || fallbackMsg} (${err.cause.data.errorName})`
      : undefined,
    err?.data?.errorName
      ? `${err?.shortMessage || fallbackMsg} (${err.data.errorName})`
      : undefined,
    err?.shortMessage,
    err?.cause?.shortMessage,
    err?.cause?.details,
    err?.details,
    err?.data?.message,
    err?.cause?.message,
    err?.message,
  ].filter((v): v is string => typeof v === "string" && v.trim().length > 0);

  return candidates[0] || fallbackMsg;
}

export async function switchConnectedWalletChain(
  targetChainId: number
): Promise<number> {
  const switched = await switchChain(wagmiConfig, { chainId: targetChainId });
  return switched.id;
}

export async function disconnectWalletSession() {
  await wagmiDisconnect(wagmiConfig).catch(() => {});
}

async function ensureWalletOnTargetChain(
  wallet: ConnectedWallet
): Promise<void> {
  const account = getAccount(wagmiConfig);
  const currentChainId = account.chainId ?? wallet.walletChainId;
  if (currentChainId && currentChainId !== wallet.chainId) {
    await switchConnectedWalletChain(wallet.chainId);
  }
}

async function resolveSafeGasOverrides(params: {
  publicClient: PublicClient;
  chainId: number;
  from: `0x${string}`;
  to: `0x${string}`;
  data: `0x${string}`;
}): Promise<{ gas?: bigint; gasPrice?: bigint }> {
  const { publicClient, chainId, from, to, data } = params;
  const isBsc = chainId === BSC_TESTNET.chainId || chainId === 56;

  const [estimatedGas, rawGasPrice] = await Promise.all([
    publicClient
      .estimateGas({ account: from, to, data, value: 0n })
      .catch(() => undefined),
    isBsc ? publicClient.getGasPrice().catch(() => undefined) : Promise.resolve(undefined),
  ]);

  const gas = estimatedGas
    ? (estimatedGas * GAS_LIMIT_BUFFER_NUM) / GAS_LIMIT_BUFFER_DEN
    : undefined;

  let gasPrice: bigint | undefined;
  if (isBsc) {
    const minFloor =
      chainId === BSC_TESTNET.chainId
        ? BSC_TESTNET_MIN_GAS_PRICE_WEI
        : BSC_MAINNET_MIN_GAS_PRICE_WEI;
    const buffered = rawGasPrice
      ? (rawGasPrice * GAS_PRICE_BUFFER_NUM) / GAS_PRICE_BUFFER_DEN
      : minFloor;
    gasPrice = buffered > minFloor ? buffered : minFloor;
  }

  return { gas, gasPrice };
}

async function sendEvmTx(params: {
  wallet: ConnectedWallet;
  publicClient: PublicClient;
  to: `0x${string}`;
  data: `0x${string}`;
}): Promise<`0x${string}`> {
  const { wallet, publicClient, to, data } = params;
  if (!wallet.address || wallet.kind !== "WAGMI") {
    throw new Error("Please connect a wallet first");
  }

  const { gas, gasPrice } = await resolveSafeGasOverrides({
    publicClient,
    chainId: wallet.chainId,
    from: wallet.address,
    to,
    data,
  });

  // Explicitly pass legacy `gasPrice` on BNB Chain (and omit EIP-1559 fields)
  // so wallets never estimate `0 tBNB` from BSC Testnet's `baseFeePerGas = 0`.
  const txHash = await sendTransaction(wagmiConfig, {
    account: wallet.address,
    chainId: wallet.chainId,
    to,
    data,
    value: 0n,
    ...(gas ? { gas } : {}),
    ...(gasPrice ? { gasPrice } : {}),
  });
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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  await ensureWalletOnTargetChain(wallet);
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
    publicClient,
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
  await ensureWalletOnTargetChain(wallet);
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
  const approvalRes = await ensureUsdtApproval({
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
  // Retry briefly if we just mined an approve tx and an RPC load-balancer node lags by 1 block.
  const maxSimAttempts = approvalRes.approvedNow ? 3 : 1;
  for (let attempt = 1; attempt <= maxSimAttempts; attempt++) {
    try {
      await publicClient.simulateContract({
        account: wallet.address,
        address: rfq.verifyingContract,
        abi: PAYOFF_VAULT_ABI,
        functionName: "fillOpenQuote",
        args: [quoteArg, rfq.signature],
      });
      break;
    } catch (err: any) {
      const msg = `${err?.shortMessage || ""} ${err?.message || ""}`;
      const isAllowanceLag =
        approvalRes.approvedNow &&
        attempt < maxSimAttempts &&
        /allowance|InsufficientAllowance/i.test(msg);
      if (isAllowanceLag) {
        await sleep(1500);
        continue;
      }
      throw err;
    }
  }

  onStage?.("FILLING");
  const fillData = encodeFunctionData({
    abi: PAYOFF_VAULT_ABI,
    functionName: "fillOpenQuote",
    args: [quoteArg, rfq.signature],
  });

  const openHash = await sendEvmTx({
    wallet,
    publicClient,
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
  await ensureWalletOnTargetChain(wallet);
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
    publicClient,
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
  await ensureWalletOnTargetChain(wallet);
  const publicClient =
    params.publicClient ?? createClientForRpc(wallet.chainId, rpcUrl);

  const redeemData = encodeFunctionData({
    abi: PAYOFF_VAULT_ABI,
    functionName: "redeem",
    args: [seriesId],
  });

  const hash = await sendEvmTx({
    wallet,
    publicClient,
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
  await ensureWalletOnTargetChain(wallet);
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
    publicClient,
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

  await ensureWalletOnTargetChain(wallet);

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
    publicClient,
    to: usdtAddress,
    data,
  });
  await waitForConfirmedReceipt(publicClient, hash);
  return hash;
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useCreateWallet,
  useExportWallet,
  usePrivy,
  useSendTransaction,
  useWallets,
} from "@privy-io/react-auth";
import {
  ExternalLink,
  Loader2,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";
import {
  BSC_TESTNET,
  type AtlasFeedTelemetry,
  type PositionView,
  type RwaAssetTelemetry,
  type UnderlyingSymbol,
} from "@payoff/shared";
import {
  ApiRequestError,
  api,
  getWsUrl,
  type ConsensusGuardState,
  type HealthResponse,
} from "./lib/api";
import {
  getCopy,
  getLocaleOption,
  persistLocale,
  resolveInitialLocale,
  type Locale,
} from "./lib/i18n";
import {
  createClientForRpc,
  executeBatchRedeemTx,
  executeClaimTestUsdtTx,
  executeSettleWithAtlasTwapTx,
  executeTransferUsdtTx,
  getExplorerBaseUrl,
  readUsdtBalance,
  type ConnectedWallet,
} from "./lib/wallet";
import { Header, type ConsumerTab } from "./components/Header";
import { OnboardingSheet } from "./components/OnboardingSheet";
import { MintModal } from "./components/WalletActionModals";
import { appendWalletTransfer } from "./lib/walletActivity";
import { TradePage } from "./pages/TradePage";
import { WalletPage } from "./pages/WalletPage";
import { MetricsLedgerPage } from "./pages/MetricsLedgerPage";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

type WelcomeAirdropBanner =
  | { kind: "MINTING" }
  | { kind: "MINTED"; amountUsdt: number; txHash: string }
  | { kind: "ERROR"; message: string }
  | null;

export interface MarketFocusTarget {
  underlying: UnderlyingSymbol;
  expiry: number;
  nonce: number;
}

function isOpsRoute(): boolean {
  return (
    window.location.pathname.startsWith("/ops") ||
    window.location.hash.startsWith("#/ops")
  );
}

function parsePrivyChainId(raw?: string): number | undefined {
  if (!raw) return undefined;
  const m = String(raw).match(/(\d+)$/);
  return m ? Number(m[1]) : undefined;
}

export function App() {
  const [opsMode, setOpsMode] = useState<boolean>(isOpsRoute);
  const [locale, setLocaleState] = useState<Locale>(resolveInitialLocale);
  const [activeTab, setActiveTab] = useState<ConsumerTab>("TRADE");

  const handleSelectLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    persistLocale(next);
  }, []);

  const handleToggleLocale = useCallback(() => {
    setLocaleState((prev) => {
      const next: Locale = prev === "zh" ? "en" : "zh";
      persistLocale(next);
      return next;
    });
  }, []);

  useEffect(() => {
    document.documentElement.lang = getLocaleOption(locale).htmlLang;
  }, [locale]);
  const [health, setHealth] = useState<HealthResponse | undefined>();

  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [mintModalOpen, setMintModalOpen] = useState(false);
  const [transferRevision, setTransferRevision] = useState(0);
  const [rulesSheetOpen, setRulesSheetOpen] = useState(false);
  const [marketPickerOpen, setMarketPickerOpen] = useState(false);
  const [marketFocus, setMarketFocus] = useState<MarketFocusTarget | null>(
    null
  );

  const [usdtBalance, setUsdtBalance] = useState<number>(0);
  const [welcomeBanner, setWelcomeBanner] =
    useState<WelcomeAirdropBanner>(null);

  const { ready, authenticated, user, login, logout, getAccessToken } =
    usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const { createWallet } = useCreateWallet();
  const { exportWallet } = useExportWallet();
  const { sendTransaction: privySendTransaction } = useSendTransaction();

  const creatingWalletRef = useRef(false);
  const attemptedAirdropUsersRef = useRef<Set<string>>(new Set());

  const [liveSpots, setLiveSpots] = useState<
    Record<UnderlyingSymbol, { spot: number; change24hPct: number }>
  >({
    BTC: { spot: 68000, change24hPct: 0 },
    ETH: { spot: 2500, change24hPct: 0 },
    NVDAB: { spot: 153.0, change24hPct: 0 },
  });
  const [liveTelemetry, setLiveTelemetry] = useState<
    Partial<Record<UnderlyingSymbol, AtlasFeedTelemetry>>
  >({});
  const [liveRwaTelemetry, setLiveRwaTelemetry] = useState<
    Partial<Record<UnderlyingSymbol, RwaAssetTelemetry>>
  >({});
  const [liveCircuitBreaker, setLiveCircuitBreaker] = useState<
    Partial<Record<UnderlyingSymbol, ConsensusGuardState>>
  >({});
  const [positions, setPositions] = useState<PositionView[]>([]);

  const targetChainId = health?.chainId ?? BSC_TESTNET.chainId;

  const embeddedWallet = useMemo(
    () => wallets.find((w) => w.walletClientType === "privy"),
    [wallets]
  );

  const embeddedAddress = (
    embeddedWallet?.address ||
    (authenticated && user?.wallet?.walletClientType === "privy"
      ? user.wallet.address
      : undefined)
  ) as `0x${string}` | undefined;

  const userEmail = user?.email?.address;
  const embeddedWalletChainId = parsePrivyChainId(embeddedWallet?.chainId);
  const isGasSponsoredChain =
    targetChainId === BSC_TESTNET.chainId || targetChainId === 56;

  // Safeguard: ensure every authenticated email user gets an EVM embedded wallet automatically.
  useEffect(() => {
    if (
      !ready ||
      !authenticated ||
      !walletsReady ||
      embeddedWallet ||
      creatingWalletRef.current
    ) {
      return;
    }
    creatingWalletRef.current = true;
    void createWallet()
      .catch(() => {
        // wallet may already exist or be creating via createOnLogin
      })
      .finally(() => {
        creatingWalletRef.current = false;
      });
  }, [ready, authenticated, walletsReady, embeddedWallet, createWallet]);

  // Keep embedded wallet aligned to targetChainId (BSC Testnet 97) silently.
  useEffect(() => {
    if (
      !embeddedWallet ||
      embeddedWalletChainId === undefined ||
      embeddedWalletChainId === targetChainId
    ) {
      return;
    }
    void embeddedWallet.switchChain(targetChainId).catch(() => {});
  }, [embeddedWallet, embeddedWalletChainId, targetChainId]);

  const sendPrivyTx = useCallback(
    async (tx: {
      to: `0x${string}`;
      data: `0x${string}`;
      value?: bigint;
      chainId: number;
    }): Promise<`0x${string}`> => {
      if (!embeddedWallet) {
        throw new Error("Gasless account is still initializing; please retry");
      }
      const sponsor =
        tx.chainId === BSC_TESTNET.chainId || tx.chainId === 56;
      const result = await privySendTransaction(
        {
          to: tx.to,
          data: tx.data,
          value: tx.value ?? 0n,
          chainId: tx.chainId,
        },
        {
          address: embeddedWallet.address,
          sponsor,
          uiOptions: {
            showWalletUIs: false,
          },
        }
      );
      return result.hash;
    },
    [embeddedWallet, privySendTransaction]
  );

  const switchPrivyChain = useCallback(
    async (chainId: number) => {
      if (embeddedWallet) {
        await embeddedWallet.switchChain(chainId);
      }
    },
    [embeddedWallet]
  );

  const wallet: ConnectedWallet = useMemo(() => {
    if (!authenticated || !embeddedAddress) {
      return {
        kind: "NONE",
        chainId: targetChainId,
        usdtBalance: 0,
      };
    }

    return {
      kind: "PRIVY",
      walletName: userEmail || "Privy Account",
      email: userEmail,
      connectorId: "privy",
      address: embeddedAddress,
      chainId: targetChainId,
      walletChainId: embeddedWalletChainId ?? targetChainId,
      usdtBalance,
      gasSponsored: isGasSponsoredChain,
      sendTransaction: embeddedWallet ? sendPrivyTx : undefined,
      switchChain: embeddedWallet ? switchPrivyChain : undefined,
    };
  }, [
    authenticated,
    embeddedAddress,
    userEmail,
    targetChainId,
    embeddedWalletChainId,
    usdtBalance,
    isGasSponsoredChain,
    embeddedWallet,
    sendPrivyTx,
    switchPrivyChain,
  ]);

  useEffect(() => {
    const syncRoute = () => setOpsMode(isOpsRoute());
    window.addEventListener("popstate", syncRoute);
    window.addEventListener("hashchange", syncRoute);
    return () => {
      window.removeEventListener("popstate", syncRoute);
      window.removeEventListener("hashchange", syncRoute);
    };
  }, []);

  const refreshHealth = useCallback(async () => {
    try {
      const h = await api.getHealth();
      setHealth(h);
      setLiveSpots((prev) => ({
        BTC: {
          spot: h.spots.BTC ?? prev.BTC.spot,
          change24hPct: prev.BTC.change24hPct,
        },
        ETH: {
          spot: h.spots.ETH ?? prev.ETH.spot,
          change24hPct: prev.ETH.change24hPct,
        },
        NVDAB: {
          spot: h.spots.NVDAB ?? prev.NVDAB.spot,
          change24hPct: prev.NVDAB.change24hPct,
        },
      }));
      if (h.atlasTelemetry) {
        setLiveTelemetry((prev) => ({ ...prev, ...h.atlasTelemetry }));
      }
      if (h.rwaTelemetry) {
        setLiveRwaTelemetry((prev) => ({ ...prev, ...h.rwaTelemetry }));
      }
      if (h.settlementCircuitBreaker) {
        setLiveCircuitBreaker((prev) => ({
          ...prev,
          ...h.settlementCircuitBreaker,
        }));
      }
      return h;
    } catch {
      return undefined;
    }
  }, []);

  const refreshWalletAndPositions = useCallback(
    async (addr: `0x${string}` | undefined, h?: HealthResponse) => {
      if (!addr) {
        setUsdtBalance(0);
        setPositions([]);
        return;
      }
      const curHealth = h || health;
      const chainId = curHealth?.chainId ?? BSC_TESTNET.chainId;
      const rpcUrl = curHealth?.rpcUrl ?? BSC_TESTNET.rpcUrl;
      const usdtAddress =
        curHealth?.usdtAddress && curHealth.usdtAddress !== ZERO_ADDRESS
          ? curHealth.usdtAddress
          : BSC_TESTNET.usdtAddress;

      const client = createClientForRpc(chainId, rpcUrl);
      const [bal, posRes] = await Promise.all([
        readUsdtBalance(client, usdtAddress, addr),
        api.getPositions(addr).catch(() => ({ positions: [] })),
      ]);
      setUsdtBalance(bal);
      setPositions(posRes.positions);
    },
    [health]
  );

  useEffect(() => {
    void refreshHealth();
    api
      .getOracleConsensus()
      .then((res) => {
        if (res.telemetry) {
          setLiveTelemetry((prev) => ({ ...prev, ...res.telemetry }));
        }
        if (res.rwaTelemetry) {
          setLiveRwaTelemetry((prev) => ({ ...prev, ...res.rwaTelemetry }));
        }
        if (res.circuitBreaker) {
          setLiveCircuitBreaker((prev) => ({
            ...prev,
            ...res.circuitBreaker,
          }));
        }
      })
      .catch(() => {});
  }, [refreshHealth]);

  // Keep USDT balance & positions synced on login or wallet init
  useEffect(() => {
    if (!authenticated || !embeddedAddress) {
      setUsdtBalance(0);
      setPositions([]);
      return;
    }
    void refreshWalletAndPositions(embeddedAddress);
  }, [authenticated, embeddedAddress, health, refreshWalletAndPositions]);

  // Automatically airdrop 1,000 welcome tUSDT on first Privy login
  const triggerWelcomeAirdrop = useCallback(
    async (targetAddr: `0x${string}`, attempt = 1): Promise<void> => {
      setWelcomeBanner({ kind: "MINTING" });
      try {
        const token = await getAccessToken();
        if (!token) {
          setWelcomeBanner(null);
          return;
        }
        const res = await api.claimWelcomeAirdrop(token);
        if (res.status === "MINTED") {
          setWelcomeBanner({
            kind: "MINTED",
            amountUsdt: res.amountUsdt,
            txHash: res.txHash,
          });
          await refreshWalletAndPositions(targetAddr);
          // Re-check balance once more shortly in case load-balanced RPC lags by 1 block
          setTimeout(() => {
            void refreshWalletAndPositions(targetAddr);
          }, 2500);
        } else {
          setWelcomeBanner(null);
        }
      } catch (err: any) {
        if (
          err instanceof ApiRequestError &&
          err.status === 409 &&
          err.code === "WALLET_NOT_READY" &&
          attempt < 4
        ) {
          await new Promise((r) => setTimeout(r, 1500));
          return triggerWelcomeAirdrop(targetAddr, attempt + 1);
        }
        if (
          err instanceof ApiRequestError &&
          (err.code === "AIRDROP_DISABLED" ||
            err.code === "PRIVY_NOT_CONFIGURED")
        ) {
          setWelcomeBanner(null);
          return;
        }
        setWelcomeBanner({
          kind: "ERROR",
          message: err?.message || "Welcome tUSDT airdrop failed",
        });
      }
    },
    [getAccessToken, refreshWalletAndPositions]
  );

  useEffect(() => {
    if (!ready || !authenticated || !user?.id || !embeddedAddress) {
      return;
    }
    if (attemptedAirdropUsersRef.current.has(user.id)) {
      return;
    }
    attemptedAirdropUsersRef.current.add(user.id);
    void triggerWelcomeAirdrop(embeddedAddress);
  }, [ready, authenticated, user?.id, embeddedAddress, triggerWelcomeAirdrop]);

  useEffect(() => {
    const wsUrl = getWsUrl(wallet.address);
    const ws = new WebSocket(wsUrl);
    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === "TICK") {
          if (msg.spots) {
            setLiveSpots((prev) => ({ ...prev, ...msg.spots }));
          }
          if (msg.atlasTelemetry) {
            setLiveTelemetry((prev) => ({ ...prev, ...msg.atlasTelemetry }));
          }
          if (msg.rwaTelemetry) {
            setLiveRwaTelemetry((prev) => ({ ...prev, ...msg.rwaTelemetry }));
          }
          if (msg.settlementCircuitBreaker) {
            setLiveCircuitBreaker((prev) => ({
              ...prev,
              ...msg.settlementCircuitBreaker,
            }));
          }
          if (Array.isArray(msg.positions)) setPositions(msg.positions);
        }
      } catch {
        // ignore malformed tick frames
      }
    };
    return () => ws.close();
  }, [wallet.address]);

  const handleOpenAuthOrAccount = useCallback(() => {
    if (!ready) return;
    if (!authenticated) {
      login({ loginMethods: ["email"] });
      return;
    }
    setActiveTab("POSITIONS");
    window.scrollTo({ top: 0 });
  }, [ready, authenticated, login]);

  const handleExportWallet = useCallback(async () => {
    if (!embeddedAddress) return;
    await exportWallet({ address: embeddedAddress }).catch(() => {});
  }, [embeddedAddress, exportWallet]);

  const handleLogout = useCallback(async () => {
    setWelcomeBanner(null);
    await logout().catch(() => {});
    setUsdtBalance(0);
    setPositions([]);
    setActiveTab("TRADE");
  }, [logout]);

  const handleRefreshPositions = useCallback(async () => {
    await refreshWalletAndPositions(wallet.address);
  }, [refreshWalletAndPositions, wallet.address]);

  const handleBatchClaim = useCallback(
    async (seriesIds: `0x${string}`[]) => {
      const uniqueIds = Array.from(new Set(seriesIds));
      if (uniqueIds.length === 0) return;

      const curHealth = health ?? (await refreshHealth());
      const vaultAddress = curHealth?.vaultAddress;
      const rpcUrl = curHealth?.rpcUrl || BSC_TESTNET.rpcUrl;
      if (!vaultAddress || vaultAddress === ZERO_ADDRESS) {
        throw new Error("Vault contract address unavailable");
      }

      const hash = await executeBatchRedeemTx({
        wallet,
        rpcUrl,
        vaultAddress,
        seriesIds: uniqueIds,
      });
      await api.ingestTx(hash).catch(() => api.syncChain());
      await refreshWalletAndPositions(wallet.address, curHealth);
    },
    [health, refreshHealth, wallet, refreshWalletAndPositions]
  );

  const handleClaimPosition = useCallback(
    async (position: PositionView) => {
      await handleBatchClaim([position.seriesId]);
    },
    [handleBatchClaim]
  );

  const handleManualSettle = useCallback(
    async (
      underlying: UnderlyingSymbol,
      expiry: number
    ): Promise<{
      status: "SETTLED" | "ALREADY_SETTLED";
      twapPriceUsd?: number;
    }> => {
      const curHealth = health ?? (await refreshHealth());
      const rpcUrl = curHealth?.rpcUrl || BSC_TESTNET.rpcUrl;
      const tLocal = getCopy(locale);

      const bundle = await api.getSettlementProof(underlying, expiry);
      if (bundle.status === "ALREADY_SETTLED") {
        await refreshWalletAndPositions(wallet.address, curHealth);
        return { status: "ALREADY_SETTLED", twapPriceUsd: bundle.twapPriceUsd };
      }
      if (bundle.status === "DISPUTED_PAUSED") {
        await refreshWalletAndPositions(wallet.address, curHealth);
        throw new Error(tLocal.disputedExpiryNotice);
      }
      if (bundle.status === "WAITING_DELAY") {
        throw new Error(tLocal.settleWaitingDelay);
      }
      if (!bundle.proofs || bundle.proofs.length === 0) {
        throw new Error("Missing signed Atlas TWAP proofs");
      }

      try {
        const hash = await executeSettleWithAtlasTwapTx({
          wallet,
          rpcUrl,
          oracleAddress: bundle.oracleAddress,
          assetId: bundle.assetId,
          expiry: bundle.expiry,
          proofs: bundle.proofs,
        });
        await api.ingestTx(hash).catch(() => api.syncChain());
        await refreshWalletAndPositions(wallet.address, curHealth);
        return { status: "SETTLED", twapPriceUsd: bundle.twapPriceUsd };
      } catch (err: any) {
        const rawMsg = String(err?.shortMessage || err?.message || "");
        if (rawMsg.includes("AlreadySettled")) {
          await refreshWalletAndPositions(wallet.address, curHealth);
          return {
            status: "ALREADY_SETTLED",
            twapPriceUsd: bundle.twapPriceUsd,
          };
        }
        throw err;
      }
    },
    [health, refreshHealth, locale, wallet, refreshWalletAndPositions]
  );

  const handleClaimFaucet = useCallback(
    async (amountUsdt = 1000): Promise<`0x${string}`> => {
      const curHealth = health ?? (await refreshHealth());
      const rpcUrl = curHealth?.rpcUrl || BSC_TESTNET.rpcUrl;
      const usdtAddress =
        curHealth?.usdtAddress && curHealth.usdtAddress !== ZERO_ADDRESS
          ? curHealth.usdtAddress
          : BSC_TESTNET.usdtAddress;
      if (!usdtAddress || usdtAddress === ZERO_ADDRESS) {
        throw new Error("Testnet tUSDT contract unavailable");
      }
      const clamped = Math.max(1, Math.min(100_000, amountUsdt));
      const hash = await executeClaimTestUsdtTx({
        wallet,
        rpcUrl,
        usdtAddress,
        amountUsdt: clamped,
      });
      appendWalletTransfer(wallet.address, {
        kind: "FAUCET",
        amountUsdt: clamped,
        txHash: hash,
        chainId: curHealth?.chainId ?? wallet.chainId ?? BSC_TESTNET.chainId,
      });
      setTransferRevision((r) => r + 1);
      await refreshWalletAndPositions(wallet.address, curHealth);
      return hash;
    },
    [health, refreshHealth, wallet, refreshWalletAndPositions]
  );

  const handleWithdrawUsdt = useCallback(
    async (to: `0x${string}`, amountUsdt: number): Promise<`0x${string}`> => {
      const curHealth = health ?? (await refreshHealth());
      const rpcUrl = curHealth?.rpcUrl || BSC_TESTNET.rpcUrl;
      const usdtAddress =
        curHealth?.usdtAddress && curHealth.usdtAddress !== ZERO_ADDRESS
          ? curHealth.usdtAddress
          : BSC_TESTNET.usdtAddress;
      if (!usdtAddress || usdtAddress === ZERO_ADDRESS) {
        throw new Error("tUSDT contract unavailable");
      }
      const hash = await executeTransferUsdtTx({
        wallet,
        rpcUrl,
        usdtAddress,
        to,
        amountUsdt,
      });
      await refreshWalletAndPositions(wallet.address, curHealth);
      return hash;
    },
    [health, refreshHealth, wallet, refreshWalletAndPositions]
  );

  const handleSelectPositionMarket = useCallback(
    (underlying: UnderlyingSymbol, expiry: number) => {
      setActiveTab("TRADE");
      setMarketFocus({ underlying, expiry, nonce: Date.now() });
    },
    []
  );

  const handleOpenOnboarding = useCallback(() => {
    setRulesSheetOpen(false);
    setActiveTab("TRADE");
    setOnboardingOpen(true);
  }, []);

  if (opsMode) {
    return (
      <div className="min-h-screen bg-[#090d14] text-slate-100">
        <MetricsLedgerPage />
      </div>
    );
  }

  const activePositionsCount = positions.filter(
    (p) => p.status === "ACTIVE" || p.status === "SETTLED_CLAIMABLE"
  ).length;
  const claimablePositionsCount = positions.filter(
    (p) => p.status === "SETTLED_CLAIMABLE" && p.claimableUsdt > 0
  ).length;
  const t = getCopy(locale);
  const explorerBase = getExplorerBaseUrl(targetChainId);
  const authInitializing = authenticated && !embeddedAddress;
  const isTestnet = targetChainId === BSC_TESTNET.chainId;

  return (
    <div className="min-h-screen bg-black text-white">
      <Header
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        locale={locale}
        onSelectLocale={handleSelectLocale}
        onToggleLocale={handleToggleLocale}
        wallet={wallet}
        authReady={ready}
        authInitializing={authInitializing}
        positionCount={activePositionsCount}
        claimableCount={claimablePositionsCount}
        onOpenWalletModal={handleOpenAuthOrAccount}
        onLogin={() => login({ loginMethods: ["email"] })}
        onExportWallet={() => void handleExportWallet()}
        onDisconnect={() => void handleLogout()}
        onOpenMint={isTestnet ? () => setMintModalOpen(true) : undefined}
      />

      {/* A4 Slim Dark Welcome Airdrop Pill Banner */}
      {welcomeBanner && (
        <div className="mx-auto max-w-[1160px] px-4 pt-1 pb-1 sm:px-6">
          <div
            role={welcomeBanner.kind === "ERROR" ? "alert" : "status"}
            aria-live="polite"
            className={`flex flex-wrap items-center justify-between gap-2 rounded-full px-3.5 py-2 text-xs font-medium ${
              welcomeBanner.kind === "ERROR"
                ? "border border-[#E85D4A]/30 bg-[#121417] text-[#b8bec6]"
                : welcomeBanner.kind === "MINTED"
                  ? "border border-[#2EC26B]/25 bg-[#2EC26B]/12 text-[#2EC26B]"
                  : "border border-[#262a31] bg-[#15171b] text-[#b8bec6]"
            }`}
          >
            <div className="flex items-center gap-2 min-w-0">
              {welcomeBanner.kind === "MINTING" ? (
                <>
                  <Loader2
                    className="h-3.5 w-3.5 animate-spin shrink-0 text-[#2EC26B]"
                    aria-hidden="true"
                  />
                  <span className="truncate">{t.welcomeAirdropMinting}</span>
                </>
              ) : welcomeBanner.kind === "MINTED" ? (
                <>
                  <Sparkles
                    className="h-3.5 w-3.5 shrink-0"
                    aria-hidden="true"
                  />
                  <span className="font-semibold">
                    {t.welcomeAirdropShortSuccess(welcomeBanner.amountUsdt)}
                  </span>
                  {explorerBase && welcomeBanner.txHash && (
                    <a
                      href={`${explorerBase}/tx/${welcomeBanner.txHash}`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-[#2EC26B]/90 underline underline-offset-2 hover:text-[#2EC26B]"
                    >
                      BscScan
                      <ExternalLink className="h-2.5 w-2.5" aria-hidden="true" />
                    </a>
                  )}
                </>
              ) : (
                <>
                  <span
                    aria-hidden="true"
                    className="h-2 w-2 shrink-0 rounded-full bg-[#E85D4A]"
                  />
                  <span className="truncate">{welcomeBanner.message}</span>
                </>
              )}
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              {welcomeBanner.kind === "ERROR" && embeddedAddress && (
                <button
                  type="button"
                  onClick={() => void triggerWelcomeAirdrop(embeddedAddress)}
                  className="inline-flex items-center gap-1 rounded-full bg-[#E85D4A] px-2.5 py-1 text-[11px] font-bold text-black hover:bg-[#e85d4a]/90 transition cursor-pointer"
                >
                  <RefreshCw className="h-3 w-3" aria-hidden="true" />
                  <span>{t.welcomeAirdropRetryFull}</span>
                </button>
              )}
              {welcomeBanner.kind !== "MINTING" && (
                <button
                  type="button"
                  aria-label={t.cancel}
                  onClick={() => setWelcomeBanner(null)}
                  className="rounded-full p-1 text-current/75 hover:bg-white/10 hover:text-current transition cursor-pointer"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {activeTab === "TRADE" && (
        <TradePage
          locale={locale}
          wallet={wallet}
          health={health}
          rpcUrl={health?.rpcUrl || BSC_TESTNET.rpcUrl}
          positions={positions}
          liveSpots={liveSpots}
          liveTelemetry={liveTelemetry}
          liveRwaTelemetry={liveRwaTelemetry}
          liveCircuitBreaker={liveCircuitBreaker}
          marketFocus={marketFocus}
          rulesSheetOpen={rulesSheetOpen}
          onOpenRules={() => setRulesSheetOpen(true)}
          onCloseRules={() => setRulesSheetOpen(false)}
          marketPickerOpen={marketPickerOpen}
          onOpenMarketPicker={() => setMarketPickerOpen(true)}
          onCloseMarketPicker={() => setMarketPickerOpen(false)}
          onOpenOnboarding={handleOpenOnboarding}
          onOpenWallet={handleOpenAuthOrAccount}
          onRefreshPositions={handleRefreshPositions}
          onBatchClaim={handleBatchClaim}
          onClaimPosition={handleClaimPosition}
          onManualSettle={handleManualSettle}
        />
      )}

      {activeTab === "POSITIONS" && (
        <WalletPage
          locale={locale}
          wallet={wallet}
          health={health}
          positions={positions}
          transferRevision={transferRevision}
          onLogin={() => login({ loginMethods: ["email"] })}
          onGoToTrade={() => setActiveTab("TRADE")}
          onRefresh={() => void handleRefreshPositions()}
          onOpenMint={isTestnet ? () => setMintModalOpen(true) : undefined}
          onWithdrawUsdt={handleWithdrawUsdt}
          onBatchClaim={handleBatchClaim}
          onClaimPosition={handleClaimPosition}
          onManualSettle={handleManualSettle}
          onSelectPositionMarket={handleSelectPositionMarket}
        />
      )}

      {isTestnet && (
        <MintModal
          open={mintModalOpen}
          locale={locale}
          wallet={wallet}
          onClose={() => setMintModalOpen(false)}
          onClaimFaucet={handleClaimFaucet}
        />
      )}

      <OnboardingSheet
        open={onboardingOpen}
        locale={locale}
        walletConnected={wallet.kind !== "NONE"}
        onClose={() => setOnboardingOpen(false)}
      />
    </div>
  );
}

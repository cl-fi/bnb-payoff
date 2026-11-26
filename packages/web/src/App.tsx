import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useCreateWallet,
  useExportWallet,
  usePrivy,
  useSendTransaction,
  useWallets,
} from "@privy-io/react-auth";
import {
  CheckCircle2,
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
import { getCopy, type Locale } from "./lib/i18n";
import {
  createClientForRpc,
  getExplorerBaseUrl,
  readUsdtBalance,
  type ConnectedWallet,
} from "./lib/wallet";
import { Header, type ConsumerTab } from "./components/Header";
import { WalletModal } from "./components/WalletModal";
import { TradePage } from "./pages/TradePage";
import { PositionsPage } from "./pages/PositionsPage";
import { MetricsLedgerPage } from "./pages/MetricsLedgerPage";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

type WelcomeAirdropBanner =
  | { kind: "MINTING" }
  | { kind: "MINTED"; amountUsdt: number; txHash: string }
  | { kind: "ERROR"; message: string }
  | null;

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
  const [locale, setLocale] = useState<Locale>("en");
  const [activeTab, setActiveTab] = useState<ConsumerTab>("TRADE");
  const [health, setHealth] = useState<HealthResponse | undefined>();

  const [accountModalOpen, setAccountModalOpen] = useState(false);
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

  const handleOpenAuthOrAccount = () => {
    if (!ready) return;
    if (!authenticated) {
      login({ loginMethods: ["email"] });
      return;
    }
    setAccountModalOpen(true);
  };

  const handleExportWallet = async () => {
    if (!embeddedAddress) return;
    await exportWallet({ address: embeddedAddress }).catch(() => {});
  };

  const handleLogout = async () => {
    setAccountModalOpen(false);
    setWelcomeBanner(null);
    await logout().catch(() => {});
    setUsdtBalance(0);
    setPositions([]);
  };

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
  const t = getCopy(locale);
  const explorerBase = getExplorerBaseUrl(targetChainId);
  const authInitializing = authenticated && !embeddedAddress;

  return (
    <div className="min-h-screen bg-[#f7f8f9] text-[#14202a]">
      <Header
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        locale={locale}
        onToggleLocale={() => setLocale((l) => (l === "zh" ? "en" : "zh"))}
        wallet={wallet}
        authReady={ready}
        authInitializing={authInitializing}
        positionCount={activePositionsCount}
        onOpenWalletModal={handleOpenAuthOrAccount}
      />

      {welcomeBanner && (
        <div
          role={welcomeBanner.kind === "ERROR" ? "alert" : "status"}
          aria-live="polite"
          className={`border-b px-4 py-2.5 ${
            welcomeBanner.kind === "ERROR"
              ? "border-[#f1ccc6] bg-[#fbeeea] text-[#b54134]"
              : "border-[#bfe2dc] bg-[#e9f3f1] text-[#0e7c72]"
          }`}
        >
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 text-xs font-medium">
            <div className="flex items-center gap-2">
              {welcomeBanner.kind === "MINTING" ? (
                <>
                  <Loader2
                    className="h-3.5 w-3.5 animate-spin shrink-0"
                    aria-hidden="true"
                  />
                  <span>{t.welcomeAirdropMinting}</span>
                </>
              ) : welcomeBanner.kind === "MINTED" ? (
                <>
                  <Sparkles className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span>{t.welcomeAirdropSuccess(welcomeBanner.amountUsdt)}</span>
                  {explorerBase && welcomeBanner.txHash && (
                    <a
                      href={`${explorerBase}/tx/${welcomeBanner.txHash}`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 font-semibold underline underline-offset-2"
                    >
                      BscScan
                      <ExternalLink className="h-3 w-3" aria-hidden="true" />
                    </a>
                  )}
                </>
              ) : (
                <>
                  <CheckCircle2
                    className="h-3.5 w-3.5 shrink-0"
                    aria-hidden="true"
                  />
                  <span>{welcomeBanner.message}</span>
                </>
              )}
            </div>

            <div className="flex items-center gap-2">
              {welcomeBanner.kind === "ERROR" && embeddedAddress && (
                <button
                  type="button"
                  onClick={() => void triggerWelcomeAirdrop(embeddedAddress)}
                  className="inline-flex items-center gap-1 rounded-md bg-[#b54134] px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-[#99352a] cursor-pointer"
                >
                  <RefreshCw className="h-3 w-3" aria-hidden="true" />
                  {t.welcomeAirdropRetry}
                </button>
              )}
              {welcomeBanner.kind !== "MINTING" && (
                <button
                  type="button"
                  aria-label={t.cancel}
                  onClick={() => setWelcomeBanner(null)}
                  className="rounded p-1 hover:bg-black/5 cursor-pointer"
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
          liveSpots={liveSpots}
          liveTelemetry={liveTelemetry}
          liveRwaTelemetry={liveRwaTelemetry}
          liveCircuitBreaker={liveCircuitBreaker}
          onOpenWallet={handleOpenAuthOrAccount}
          onTxSuccess={() => void refreshWalletAndPositions(wallet.address)}
          onGoToPositions={() => {
            void refreshWalletAndPositions(wallet.address);
            setActiveTab("POSITIONS");
          }}
        />
      )}

      {activeTab === "POSITIONS" && (
        <PositionsPage
          locale={locale}
          wallet={wallet}
          health={health}
          positions={positions}
          onOpenWallet={handleOpenAuthOrAccount}
          onGoToTrade={() => setActiveTab("TRADE")}
          onRefresh={() => void refreshWalletAndPositions(wallet.address)}
        />
      )}

      <WalletModal
        open={accountModalOpen}
        locale={locale}
        wallet={wallet}
        onClose={() => setAccountModalOpen(false)}
        onLogin={() => {
          setAccountModalOpen(false);
          login({ loginMethods: ["email"] });
        }}
        onExportWallet={() => void handleExportWallet()}
        onDisconnect={() => void handleLogout()}
      />
    </div>
  );
}

import { useCallback, useEffect, useState } from "react";
import {
  BSC_TESTNET,
  type AtlasFeedTelemetry,
  type PositionView,
  type UnderlyingSymbol,
} from "@payoff/shared";
import {
  api,
  getWsUrl,
  type ConsensusGuardState,
  type HealthResponse,
} from "./lib/api";
import { getCopy, type Locale } from "./lib/i18n";
import {
  connectInjectedWallet,
  createClientForRpc,
  disconnectWalletSession,
  readUsdtBalance,
  subscribeDiscoveredWallets,
  switchConnectedWalletChain,
  type ConnectedWallet,
  type DiscoveredWallet,
} from "./lib/wallet";
import { Header, type ConsumerTab } from "./components/Header";
import { WalletModal } from "./components/WalletModal";
import { TradePage } from "./pages/TradePage";
import { PositionsPage } from "./pages/PositionsPage";
import { MetricsLedgerPage } from "./pages/MetricsLedgerPage";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function isOpsRoute(): boolean {
  return (
    window.location.pathname.startsWith("/ops") ||
    window.location.hash.startsWith("#/ops")
  );
}

export function App() {
  const [opsMode, setOpsMode] = useState<boolean>(isOpsRoute);
  const [locale, setLocale] = useState<Locale>("en");
  const [activeTab, setActiveTab] = useState<ConsumerTab>("TRADE");
  const [health, setHealth] = useState<HealthResponse | undefined>();

  const [walletModalOpen, setWalletModalOpen] = useState(false);
  const [discoveredWallets, setDiscoveredWallets] = useState<
    DiscoveredWallet[]
  >([]);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [switchingChain, setSwitchingChain] = useState(false);
  const [walletErr, setWalletErr] = useState<string | undefined>();
  const [wallet, setWallet] = useState<ConnectedWallet>({
    kind: "NONE",
    chainId: BSC_TESTNET.chainId,
    usdtBalance: 0,
  });

  const [liveSpots, setLiveSpots] = useState<
    Record<UnderlyingSymbol, { spot: number; change24hPct: number }>
  >({
    BTC: { spot: 68000, change24hPct: 0 },
    ETH: { spot: 2500, change24hPct: 0 },
  });
  const [liveTelemetry, setLiveTelemetry] = useState<
    Partial<Record<UnderlyingSymbol, AtlasFeedTelemetry>>
  >({});
  const [liveCircuitBreaker, setLiveCircuitBreaker] = useState<
    Partial<Record<UnderlyingSymbol, ConsensusGuardState>>
  >({});
  const [positions, setPositions] = useState<PositionView[]>([]);

  useEffect(() => {
    const syncRoute = () => setOpsMode(isOpsRoute());
    window.addEventListener("popstate", syncRoute);
    window.addEventListener("hashchange", syncRoute);
    return () => {
      window.removeEventListener("popstate", syncRoute);
      window.removeEventListener("hashchange", syncRoute);
    };
  }, []);

  useEffect(() => {
    return subscribeDiscoveredWallets(setDiscoveredWallets);
  }, []);

  const refreshHealth = useCallback(async () => {
    try {
      const h = await api.getHealth();
      setHealth(h);
      setLiveSpots((prev) => ({
        BTC: { spot: h.spots.BTC, change24hPct: prev.BTC.change24hPct },
        ETH: { spot: h.spots.ETH, change24hPct: prev.ETH.change24hPct },
      }));
      if (h.atlasTelemetry) {
        setLiveTelemetry((prev) => ({ ...prev, ...h.atlasTelemetry }));
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
    async (w: ConnectedWallet, h?: HealthResponse) => {
      if (!w.address) return;
      const curHealth = h || health;
      const chainId = curHealth?.chainId ?? BSC_TESTNET.chainId;
      const rpcUrl = curHealth?.rpcUrl ?? BSC_TESTNET.rpcUrl;
      const usdtAddress =
        curHealth?.usdtAddress && curHealth.usdtAddress !== ZERO_ADDRESS
          ? curHealth.usdtAddress
          : BSC_TESTNET.usdtAddress;

      const client = createClientForRpc(chainId, rpcUrl);
      const [bal, posRes] = await Promise.all([
        readUsdtBalance(client, usdtAddress, w.address),
        api.getPositions(w.address).catch(() => ({ positions: [] })),
      ]);
      setWallet((prev) =>
        prev.address === w.address ? { ...prev, usdtBalance: bal } : prev
      );
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
        if (res.circuitBreaker) {
          setLiveCircuitBreaker((prev) => ({
            ...prev,
            ...res.circuitBreaker,
          }));
        }
      })
      .catch(() => {});
  }, [refreshHealth]);

  useEffect(() => {
    if (wallet.kind !== "INJECTED" || !wallet.provider?.on) return;
    const handleAccounts = (accounts: string[]) => {
      if (!accounts || accounts.length === 0) {
        setWallet({
          kind: "NONE",
          chainId: health?.chainId ?? BSC_TESTNET.chainId,
          usdtBalance: 0,
        });
        setPositions([]);
      } else {
        const next: ConnectedWallet = {
          ...wallet,
          address: accounts[0] as `0x${string}`,
        };
        setWallet(next);
        void refreshWalletAndPositions(next);
      }
    };
    const handleChainChanged = (hexChainId: string) => {
      const nextId = parseInt(String(hexChainId), 16);
      setWallet((prev) => ({ ...prev, walletChainId: nextId }));
    };
    wallet.provider.on("accountsChanged", handleAccounts);
    wallet.provider.on("chainChanged", handleChainChanged);
    return () => {
      wallet.provider?.removeListener?.("accountsChanged", handleAccounts);
      wallet.provider?.removeListener?.("chainChanged", handleChainChanged);
    };
  }, [wallet, health, refreshWalletAndPositions]);

  useEffect(() => {
    const wsUrl = getWsUrl(wallet.address);
    const ws = new WebSocket(wsUrl);
    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === "TICK") {
          if (msg.spots) setLiveSpots(msg.spots);
          if (msg.atlasTelemetry) {
            setLiveTelemetry((prev) => ({ ...prev, ...msg.atlasTelemetry }));
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

  const handleConnectDiscovered = async (d: DiscoveredWallet) => {
    setConnectingId(d.id);
    setWalletErr(undefined);
    try {
      const h = health || (await refreshHealth());
      const targetChainId = h?.chainId ?? BSC_TESTNET.chainId;
      const rpcUrl = h?.rpcUrl ?? BSC_TESTNET.rpcUrl;
      const connected = await connectInjectedWallet(d, targetChainId, rpcUrl);
      setWallet(connected);
      setWalletModalOpen(false);
      await refreshWalletAndPositions(connected, h);
    } catch (err: any) {
      setWalletErr(err?.message || `Failed to connect ${d.name}`);
    } finally {
      setConnectingId(null);
    }
  };

  const handleDisconnect = async () => {
    await disconnectWalletSession(wallet);
    setWallet({
      kind: "NONE",
      chainId: health?.chainId ?? BSC_TESTNET.chainId,
      usdtBalance: 0,
    });
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
  const wrongNetwork =
    wallet.kind !== "NONE" &&
    wallet.walletChainId !== undefined &&
    wallet.walletChainId !== (health?.chainId ?? BSC_TESTNET.chainId);

  const handleSwitchNetwork = async () => {
    setSwitchingChain(true);
    try {
      const targetId = health?.chainId ?? BSC_TESTNET.chainId;
      const rpcUrl = health?.rpcUrl ?? BSC_TESTNET.rpcUrl;
      const switchedId = await switchConnectedWalletChain(
        wallet,
        targetId,
        rpcUrl
      );
      const updated = {
        ...wallet,
        walletChainId: switchedId,
        chainId: targetId,
      };
      setWallet(updated);
      await refreshWalletAndPositions(updated);
    } catch {
      // user rejected chain switch
    } finally {
      setSwitchingChain(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#f7f8f9] text-[#14202a]">
      <Header
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        locale={locale}
        onToggleLocale={() => setLocale((l) => (l === "zh" ? "en" : "zh"))}
        wallet={wallet}
        positionCount={activePositionsCount}
        onOpenWalletModal={() => {
          setWalletErr(undefined);
          setWalletModalOpen(true);
        }}
      />

      {wrongNetwork && (
        <div className="border-b border-[#e2e5e8] bg-[#fbf3dd] px-4 py-2.5">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 text-xs text-[#8a6410]">
            <span className="font-medium">{t.wrongNetworkBanner}</span>
            <button
              type="button"
              disabled={switchingChain}
              onClick={() => void handleSwitchNetwork()}
              className="rounded-lg bg-[#14202a] px-3 py-1 text-xs font-semibold text-white hover:bg-[#000a12] disabled:opacity-50 cursor-pointer"
            >
              {switchingChain ? t.switchingNetwork : t.switchToBsc}
            </button>
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
          liveCircuitBreaker={liveCircuitBreaker}
          onOpenWallet={() => {
            setWalletErr(undefined);
            setWalletModalOpen(true);
          }}
          onTxSuccess={() => void refreshWalletAndPositions(wallet)}
          onGoToPositions={() => {
            void refreshWalletAndPositions(wallet);
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
          onOpenWallet={() => {
            setWalletErr(undefined);
            setWalletModalOpen(true);
          }}
          onGoToTrade={() => setActiveTab("TRADE")}
          onRefresh={() => void refreshWalletAndPositions(wallet)}
        />
      )}

      <WalletModal
        open={walletModalOpen}
        locale={locale}
        wallet={wallet}
        discoveredWallets={discoveredWallets}
        connectingId={connectingId}
        errorMsg={walletErr}
        onClose={() => setWalletModalOpen(false)}
        onConnectDiscovered={(w) => void handleConnectDiscovered(w)}
        onDisconnect={() => void handleDisconnect()}
      />
    </div>
  );
}

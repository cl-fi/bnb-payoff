import { useCallback, useEffect, useMemo, useState } from "react";
import {
  useAccount,
  useConnect,
  useConnectors,
  useDisconnect,
  useSwitchChain,
} from "wagmi";
import {
  BSC_TESTNET,
  type AtlasFeedTelemetry,
  type PositionView,
  type RwaAssetTelemetry,
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
  BINANCE_WALLET_ICON,
  WALLETCONNECT_ICON,
  getOrderedWalletConnectors,
  type WalletConnectorOption,
} from "./lib/wagmi";
import {
  createClientForRpc,
  disconnectWalletSession,
  extractWalletErrorMessage,
  readUsdtBalance,
  type ConnectedWallet,
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
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [walletErr, setWalletErr] = useState<string | undefined>();
  const [usdtBalance, setUsdtBalance] = useState<number>(0);

  const { address, isConnected, chainId: walletChainId, connector } = useAccount();
  const connectors = useConnectors();
  const { connectAsync } = useConnect();
  const { disconnectAsync } = useDisconnect();
  const { switchChainAsync, isPending: switchingChain } = useSwitchChain();

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

  const walletOptions = useMemo(
    () => getOrderedWalletConnectors(connectors),
    [connectors]
  );

  const wallet: ConnectedWallet = useMemo(() => {
    if (!isConnected || !address) {
      return {
        kind: "NONE",
        chainId: targetChainId,
        usdtBalance: 0,
      };
    }

    const hay = `${connector?.id || ""} ${connector?.name || ""}`.toLowerCase();
    const isBinance = hay.includes("binance");
    const isWc = hay.includes("walletconnect");

    return {
      kind: "WAGMI",
      walletName: isBinance ? "Binance Wallet" : connector?.name || "Web3 Wallet",
      walletIcon:
        connector?.icon ||
        (isBinance
          ? BINANCE_WALLET_ICON
          : isWc
            ? WALLETCONNECT_ICON
            : undefined),
      connectorId: connector?.id,
      address,
      chainId: targetChainId,
      walletChainId,
      usdtBalance,
    };
  }, [
    isConnected,
    address,
    connector,
    targetChainId,
    walletChainId,
    usdtBalance,
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

  // Keep USDT balance & positions synced on connect, auto-reconnect, account switch, or chain switch
  useEffect(() => {
    if (!isConnected || !address) {
      setUsdtBalance(0);
      setPositions([]);
      return;
    }
    void refreshWalletAndPositions(address);
  }, [isConnected, address, walletChainId, health, refreshWalletAndPositions]);

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

  const handleConnectOption = async (option: WalletConnectorOption) => {
    setConnectingId(option.uid);
    setWalletErr(undefined);
    try {
      const h = health || (await refreshHealth());
      const desiredChainId = h?.chainId ?? BSC_TESTNET.chainId;

      // Close native top-layer <dialog> before launching QR modals (Binance App QR / WalletConnect)
      // so the dialog top layer never occludes the third-party QR overlay.
      if (option.isQrFallback) {
        setWalletModalOpen(false);
      }

      const res = await connectAsync({
        connector: option.connector,
        chainId: desiredChainId,
      });

      if (res.chainId !== desiredChainId) {
        await switchChainAsync({ chainId: desiredChainId }).catch(() => {});
      }

      setWalletModalOpen(false);
      if (res.accounts[0]) {
        await refreshWalletAndPositions(res.accounts[0], h);
      }
    } catch (err: any) {
      const msg = extractWalletErrorMessage(
        err,
        `Failed to connect ${option.name}`
      );
      const code = err?.code ?? err?.cause?.code;
      const isCancelled =
        code === 4001 ||
        code === 100001 ||
        code === 100002 ||
        /cancel|closed modal|user rejected/i.test(msg);
      if (!isCancelled) {
        setWalletErr(msg);
        setWalletModalOpen(true);
      }
    } finally {
      setConnectingId(null);
    }
  };

  const handleDisconnect = async () => {
    await disconnectAsync().catch(() => disconnectWalletSession());
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
  const wrongNetwork =
    wallet.kind !== "NONE" &&
    wallet.walletChainId !== undefined &&
    wallet.walletChainId !== targetChainId;

  const handleSwitchNetwork = async () => {
    try {
      await switchChainAsync({ chainId: targetChainId });
      await refreshWalletAndPositions(wallet.address);
    } catch {
      // user rejected chain switch
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
          liveRwaTelemetry={liveRwaTelemetry}
          liveCircuitBreaker={liveCircuitBreaker}
          onOpenWallet={() => {
            setWalletErr(undefined);
            setWalletModalOpen(true);
          }}
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
          onOpenWallet={() => {
            setWalletErr(undefined);
            setWalletModalOpen(true);
          }}
          onGoToTrade={() => setActiveTab("TRADE")}
          onRefresh={() => void refreshWalletAndPositions(wallet.address)}
        />
      )}

      <WalletModal
        open={walletModalOpen}
        locale={locale}
        wallet={wallet}
        walletOptions={walletOptions}
        connectingId={connectingId}
        errorMsg={walletErr}
        onClose={() => setWalletModalOpen(false)}
        onConnectOption={(w) => void handleConnectOption(w)}
        onDisconnect={() => void handleDisconnect()}
      />
    </div>
  );
}

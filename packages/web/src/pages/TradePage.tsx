import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  Clock,
  ExternalLink,
  Info,
  Loader2,
  Lock,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import {
  ASSET_SPECS,
  BSC_TESTNET,
  computeExpiryPayoffUsdt,
  estimateCustomTicketPreview,
  resolveClampedCustomRange,
  type AtlasFeedTelemetry,
  type CandleBar,
  type CandlePoint,
  type CloseRfqResponse,
  type CustomClampReason,
  type Direction,
  type ExpiryTenor,
  type PositionView,
  type RwaAssetTelemetry,
  type RwaMarketSession,
  type TicketSummary,
  type UnderlyingSymbol,
} from "@payoff/shared";
import {
  api,
  type ConsensusGuardState,
  type HealthResponse,
  type ShelfResponse,
} from "../lib/api";
import {
  formatExpiryDateTime,
  formatStrikePrice,
  resolveRwaTelemetry,
} from "../lib/format";
import { getCopy, type Locale } from "../lib/i18n";
import {
  createClientForRpc,
  ensureUsdtApproval,
  executeCloseTicketTx,
  executeOpenTicketTx,
  extractWalletErrorMessage,
  getExplorerBaseUrl,
  type ConnectedWallet,
} from "../lib/wallet";
import { KlineChart } from "../components/KlineChart";
import {
  OrderTicketPanel,
  type InstantBuyStage,
  type RangeMode,
  type SlippagePauseState,
} from "../components/OrderTicketPanel";
import {
  EarlyCloseModal,
  type CloseSlippagePauseState,
  type EarlyCloseStage,
} from "../components/EarlyCloseModal";
import { MarketSelector } from "../components/MarketPickerSheet";
import { RulesOracleSheet } from "../components/MarketRulesAccordion";
import { hasSeenOnboarding } from "../components/OnboardingSheet";
import type { MarketFocusTarget } from "../App";

interface Props {
  locale: Locale;
  wallet: ConnectedWallet;
  health?: HealthResponse;
  rpcUrl: string;
  positions: PositionView[];
  liveSpots: Record<UnderlyingSymbol, { spot: number; change24hPct: number }>;
  liveTelemetry: Partial<Record<UnderlyingSymbol, AtlasFeedTelemetry>>;
  liveRwaTelemetry: Partial<Record<UnderlyingSymbol, RwaAssetTelemetry>>;
  liveCircuitBreaker: Partial<Record<UnderlyingSymbol, ConsensusGuardState>>;
  marketFocus?: MarketFocusTarget | null;
  rulesSheetOpen: boolean;
  onOpenRules: () => void;
  onCloseRules: () => void;
  marketPickerOpen: boolean;
  onOpenMarketPicker: () => void;
  onCloseMarketPicker: () => void;
  onOpenOnboarding: () => void;
  onOpenWallet: () => void;
  onRefreshPositions: () => Promise<void> | void;
  onBatchClaim: (seriesIds: `0x${string}`[]) => Promise<void>;
  onClaimPosition: (position: PositionView) => Promise<void>;
  onManualSettle: (
    underlying: UnderlyingSymbol,
    expiry: number
  ) => Promise<{
    status: "SETTLED" | "ALREADY_SETTLED";
    twapPriceUsd?: number;
  }>;
}

const SLIPPAGE_TOLERANCE_RATIO = 0.985; // 1.5% adverse slippage circuit breaker
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function getTargetKey(t: Pick<TicketSummary, "lowerStrike" | "upperStrike">) {
  return `${t.lowerStrike}-${t.upperStrike}`;
}

function getPosId(pos: PositionView): string {
  return pos.tokenId || pos.seriesId;
}

function classifyUsMarketSessionFallback(nowMs: number): RwaMarketSession {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(nowMs));
    const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
    const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
    const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
    const mins = hour * 60 + minute;
    if (weekday === "Sat") return "WEEKEND";
    if (weekday === "Sun" && mins < 18 * 60) return "WEEKEND";
    if (weekday === "Fri" && mins >= 20 * 60) return "WEEKEND";
    if (weekday !== "Sun" && mins >= 9 * 60 + 30 && mins < 16 * 60) {
      return "RTH";
    }
    return "EXTENDED";
  } catch {
    return "EXTENDED";
  }
}

function formatExpiryTabLabel(
  expirySec: number | undefined,
  fallbackTenor: ExpiryTenor | "PRIOR",
  locale: Locale,
  isRwa: boolean
): string {
  const isZh = locale === "zh";
  if (!expirySec) {
    if (fallbackTenor === "DAILY") {
      return isZh
        ? isRwa
          ? "近期收盘"
          : "日度结算"
        : isRwa
          ? "Next Close"
          : "Daily";
    }
    if (fallbackTenor === "WEEKLY") {
      return isZh ? "周度结算" : "Weekly";
    }
    return isZh ? "前期持仓" : "Prior";
  }

  return formatExpiryDateTime(expirySec, locale);
}

function formatShortCountdown(expirySec: number, nowSec: number, isZh: boolean) {
  const rem = Math.max(0, expirySec - nowSec);
  if (rem === 0) return isZh ? "已到期" : "Expired";
  const m = Math.floor(rem / 60);
  const s = rem % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

interface ExpiryCountdownInfo {
  expired: boolean;
  remainingSec: number;
  text: string;
}

function formatExpiryCountdownInfo(
  expirySec: number | undefined,
  nowSec: number,
  isZh: boolean
): ExpiryCountdownInfo | null {
  if (!expirySec) return null;
  const rem = Math.max(0, expirySec - nowSec);
  if (rem === 0) {
    return {
      expired: true,
      remainingSec: 0,
      text: isZh ? "已到期" : "Expired",
    };
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  const days = Math.floor(rem / 86400);
  const hoursInDay = Math.floor((rem % 86400) / 3600);
  const totalHours = Math.floor(rem / 3600);
  const mins = Math.floor((rem % 3600) / 60);
  const secs = rem % 60;

  if (rem >= 48 * 3600) {
    return {
      expired: false,
      remainingSec: rem,
      text: isZh
        ? `${days}天 ${pad(hoursInDay)}时 ${pad(mins)}分`
        : `${days}d ${pad(hoursInDay)}h ${pad(mins)}m`,
    };
  }
  if (totalHours > 0) {
    return {
      expired: false,
      remainingSec: rem,
      text: isZh
        ? `${pad(totalHours)}:${pad(mins)}:${pad(secs)}`
        : `${totalHours}h ${pad(mins)}m ${pad(secs)}s`,
    };
  }
  return {
    expired: false,
    remainingSec: rem,
    text: isZh ? `${pad(mins)}:${pad(secs)}` : `${mins}m ${pad(secs)}s`,
  };
}

function formatSignedUsd(v: number): string {
  const sign = v >= 0 ? "+" : "−";
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

interface ExpiryTabItem {
  id: string;
  kind: "OPEN_DAILY" | "OPEN_WEEKLY" | "PRIOR";
  tenor?: ExpiryTenor;
  expiry?: number;
  label: string;
  hasPositions: boolean;
  hasTwapOrAwaiting: boolean;
  hasClaimable: boolean;
}

export function TradePage({
  locale,
  wallet,
  health,
  rpcUrl,
  positions,
  liveSpots,
  liveTelemetry,
  liveRwaTelemetry,
  liveCircuitBreaker,
  marketFocus,
  rulesSheetOpen,
  onOpenRules,
  onCloseRules,
  marketPickerOpen,
  onOpenMarketPicker,
  onCloseMarketPicker,
  onOpenOnboarding,
  onOpenWallet,
  onRefreshPositions,
  onBatchClaim,
  onManualSettle,
}: Props) {
  const isZh = locale === "zh";
  const t = getCopy(locale);

  const [underlying, setUnderlying] = useState<UnderlyingSymbol>("BTC");
  const [direction, setDirection] = useState<Direction>("BULL");
  const [tenor, setTenor] = useState<ExpiryTenor>("DAILY");
  const [selectedPriorExpiry, setSelectedPriorExpiry] = useState<number | null>(
    null
  );
  const [stakeUsdt, setStakeUsdt] = useState<number>(20);
  const [candles, setCandles] = useState<CandlePoint[]>([]);

  const [shelf, setShelf] = useState<ShelfResponse | null>(null);
  const [tenorExpiries, setTenorExpiries] = useState<
    Partial<Record<ExpiryTenor, number>>
  >({});
  const [selectedTargetKey, setSelectedTargetKey] = useState<string>("");
  const [rangeMode, setRangeMode] = useState<RangeMode>("QUICK");
  const [customRange, setCustomRange] = useState<{
    startPrice: number;
    capPrice: number;
  } | null>(null);
  const [customClampState, setCustomClampState] = useState<{
    reason: CustomClampReason;
    startClamped: boolean;
    capClamped: boolean;
  }>({ reason: "NONE", startClamped: false, capClamped: false });
  const [customServerEntry, setCustomServerEntry] = useState<{
    ticket: TicketSummary;
    shelfRef: ShelfResponse;
  } | null>(null);
  const [customSyncing, setCustomSyncing] = useState(false);
  const [shelfReloadTick, setShelfReloadTick] = useState(0);
  const customReqSeqRef = useRef(0);
  const lastDriftReloadMsRef = useRef(0);

  const [stage, setStage] = useState<InstantBuyStage>("IDLE");
  const [slippagePause, setSlippagePause] = useState<
    SlippagePauseState | undefined
  >();
  const [txHash, setTxHash] = useState<string | undefined>();
  const [errorMsg, setErrorMsg] = useState<string | undefined>();
  const [toast, setToast] = useState<{
    kind: "ok" | "err";
    text: string;
    txHash?: string;
  } | null>(null);

  const [selectedPositionId, setSelectedPositionId] = useState<string | null>(
    null
  );
  const [scrubPrice, setScrubPrice] = useState<number | null>(null);

  // B4 Early Close Modal state
  const [closingPos, setClosingPos] = useState<PositionView | null>(null);
  const [closeStage, setCloseStage] = useState<EarlyCloseStage>("IDLE");
  const [closeSlippagePause, setCloseSlippagePause] = useState<
    CloseSlippagePauseState | undefined
  >();
  const [closeErr, setCloseErr] = useState<string | undefined>();

  // C2 / C4 Settlement & Batch Claim state
  const [settlingBusy, setSettlingBusy] = useState(false);
  const [settleErr, setSettleErr] = useState<string | undefined>();
  const [claimingBusy, setClaimingBusy] = useState(false);
  const [claimErr, setClaimErr] = useState<string | undefined>();
  const [dismissedMissKey, setDismissedMissKey] = useState<string | null>(null);

  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window !== "undefined"
      ? window.matchMedia("(min-width: 1024px)").matches
      : false
  );

  const contractsRef = useRef<{
    vaultAddress?: `0x${string}`;
    usdtAddress?: `0x${string}`;
  }>({});
  const stageRef = useRef<InstantBuyStage>(stage);
  stageRef.current = stage;
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const onboardingCheckedRef = useRef(false);

  // Sync desktop breakpoint for responsive chart height (compact on mobile so CTA fits above fold)
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const sync = () => setIsDesktop(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  // First-visit A1 OnboardingSheet auto-trigger using localStorage (StrictMode-safe)
  useEffect(() => {
    if (onboardingCheckedRef.current) return;
    if (hasSeenOnboarding()) {
      onboardingCheckedRef.current = true;
      return;
    }
    const id = window.setTimeout(() => {
      if (onboardingCheckedRef.current) return;
      onboardingCheckedRef.current = true;
      if (!hasSeenOnboarding()) {
        onOpenOnboarding();
      }
    }, 350);
    return () => window.clearTimeout(id);
  }, [onOpenOnboarding]);

  useEffect(() => {
    if (health) {
      contractsRef.current = {
        vaultAddress: health.vaultAddress,
        usdtAddress:
          health.usdtAddress && health.usdtAddress !== ZERO_ADDRESS
            ? health.usdtAddress
            : BSC_TESTNET.usdtAddress,
      };
    }
  }, [health]);

  useEffect(() => {
    const id = setInterval(() => {
      setNowSec(Math.floor(Date.now() / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // Sync external focus requests (e.g. clicking an expiry group inside WalletModal B6 drawer)
  const pendingFocusExpiryRef = useRef<number | null>(null);
  useEffect(() => {
    if (!marketFocus) return;
    setUnderlying(marketFocus.underlying);
    setSelectedTargetKey("");
    setCustomRange(null);
    setCustomClampState({
      reason: "NONE",
      startClamped: false,
      capClamped: false,
    });
    setCustomServerEntry(null);
    setCustomSyncing(false);
    setSelectedPositionId(null);
    setScrubPrice(null);
    pendingFocusExpiryRef.current = marketFocus.expiry;

    if (
      tenorExpiries.DAILY &&
      marketFocus.expiry === tenorExpiries.DAILY &&
      marketFocus.underlying === underlying
    ) {
      setTenor("DAILY");
      setSelectedPriorExpiry(null);
      pendingFocusExpiryRef.current = null;
    } else if (
      tenorExpiries.WEEKLY &&
      marketFocus.expiry === tenorExpiries.WEEKLY &&
      marketFocus.underlying === underlying
    ) {
      setTenor("WEEKLY");
      setSelectedPriorExpiry(null);
      pendingFocusExpiryRef.current = null;
    } else {
      setSelectedPriorExpiry(marketFocus.expiry);
    }
  }, [marketFocus, tenorExpiries.DAILY, tenorExpiries.WEEKLY, underlying]);

  // Fetch both DAILY & WEEKLY expiry timestamps when underlying changes so both tabs show real times
  useEffect(() => {
    let cancelled = false;
    setTenorExpiries({});
    Promise.all([
      api
        .getShelf({ underlying, direction: "BULL", tenor: "DAILY", stakeUsdt: 20 })
        .catch(() => null),
      api
        .getShelf({
          underlying,
          direction: "BULL",
          tenor: "WEEKLY",
          stakeUsdt: 20,
        })
        .catch(() => null),
    ]).then(([dailyRes, weeklyRes]) => {
      if (cancelled) return;
      const next: Partial<Record<ExpiryTenor, number>> = {
        DAILY: dailyRes?.expiry,
        WEEKLY: weeklyRes?.expiry,
      };
      setTenorExpiries(next);

      const pending = pendingFocusExpiryRef.current;
      if (pending !== null) {
        if (next.DAILY === pending) {
          setTenor("DAILY");
          setSelectedPriorExpiry(null);
        } else if (next.WEEKLY === pending) {
          setTenor("WEEKLY");
          setSelectedPriorExpiry(null);
        } else {
          setSelectedPriorExpiry(pending);
        }
        pendingFocusExpiryRef.current = null;
      }
    });
    return () => {
      cancelled = true;
    };
  }, [underlying]);

  // Active fixed-grid shelf feed
  useEffect(() => {
    let cancelled = false;
    const loadShelf = (isBackground: boolean) => {
      if (isBackground && stageRef.current !== "IDLE") return;
      api
        .getShelf({ underlying, direction, tenor, stakeUsdt })
        .then((res) => {
          if (cancelled) return;
          setShelf(res);
          setTenorExpiries((prev) =>
            prev[tenor] === res.expiry ? prev : { ...prev, [tenor]: res.expiry }
          );
          if (!isBackground) {
            setSlippagePause(undefined);
            setStage("IDLE");
            setErrorMsg(undefined);
          }
        })
        .catch((err) => {
          if (!cancelled && !isBackground) setErrorMsg(err.message);
        });
    };
    loadShelf(false);
    const timer = setInterval(() => loadShelf(true), 25_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [underlying, direction, tenor, stakeUsdt, shelfReloadTick]);

  const assetSpec = ASSET_SPECS[underlying];
  const isRwaAsset = assetSpec.assetClass === "RWA_EQUITY";
  const explorerBase = getExplorerBaseUrl(
    health?.chainId ?? wallet.chainId ?? BSC_TESTNET.chainId
  );

  // Build expiry tabs: any prior closed expiries with user positions + open DAILY + open WEEKLY
  const openDailyExpiry =
    tenor === "DAILY" ? shelf?.expiry ?? tenorExpiries.DAILY : tenorExpiries.DAILY;
  const openWeeklyExpiry =
    tenor === "WEEKLY"
      ? shelf?.expiry ?? tenorExpiries.WEEKLY
      : tenorExpiries.WEEKLY;

  const underlyingPositions = useMemo(
    () =>
      positions.filter(
        (p) =>
          p.underlying === underlying &&
          (p.status === "ACTIVE" || p.status === "SETTLED_CLAIMABLE")
      ),
    [positions, underlying]
  );

  const expiryTabs = useMemo<ExpiryTabItem[]>(() => {
    const knownOpen = new Set<number>();
    if (openDailyExpiry) knownOpen.add(openDailyExpiry);
    if (openWeeklyExpiry) knownOpen.add(openWeeklyExpiry);

    const priorExpirySet = new Set<number>();
    for (const p of underlyingPositions) {
      if (!knownOpen.has(p.expiry)) {
        priorExpirySet.add(p.expiry);
      }
    }
    const sortedPrior = Array.from(priorExpirySet).sort((a, b) => a - b);

    const summarize = (exp?: number) => {
      if (!exp) {
        return {
          hasPositions: false,
          hasTwapOrAwaiting: false,
          hasClaimable: false,
        };
      }
      const matching = underlyingPositions.filter((p) => p.expiry === exp);
      return {
        hasPositions: matching.length > 0,
        hasTwapOrAwaiting: matching.some(
          (p) =>
            p.status === "ACTIVE" && (p.inTwapWindow || p.awaitingSettlement)
        ),
        hasClaimable: matching.some((p) => p.status === "SETTLED_CLAIMABLE"),
      };
    };

    const list: ExpiryTabItem[] = [];
    for (const exp of sortedPrior) {
      const meta = summarize(exp);
      list.push({
        id: `PRIOR:${exp}`,
        kind: "PRIOR",
        expiry: exp,
        label: formatExpiryTabLabel(exp, "PRIOR", locale, isRwaAsset),
        ...meta,
      });
    }

    const dailyMeta = summarize(openDailyExpiry);
    list.push({
      id: "OPEN_DAILY",
      kind: "OPEN_DAILY",
      tenor: "DAILY",
      expiry: openDailyExpiry,
      label: formatExpiryTabLabel(openDailyExpiry, "DAILY", locale, isRwaAsset),
      ...dailyMeta,
    });

    if (!openWeeklyExpiry || openWeeklyExpiry !== openDailyExpiry) {
      const weeklyMeta = summarize(openWeeklyExpiry);
      list.push({
        id: "OPEN_WEEKLY",
        kind: "OPEN_WEEKLY",
        tenor: "WEEKLY",
        expiry: openWeeklyExpiry,
        label: formatExpiryTabLabel(
          openWeeklyExpiry,
          "WEEKLY",
          locale,
          isRwaAsset
        ),
        ...weeklyMeta,
      });
    }

    return list;
  }, [
    openDailyExpiry,
    openWeeklyExpiry,
    underlyingPositions,
    locale,
    isRwaAsset,
  ]);

  // If a prior expiry no longer has any positions (e.g. just claimed or sold), bounce back to DAILY cleanly
  useEffect(() => {
    if (selectedPriorExpiry === null) return;
    const stillExists = expiryTabs.some(
      (tab) => tab.kind === "PRIOR" && tab.expiry === selectedPriorExpiry
    );
    if (!stillExists && pendingFocusExpiryRef.current === null) {
      setSelectedPriorExpiry(null);
    }
  }, [expiryTabs, selectedPriorExpiry]);

  const activeTabId =
    selectedPriorExpiry !== null
      ? `PRIOR:${selectedPriorExpiry}`
      : tenor === "DAILY"
        ? "OPEN_DAILY"
        : "OPEN_WEEKLY";

  const isPriorExpiry = selectedPriorExpiry !== null;
  const currentExpiry = isPriorExpiry
    ? selectedPriorExpiry
    : tenor === "DAILY"
      ? openDailyExpiry ?? shelf?.expiry
      : openWeeklyExpiry ?? shelf?.expiry;

  const activeExpiryTab = useMemo(
    () => expiryTabs.find((tab) => tab.id === activeTabId),
    [expiryTabs, activeTabId]
  );

  // Auto-match historical candle window to active expiry (24H for Daily, 7D for Weekly)
  const useWeeklyWindow = useMemo(() => {
    const nowSnapshot = Math.floor(Date.now() / 1000);
    const remSec = currentExpiry ? Math.max(0, currentExpiry - nowSnapshot) : null;
    if (isPriorExpiry) {
      return remSec !== null && remSec > 36 * 3600;
    }
    if (tenor === "WEEKLY") return true;
    return remSec !== null && remSec > 36 * 3600;
  }, [isPriorExpiry, tenor, currentExpiry]);

  const autoBar: CandleBar = useWeeklyWindow ? "1H" : "15m";
  const autoLimit = useWeeklyWindow ? 168 : 96;
  const autoWindowSec = useWeeklyWindow ? 7 * 24 * 3600 : 24 * 3600;
  const autoWindowLabel = useWeeklyWindow
    ? isZh
      ? "近 7 天"
      : "7D"
    : isZh
      ? "近 24 小时"
      : "24H";

  // Auto-matched candles feed (sliced cleanly to 24H or 7D target window)
  useEffect(() => {
    let cancelled = false;
    const loadCandles = () => {
      api
        .getCandles({ underlying, bar: autoBar, limit: autoLimit })
        .then((res) => {
          if (cancelled) return;
          const cutoff = Math.floor(Date.now() / 1000) - autoWindowSec;
          const filtered = res.candles.filter((c) => c.time >= cutoff);
          setCandles(
            filtered.length >= 2 ? filtered : res.candles.slice(-autoLimit)
          );
        })
        .catch(() => {});
    };
    loadCandles();
    const timer = setInterval(loadCandles, 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [underlying, autoBar, autoLimit, autoWindowSec]);

  // Positions scoped to current underlying + selected expiry
  const currentExpiryActivePositions = useMemo(
    () =>
      currentExpiry
        ? positions.filter(
            (p) =>
              p.underlying === underlying &&
              p.expiry === currentExpiry &&
              p.status === "ACTIVE" &&
              p.remainingBalanceUsdt > 0
          )
        : [],
    [positions, underlying, currentExpiry]
  );

  const currentExpiryClaimablePositions = useMemo(
    () =>
      currentExpiry
        ? positions.filter(
            (p) =>
              p.underlying === underlying &&
              p.expiry === currentExpiry &&
              p.status === "SETTLED_CLAIMABLE"
          )
        : [],
    [positions, underlying, currentExpiry]
  );

  // Active shelf ticket calculation (Quick fine-grained tiers + Custom dual-slider preview)
  const quickTiers = useMemo(
    () =>
      shelf?.quickTiers && shelf.quickTiers.length > 0
        ? shelf.quickTiers
        : (shelf?.tiers ?? []),
    [shelf?.quickTiers, shelf?.tiers]
  );
  const defaultQuickIdx = Math.min(
    Math.max(
      0,
      shelf?.grid?.defaultQuickIndex ?? shelf?.grid?.defaultIndex ?? 1
    ),
    Math.max(0, quickTiers.length - 1)
  );
  const isShelfContextSynced = Boolean(
    shelf &&
      shelf.underlying === underlying &&
      shelf.direction === direction &&
      shelf.tenor === tenor
  );
  const isShelfSynced = Boolean(
    isShelfContextSynced &&
      shelf &&
      Math.abs(shelf.stakeUsdt - stakeUsdt) < 1e-6
  );
  const quickTicket: TicketSummary | undefined =
    quickTiers.find((item) => getTargetKey(item) === selectedTargetKey) ??
    quickTiers[defaultQuickIdx] ??
    quickTiers[0];

  const resolvedCustomSelection = useMemo(() => {
    if (
      rangeMode !== "CUSTOM" ||
      !isShelfContextSynced ||
      !shelf?.customConfig
    ) {
      return null;
    }
    const desiredStart =
      customRange?.startPrice ??
      quickTicket?.startPrice ??
      shelf.customConfig.defaultStart;
    const desiredCap =
      customRange?.capPrice ??
      quickTicket?.capPrice ??
      shelf.customConfig.defaultCap;
    return resolveClampedCustomRange({
      config: shelf.customConfig,
      direction,
      desiredStart,
      desiredCap,
    });
  }, [
    rangeMode,
    isShelfContextSynced,
    shelf?.customConfig,
    customRange,
    quickTicket?.startPrice,
    quickTicket?.capPrice,
    direction,
  ]);

  const customInstantTicket = useMemo<TicketSummary | undefined>(() => {
    if (
      rangeMode !== "CUSTOM" ||
      !isShelfContextSynced ||
      !shelf?.customConfig ||
      !resolvedCustomSelection
    ) {
      return undefined;
    }
    return estimateCustomTicketPreview({
      underlying,
      direction,
      tenor,
      expiry: shelf.expiry,
      availableStrikes: shelf.availableStrikes,
      lowerStrike: resolvedCustomSelection.lowerStrike,
      upperStrike: resolvedCustomSelection.upperStrike,
      stakeUsdt,
      config: shelf.customConfig,
    });
  }, [
    rangeMode,
    isShelfContextSynced,
    shelf,
    resolvedCustomSelection,
    underlying,
    direction,
    tenor,
    stakeUsdt,
  ]);

  // Debounced server-side Custom preview reconciliation (preserves exact live Atlas spot, ThetaData IV skew & book mids)
  useEffect(() => {
    if (
      rangeMode !== "CUSTOM" ||
      !isShelfContextSynced ||
      !shelf ||
      !resolvedCustomSelection
    ) {
      customReqSeqRef.current += 1;
      setCustomSyncing(false);
      return;
    }

    const activeShelf = shelf;
    const { lowerStrike, upperStrike } = resolvedCustomSelection;
    const reqId = ++customReqSeqRef.current;
    setCustomSyncing(true);
    const timer = window.setTimeout(() => {
      api
        .previewCustom({
          underlying,
          direction,
          tenor,
          lowerStrike,
          upperStrike,
          stakeUsdt,
        })
        .then((res) => {
          if (reqId !== customReqSeqRef.current) return;
          setCustomServerEntry({ ticket: res.ticket, shelfRef: activeShelf });
          setCustomSyncing(false);
          // If live Atlas spot drifted past fair bounds between 25s shelf polls, refresh shelf immediately to re-clamp
          if (!res.ticket.guardrails.valid) {
            const nowMs = Date.now();
            if (nowMs - lastDriftReloadMsRef.current > 2_000) {
              lastDriftReloadMsRef.current = nowMs;
              setShelfReloadTick((n) => n + 1);
            }
          }
        })
        .catch(() => {
          if (reqId !== customReqSeqRef.current) return;
          setCustomSyncing(false);
        });
    }, 100);

    return () => {
      customReqSeqRef.current += 1;
      window.clearTimeout(timer);
    };
  }, [
    rangeMode,
    isShelfContextSynced,
    shelf,
    underlying,
    direction,
    tenor,
    resolvedCustomSelection?.lowerStrike,
    resolvedCustomSelection?.upperStrike,
    stakeUsdt,
  ]);

  const customServerTicket = customServerEntry?.ticket ?? null;
  const isCustomServerTicketMatched = Boolean(
    customServerEntry &&
      customServerTicket &&
      resolvedCustomSelection &&
      shelf &&
      customServerEntry.shelfRef === shelf &&
      customServerTicket.underlying === underlying &&
      customServerTicket.direction === direction &&
      customServerTicket.tenor === tenor &&
      customServerTicket.expiry === shelf.expiry &&
      Math.abs(customServerTicket.lowerStrike - resolvedCustomSelection.lowerStrike) < 1e-6 &&
      Math.abs(customServerTicket.upperStrike - resolvedCustomSelection.upperStrike) < 1e-6 &&
      Math.abs(customServerTicket.stakeUsdt - stakeUsdt) < 0.015
  );

  const activeTicket: TicketSummary | undefined =
    rangeMode === "CUSTOM" && isShelfContextSynced && resolvedCustomSelection
      ? isCustomServerTicketMatched && customServerTicket
        ? customServerTicket
        : customInstantTicket ?? quickTicket
      : quickTicket;
  const isActiveTicketReady =
    rangeMode === "CUSTOM"
      ? Boolean(
          isShelfContextSynced &&
            resolvedCustomSelection &&
            activeTicket &&
            Math.abs(activeTicket.stakeUsdt - stakeUsdt) < 0.015
        )
      : isShelfSynced;
  const effectiveCustomClamp =
    resolvedCustomSelection && resolvedCustomSelection.clampReason !== "NONE"
      ? {
          reason: resolvedCustomSelection.clampReason,
          startClamped: resolvedCustomSelection.startClamped,
          capClamped: resolvedCustomSelection.capClamped,
        }
      : customClampState;
  const effectiveTargetKey = quickTicket ? getTargetKey(quickTicket) : "";

  const resetFlowState = useCallback(() => {
    setSlippagePause(undefined);
    setStage("IDLE");
    setTxHash(undefined);
    setErrorMsg(undefined);
  }, []);

  const clearCustomSelection = useCallback(() => {
    setCustomRange(null);
    setCustomClampState({
      reason: "NONE",
      startClamped: false,
      capClamped: false,
    });
    setCustomServerEntry(null);
    setCustomSyncing(false);
  }, []);

  const handleSwitchUnderlying = (u: UnderlyingSymbol) => {
    if (u === underlying) return;
    setUnderlying(u);
    setSelectedPriorExpiry(null);
    setSelectedTargetKey("");
    clearCustomSelection();
    setSelectedPositionId(null);
    setScrubPrice(null);
    setSettleErr(undefined);
    setClaimErr(undefined);
    resetFlowState();
  };

  const handleSwitchDirection = (dir: Direction) => {
    if (dir === direction) return;
    setDirection(dir);
    setSelectedTargetKey("");
    clearCustomSelection();
    resetFlowState();
  };

  const handleSelectExpiryTab = (tab: ExpiryTabItem) => {
    setSelectedPositionId(null);
    setScrubPrice(null);
    setSettleErr(undefined);
    setClaimErr(undefined);
    if (tab.kind === "PRIOR" && tab.expiry) {
      setSelectedPriorExpiry(tab.expiry);
    } else if (tab.tenor) {
      setSelectedPriorExpiry(null);
      if (tab.tenor !== tenor) {
        setTenor(tab.tenor);
        setSelectedTargetKey("");
        clearCustomSelection();
        resetFlowState();
      }
    }
  };

  const handleTabKeyDown = (
    e: KeyboardEvent<HTMLButtonElement>,
    index: number
  ) => {
    if (expiryTabs.length <= 1) return;
    let nextIdx: number | null = null;
    if (e.key === "ArrowRight") {
      nextIdx = (index + 1) % expiryTabs.length;
    } else if (e.key === "ArrowLeft") {
      nextIdx = (index - 1 + expiryTabs.length) % expiryTabs.length;
    } else if (e.key === "Home") {
      nextIdx = 0;
    } else if (e.key === "End") {
      nextIdx = expiryTabs.length - 1;
    }
    if (nextIdx !== null) {
      e.preventDefault();
      const targetTab = expiryTabs[nextIdx];
      handleSelectExpiryTab(targetTab);
      tabRefs.current[nextIdx]?.focus();
      tabRefs.current[nextIdx]?.scrollIntoView({
        block: "nearest",
        inline: "nearest",
      });
    }
  };

  const handleSelectTarget = (item: TicketSummary) => {
    setSelectedTargetKey(getTargetKey(item));
    setSelectedPositionId(null);
    setScrubPrice(null);
    resetFlowState();
  };

  const handleChangeRangeMode = (nextMode: RangeMode) => {
    if (nextMode === rangeMode) return;
    setSelectedPositionId(null);
    setScrubPrice(null);
    if (nextMode === "CUSTOM") {
      if (quickTicket) {
        setCustomRange({
          startPrice: quickTicket.startPrice,
          capPrice: quickTicket.capPrice,
        });
      }
      setCustomClampState({
        reason: "NONE",
        startClamped: false,
        capClamped: false,
      });
      setRangeMode("CUSTOM");
      resetFlowState();
      return;
    }

    // Returning to Quick mode: preserve closest Target cap on the Quick slider
    if (resolvedCustomSelection && quickTiers.length > 0) {
      const exact = quickTiers.find(
        (item) =>
          Math.abs(item.lowerStrike - resolvedCustomSelection.lowerStrike) < 1e-6 &&
          Math.abs(item.upperStrike - resolvedCustomSelection.upperStrike) < 1e-6
      );
      if (exact) {
        setSelectedTargetKey(getTargetKey(exact));
      } else {
        const nearest = quickTiers.reduce((best, item) =>
          Math.abs(item.capPrice - resolvedCustomSelection.capPrice) <
          Math.abs(best.capPrice - resolvedCustomSelection.capPrice)
            ? item
            : best
        );
        setSelectedTargetKey(getTargetKey(nearest));
      }
    }
    setCustomClampState({
      reason: "NONE",
      startClamped: false,
      capClamped: false,
    });
    setCustomServerEntry(null);
    setCustomSyncing(false);
    setRangeMode("QUICK");
    resetFlowState();
  };

  const handleChangeCustomStart = (nextStart: number) => {
    if (!shelf?.customConfig || !isShelfContextSynced) return;
    const currentCap =
      resolvedCustomSelection?.capPrice ??
      customRange?.capPrice ??
      shelf.customConfig.defaultCap;
    const clamped = resolveClampedCustomRange({
      config: shelf.customConfig,
      direction,
      desiredStart: nextStart,
      desiredCap: currentCap,
    });
    if (!clamped) return;
    setSelectedPositionId(null);
    setScrubPrice(null);
    setCustomRange({
      startPrice: clamped.startPrice,
      capPrice: clamped.capPrice,
    });
    setCustomClampState({
      reason: clamped.clampReason,
      startClamped: clamped.startClamped,
      capClamped: clamped.capClamped,
    });
    resetFlowState();
  };

  const handleChangeCustomCap = (nextCap: number) => {
    if (!shelf?.customConfig || !isShelfContextSynced) return;
    const currentStart =
      resolvedCustomSelection?.startPrice ??
      customRange?.startPrice ??
      shelf.customConfig.defaultStart;
    const clamped = resolveClampedCustomRange({
      config: shelf.customConfig,
      direction,
      desiredStart: currentStart,
      desiredCap: nextCap,
    });
    if (!clamped) return;
    setSelectedPositionId(null);
    setScrubPrice(null);
    setCustomRange({
      startPrice: clamped.startPrice,
      capPrice: clamped.capPrice,
    });
    setCustomClampState({
      reason: clamped.clampReason,
      startClamped: clamped.startClamped,
      capClamped: clamped.capClamped,
    });
    resetFlowState();
  };

  const formatTradeError = (err: any, fallback: string): string => {
    const errName = String(
      err?.cause?.data?.errorName || err?.data?.errorName || ""
    );
    const extracted = extractWalletErrorMessage(err, fallback);
    const full = `${errName} ${extracted} ${err?.shortMessage || ""} ${err?.message || ""}`;
    if (
      full.includes("自成交") ||
      full.includes("SelfTradeNotAllowed") ||
      full.toLowerCase().includes("self-trade") ||
      full.includes("taker 与 maker")
    ) {
      return t.selfTradeError;
    }
    if (full.includes("QuoteExpired") || full.includes("0x8727a7f9")) {
      return t.quoteExpiredError;
    }
    return extracted;
  };

  const fillOpenRfqOnChain = async (
    rfq: SlippagePauseState["rfq"],
    sharedClient?: ReturnType<typeof createClientForRpc>
  ) => {
    if (rfq.quote.validUntil <= Math.floor(Date.now() / 1000)) {
      throw new Error("QuoteExpired");
    }
    setStage("FILLING");
    setErrorMsg(undefined);
    const hash = await executeOpenTicketTx({
      wallet,
      rpcUrl,
      rfq,
      onStage: (st) => setStage(st === "APPROVING" ? "APPROVING" : "FILLING"),
      publicClient: sharedClient,
    });
    setSlippagePause(undefined);
    setTxHash(hash);
    await api.ingestTx(hash).catch(() => api.syncChain());
    await onRefreshPositions();

    // Stay on TradePage — show dark confirmation toast, keep form ready
    setStage("IDLE");
    setToast({
      kind: "ok",
      text: t.buySuccess,
      txHash: hash,
    });
  };

  const handleInstantBuy = async () => {
    if (!wallet.address || !activeTicket || !isActiveTicketReady) return;
    setErrorMsg(undefined);
    setTxHash(undefined);
    setSlippagePause(undefined);
    setToast(null);

    const previewMaxPayoutUsdt = activeTicket.maxPayoutUsdt;

    try {
      const publicClient = createClientForRpc(wallet.chainId, rpcUrl);
      let { vaultAddress, usdtAddress } = contractsRef.current;
      if (!vaultAddress || !usdtAddress || usdtAddress === ZERO_ADDRESS) {
        const h = await api.getHealth();
        vaultAddress = h.vaultAddress;
        usdtAddress =
          h.usdtAddress && h.usdtAddress !== ZERO_ADDRESS
            ? h.usdtAddress
            : BSC_TESTNET.usdtAddress;
        contractsRef.current = { vaultAddress, usdtAddress };
      }

      if (
        vaultAddress &&
        vaultAddress !== ZERO_ADDRESS &&
        usdtAddress &&
        usdtAddress !== ZERO_ADDRESS
      ) {
        await ensureUsdtApproval({
          wallet,
          rpcUrl,
          usdtAddress,
          spender: vaultAddress,
          amountUsdt: stakeUsdt,
          onApproving: () => setStage("APPROVING"),
          publicClient,
        });
      }

      setStage("QUOTING");
      const rfq = await api.requestOpenRfq({
        taker: wallet.address,
        underlying,
        direction,
        tenor,
        tierKind: rangeMode === "CUSTOM" ? "CUSTOM" : activeTicket.tierKind,
        lowerStrike: activeTicket.lowerStrike,
        upperStrike: activeTicket.upperStrike,
        stakeUsdt,
      });

      const firmMaxPayoutUsdt = rfq.ticket.maxPayoutUsdt;
      if (
        previewMaxPayoutUsdt > 0 &&
        firmMaxPayoutUsdt < previewMaxPayoutUsdt * SLIPPAGE_TOLERANCE_RATIO
      ) {
        const dropPct =
          ((previewMaxPayoutUsdt - firmMaxPayoutUsdt) / previewMaxPayoutUsdt) *
          100;
        setSlippagePause({
          rfq,
          previewMaxPayoutUsdt,
          firmMaxPayoutUsdt,
          dropPct,
        });
        setStage("SLIPPAGE_CONFIRM");
        return;
      }

      await fillOpenRfqOnChain(rfq, publicClient);
    } catch (err: any) {
      setStage("IDLE");
      setErrorMsg(formatTradeError(err, "Transaction failed"));
    }
  };

  const handleConfirmSlippageQuote = async () => {
    if (!slippagePause) return;
    try {
      await fillOpenRfqOnChain(slippagePause.rfq);
    } catch (err: any) {
      setStage("SLIPPAGE_CONFIRM");
      setErrorMsg(formatTradeError(err, "Transaction failed"));
    }
  };

  // B4 Early Close handlers
  const activeClosingPos = closingPos
    ? positions.find(
        (p) =>
          p.seriesId === closingPos.seriesId && p.isUp === closingPos.isUp
      ) ?? closingPos
    : null;

  const handleOpenEarlyClose = (pos: PositionView) => {
    setClosingPos(pos);
    setCloseStage("IDLE");
    setCloseSlippagePause(undefined);
    setCloseErr(undefined);
  };

  const fillCloseRfqOnChain = async (rfq: CloseRfqResponse) => {
    if (rfq.quote.validUntil <= Math.floor(Date.now() / 1000)) {
      throw new Error("QuoteExpired");
    }
    setCloseStage("EXECUTING");
    setCloseErr(undefined);
    const hash = await executeCloseTicketTx({
      wallet,
      rpcUrl,
      rfq,
    });
    await api.ingestTx(hash).catch(() => api.syncChain());
    setClosingPos(null);
    setCloseSlippagePause(undefined);
    setCloseStage("IDLE");
    setSelectedPositionId(null);
    setToast({
      kind: "ok",
      text: isZh
        ? `已卖出落袋 $${rfq.netProceedsUsdt.toFixed(2)}`
        : `Sold early for $${rfq.netProceedsUsdt.toFixed(2)}`,
      txHash: hash,
    });
    await onRefreshPositions();
  };

  const handleInstantSell = async (pos: PositionView, ratio: number) => {
    if (!wallet.address) return;
    setCloseStage("QUOTING");
    setCloseErr(undefined);
    setCloseSlippagePause(undefined);

    const estimatedUsdt = pos.indicativeExitUsdt * ratio;
    const closeAmountUsdt =
      ratio >= 0.995 ? undefined : pos.remainingBalanceUsdt * ratio;

    try {
      const rfq = await api.requestCloseRfq({
        taker: wallet.address,
        seriesId: pos.seriesId,
        isUp: pos.isUp,
        closeAmountUsdt,
      });

      if (
        estimatedUsdt > 0 &&
        rfq.netProceedsUsdt < estimatedUsdt * SLIPPAGE_TOLERANCE_RATIO
      ) {
        const dropPct =
          ((estimatedUsdt - rfq.netProceedsUsdt) / estimatedUsdt) * 100;
        setCloseSlippagePause({
          rfq,
          estimatedUsdt,
          firmUsdt: rfq.netProceedsUsdt,
          dropPct,
        });
        setCloseStage("SLIPPAGE_CONFIRM");
        return;
      }

      await fillCloseRfqOnChain(rfq);
    } catch (err: any) {
      setCloseStage("IDLE");
      setCloseErr(formatTradeError(err, "Close failed"));
    }
  };

  const handleConfirmSlippageClose = async () => {
    if (!closeSlippagePause) return;
    try {
      await fillCloseRfqOnChain(closeSlippagePause.rfq);
    } catch (err: any) {
      setCloseStage("SLIPPAGE_CONFIRM");
      setCloseErr(formatTradeError(err, "Close failed"));
    }
  };

  // C2 Manual Settlement handler
  const handleTriggerManualSettle = async () => {
    if (!currentExpiry || settlingBusy) return;
    setSettlingBusy(true);
    setSettleErr(undefined);
    try {
      const res = await onManualSettle(underlying, currentExpiry);
      if (res.status === "ALREADY_SETTLED") {
        setToast({ kind: "ok", text: t.settleAlreadyDone });
      } else {
        setToast({
          kind: "ok",
          text: t.settleTwapSuccess(
            assetSpec.displaySymbol,
            res.twapPriceUsd
              ? formatStrikePrice(res.twapPriceUsd, underlying)
              : "--"
          ),
        });
      }
    } catch (err: any) {
      setSettleErr(formatTradeError(err, "Settlement failed"));
    } finally {
      setSettlingBusy(false);
    }
  };

  // C4 Batch Claim handler
  const handleClaimCurrentExpiry = async () => {
    if (claimingBusy || currentExpiryClaimablePositions.length === 0) return;
    const claimableList = currentExpiryClaimablePositions.filter(
      (p) => p.claimableUsdt > 0
    );
    const seriesIds = Array.from(
      new Set(claimableList.map((p) => p.seriesId))
    ) as `0x${string}`[];
    if (seriesIds.length === 0) return;
    const totalAmt = claimableList.reduce((s, p) => s + p.claimableUsdt, 0);

    setClaimingBusy(true);
    setClaimErr(undefined);
    try {
      await onBatchClaim(seriesIds);
      setToast({
        kind: "ok",
        text: t.outcomeClaimedSuccess(totalAmt.toFixed(2)),
      });
    } catch (err: any) {
      setClaimErr(formatTradeError(err, "Claim failed"));
    } finally {
      setClaimingBusy(false);
    }
  };

  // Play Again (preserves direction, tier, stakeUsdt and switches to open expiry)
  const handlePlayAgain = () => {
    setSelectedPriorExpiry(null);
    setSelectedPositionId(null);
    setScrubPrice(null);
    setClaimErr(undefined);
    setSettleErr(undefined);
    resetFlowState();
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  // Derived Telemetry & Spot
  const displaySpot =
    liveSpots[underlying]?.spot || shelf?.spot || assetSpec.defaultSpot;
  const displayChg =
    liveSpots[underlying]?.change24hPct ?? shelf?.change24hPct ?? 0;
  const priceChangeAbs = displaySpot * (displayChg / 100);
  const isUp = displayChg >= 0;

  const activeTelemetry =
    liveTelemetry[underlying] ??
    health?.atlasTelemetry?.[underlying] ??
    shelf?.atlasTelemetry;
  const activeRwaTelemetry =
    liveRwaTelemetry[underlying] ??
    health?.rwaTelemetry?.[underlying] ??
    resolveRwaTelemetry(shelf?.rwaTelemetry, underlying);
  const activeGuard =
    liveCircuitBreaker[underlying] ??
    health?.settlementCircuitBreaker?.[underlying] ??
    shelf?.quotingGuard;
  const rwaCircuitBreakerActive = Boolean(
    isRwaAsset &&
      activeRwaTelemetry &&
      (activeRwaTelemetry.splitGuardTriggered ||
        activeRwaTelemetry.corporateActionBlackout)
  );
  const rwaPauseReason = activeRwaTelemetry?.corporateActionBlackout
    ? activeRwaTelemetry.blackoutReason
    : activeRwaTelemetry?.splitGuardTriggered
      ? isZh
        ? `份额乘数漂移 ${Math.abs(activeRwaTelemetry.multiplierDriftPct).toFixed(2)}% > 1.0%`
        : `Share multiplier drift ${Math.abs(activeRwaTelemetry.multiplierDriftPct).toFixed(2)}% > 1.0%`
      : null;
  const quotingPaused =
    activeGuard?.quotingSafe === false || rwaCircuitBreakerActive;

  const rwaSession: RwaMarketSession =
    activeRwaTelemetry?.session ?? classifyUsMarketSessionFallback(nowSec * 1000);
  const rwaSessionMeta =
    rwaSession === "RTH"
      ? {
          label: t.rwaSessionRth,
          dotCls: "bg-[#2EC26B]",
          textCls: "text-[#2EC26B]",
        }
      : rwaSession === "WEEKEND"
        ? {
            label: t.rwaSessionWeekend,
            dotCls: "bg-[#7e8690]",
            textCls: "text-[#b8bec6]",
          }
        : {
            label: t.rwaSessionExtended,
            dotCls: "bg-[#E6BA5C]",
            textCls: "text-[#E6BA5C]",
          };

  // C1 TWAP & C2 Awaiting Settlement flags for current expiry
  const isCurrentExpiryAwaiting = currentExpiryActivePositions.some(
    (p) => p.awaitingSettlement
  );
  const isCurrentExpiryDisputed = currentExpiryActivePositions.some(
    (p) => p.awaitingSettlement && p.expiryPaused
  );
  const canManualSettleNow = currentExpiryActivePositions.some(
    (p) => p.awaitingSettlement && !p.expiryPaused && p.canPermissionlessSettle
  );
  const isCurrentExpiryInTwap =
    !isCurrentExpiryAwaiting &&
    currentExpiryActivePositions.some((p) => p.inTwapWindow);

  const twapWindowHealth = health?.twapWindowHealth?.[underlying];
  const currentTwapAvgPrice = isCurrentExpiryInTwap
    ? (twapWindowHealth && twapWindowHealth.expiry === currentExpiry
        ? twapWindowHealth.indicativeTwapUsd
        : null) ??
      activeTelemetry?.twapPrice ??
      displaySpot
    : null;

  // B1 / B2 Current-expiry totals + scrubbed simulation totals (payout + net PnL)
  const positionTotals = useMemo(() => {
    let totalStake = 0;
    let totalValue = 0;
    let totalUnrealizedPnl = 0;
    let totalSimulated = 0;
    for (const p of currentExpiryActivePositions) {
      totalStake += p.totalStakeUsdt;
      totalValue += p.indicativeExitUsdt;
      totalUnrealizedPnl += p.unrealizedPnlUsdt;
      if (scrubPrice !== null) {
        totalSimulated += computeExpiryPayoffUsdt(
          p.isUp,
          p.lowerStrike,
          p.upperStrike,
          p.remainingBalanceUsdt,
          scrubPrice
        );
      }
    }
    const totalSimulatedPnl = totalSimulated - totalStake;
    return {
      totalStake,
      totalValue,
      totalUnrealizedPnl,
      totalSimulated,
      totalSimulatedPnl,
    };
  }, [currentExpiryActivePositions, scrubPrice]);

  // C3 / C4 Grouped Outcome Summary for current expiry
  const outcomeGroup = useMemo(() => {
    if (currentExpiryClaimablePositions.length === 0) return null;
    const groupKey = `${underlying}:${currentExpiry}`;
    const totalStake = currentExpiryClaimablePositions.reduce(
      (s, p) => s + p.totalStakeUsdt,
      0
    );
    const totalClaimable = currentExpiryClaimablePositions.reduce(
      (s, p) => s + p.claimableUsdt,
      0
    );
    const settlementPrice = currentExpiryClaimablePositions.find(
      (p) => p.settlementPrice !== undefined
    )?.settlementPrice;

    const kind: "WIN" | "PARTIAL" | "MISS" =
      totalClaimable <= 0
        ? "MISS"
        : totalClaimable >= totalStake
          ? "WIN"
          : "PARTIAL";

    if (kind === "MISS" && dismissedMissKey === groupKey) return null;

    return {
      groupKey,
      kind,
      totalStake,
      totalClaimable,
      netPnl: totalClaimable - totalStake,
      settlementPrice,
      items: currentExpiryClaimablePositions,
    };
  }, [
    currentExpiryClaimablePositions,
    underlying,
    currentExpiry,
    dismissedMissKey,
  ]);

  const assetSubtitle =
    underlying === "BTC"
      ? t.marketBtcName
      : underlying === "ETH"
        ? t.marketEthName
        : t.marketNvdaName;

  const isTradeBusy =
    stage === "APPROVING" || stage === "QUOTING" || stage === "FILLING";
  const expiryCountdown = formatExpiryCountdownInfo(currentExpiry, nowSec, isZh);
  const isCountdownTwapUrgent = Boolean(
    expiryCountdown &&
      !expiryCountdown.expired &&
      (isCurrentExpiryInTwap || expiryCountdown.remainingSec <= 30 * 60)
  );
  const isCountdownSoon = Boolean(
    expiryCountdown &&
      !expiryCountdown.expired &&
      !isCountdownTwapUrgent &&
      expiryCountdown.remainingSec <= 2 * 3600
  );

  return (
    <main className="mx-auto max-w-[1160px] bg-black px-4 pt-1 pb-12 sm:px-6 lg:pt-2 lg:pb-16">
      {/* Inline dark toast after gasless open / sell / settle / claim */}
      {toast && (
        <div
          role={toast.kind === "err" ? "alert" : "status"}
          aria-live="polite"
          className={`mb-3 flex items-center justify-between gap-2 rounded-2xl px-3.5 py-2.5 text-xs font-medium ${
            toast.kind === "ok"
              ? "border border-[#2EC26B]/25 bg-[#121417] text-[#2EC26B]"
              : "border border-[#E85D4A]/30 bg-[#121417] text-[#E85D4A]"
          }`}
        >
          <div className="flex items-center gap-2 min-w-0">
            <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="truncate text-white">{toast.text}</span>
            {explorerBase && toast.txHash && (
              <a
                href={`${explorerBase}/tx/${toast.txHash}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex shrink-0 items-center gap-0.5 font-semibold text-[#2EC26B] underline underline-offset-2"
              >
                BscScan
                <ExternalLink className="h-3 w-3" aria-hidden="true" />
              </a>
            )}
          </div>
          <button
            type="button"
            aria-label={t.cancel}
            onClick={() => setToast(null)}
            className="rounded-full p-1 text-[#7e8690] hover:bg-[#24282f] hover:text-white cursor-pointer"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      )}

      {/*
        Responsive Pure-Black Layout:
        - Mobile (<1024px): single column (Hero+Tabs+Chart -> Order Area -> Positions & Settlement Cards)
        - Desktop (>=1024px): borderless 2-column (Left: Hero+Tabs+Chart + Positions & Settlement; Right: sticky Order Column)
      */}
      <div className="grid grid-cols-1 gap-y-3.5 lg:grid-cols-12 lg:gap-x-10 lg:gap-y-6 lg:items-start">
        {/* SECTION 1: Editorial Asset Hero + Expiry Scope Bar + Full-Bleed Chart */}
        <div className="space-y-2.5 lg:space-y-4 lg:col-start-1 lg:col-span-7 xl:col-span-8 lg:row-start-1">
          {/* Editorial Asset Hero */}
          <section className="space-y-1 lg:space-y-2">
            <div className="flex items-center justify-between gap-2">
              <MarketSelector
                locale={locale}
                selectedUnderlying={underlying}
                assetSubtitle={assetSubtitle}
                liveSpots={liveSpots}
                liveRwaTelemetry={liveRwaTelemetry}
                positions={positions}
                disabled={isTradeBusy}
                externalOpen={marketPickerOpen}
                onOpenExternal={onOpenMarketPicker}
                onCloseExternal={onCloseMarketPicker}
                onSelectUnderlying={handleSwitchUnderlying}
              />

              <button
                type="button"
                onClick={onOpenRules}
                aria-label={t.infoRulesTooltip}
                title={t.infoRulesTooltip}
                className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-[#15171b] text-[#b8bec6] transition hover:bg-[#24282f] hover:text-white cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
              >
                <Info className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>

            {/* 36px Tabular Live Spot Price */}
            <div className="text-[36px] font-bold leading-[1.04] tracking-[-0.03em] text-white tabular-nums">
              $
              {displaySpot.toLocaleString("en-US", {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
            </div>

            {/* Single-line 24h Delta + Subtle NVDA-Only RWA Session Pill */}
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs tabular-nums">
              <span
                className={`font-semibold ${
                  isUp ? "text-[#2EC26B]" : "text-[#E85D4A]"
                }`}
              >
                {isUp ? "+" : "−"}$
                {Math.abs(priceChangeAbs).toLocaleString("en-US", {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}{" "}
                ({isUp ? "+" : ""}
                {displayChg.toFixed(2)}%)
              </span>
              <span className="text-[#7e8690]">{t.past24h}</span>

              {isRwaAsset && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-[#15171b] px-2.5 py-0.5 text-[11px] font-semibold">
                  <span
                    aria-hidden="true"
                    className={`h-1.5 w-1.5 rounded-full ${rwaSessionMeta.dotCls}`}
                  />
                  <span className={rwaSessionMeta.textCls}>
                    {rwaSessionMeta.label}
                  </span>
                </span>
              )}
            </div>
          </section>

          {/* Expiry Scope Bar (above chart: selects active settlement contract + live countdown) */}
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-[#1d2025] pt-0.5">
            <div
              role="tablist"
              aria-label={isZh ? "到期时间" : "Settlement expiry"}
              className="flex min-w-0 items-center gap-5 sm:gap-6 overflow-x-auto no-scrollbar"
            >
              {expiryTabs.map((tab, idx) => {
                const selected = tab.id === activeTabId;
                return (
                  <button
                    key={tab.id}
                    ref={(el) => {
                      tabRefs.current[idx] = el;
                    }}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    tabIndex={selected ? 0 : -1}
                    disabled={isTradeBusy}
                    onClick={() => handleSelectExpiryTab(tab)}
                    onKeyDown={(e) => handleTabKeyDown(e, idx)}
                    className={`relative flex-none inline-flex items-center gap-1.5 pb-2.5 text-[13.5px] font-semibold tracking-[-0.01em] transition-colors cursor-pointer disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white ${
                      selected
                        ? "text-white after:content-[''] after:absolute after:inset-x-0 after:bottom-0 after:border-b-2 after:border-white"
                        : "text-[#7e8690] hover:text-[#b8bec6]"
                    }`}
                  >
                    <span className="tabular-nums">{tab.label}</span>
                    {tab.hasPositions && (
                      <>
                        <span
                          aria-hidden="true"
                          className={`h-1.5 w-1.5 rounded-full shrink-0 ${
                            tab.hasTwapOrAwaiting
                              ? "bg-[#E6BA5C]"
                              : "bg-[#2EC26B]"
                          }`}
                        />
                        <span className="sr-only">
                          {isZh ? "（有持仓）" : " (has positions)"}
                        </span>
                      </>
                    )}
                  </button>
                );
              })}
            </div>

            {expiryCountdown && currentExpiry && (
              <div className="shrink-0 pb-2">
                <time
                  dateTime={new Date(currentExpiry * 1000).toISOString()}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs leading-none tabular-nums transition-colors ${
                    isCountdownTwapUrgent
                      ? "border-[#E6BA5C]/40 bg-[#E6BA5C]/15 text-[#E6BA5C]"
                      : isCountdownSoon
                        ? "border-[#E6BA5C]/30 bg-[#E6BA5C]/10 text-[#E6BA5C]"
                        : "border-[#262a31] bg-[#15171b] text-white"
                  }`}
                >
                  {isCountdownTwapUrgent ? (
                    <span
                      aria-hidden="true"
                      className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#E6BA5C] animate-pulse motion-reduce:animate-none"
                    />
                  ) : (
                    <Clock
                      className={`h-3.5 w-3.5 shrink-0 ${
                        isCountdownSoon ? "text-[#E6BA5C]" : "text-[#9aa2ad]"
                      }`}
                      aria-hidden="true"
                    />
                  )}
                  {!expiryCountdown.expired && (
                    <span
                      className={`${
                        isCountdownTwapUrgent
                          ? "font-semibold text-[#E6BA5C]"
                          : isCountdownSoon
                            ? "font-medium text-[#E6BA5C]/85"
                            : "font-medium text-[#9aa2ad]"
                      } ${isZh ? "" : "hidden sm:inline"}`}
                    >
                      {isCountdownTwapUrgent
                        ? isZh
                          ? "均价锁定"
                          : "30m TWAP"
                        : t.settlesCountdownLabel}
                    </span>
                  )}
                  <span
                    className={`font-semibold tracking-[0.01em] ${
                      expiryCountdown.expired
                        ? "text-[#b8bec6]"
                        : isCountdownTwapUrgent || isCountdownSoon
                          ? "font-bold text-[#E6BA5C]"
                          : "text-white"
                    }`}
                  >
                    {expiryCountdown.text}
                  </span>
                </time>
              </div>
            )}
          </div>

          {/* Full-Bleed Pure-Black Forecast Chart (Past Curve + Future Payoff Zone) */}
          <KlineChart
            locale={locale}
            candles={candles}
            ticket={isPriorExpiry ? undefined : activeTicket}
            liveSpot={displaySpot}
            expiry={currentExpiry}
            expiryLabel={activeExpiryTab?.label}
            nowSec={nowSec}
            windowLabel={autoWindowLabel}
            positions={currentExpiryActivePositions}
            selectedPositionId={selectedPositionId}
            onSelectPosition={setSelectedPositionId}
            isCustomMode={rangeMode === "CUSTOM"}
            inTwapWindow={isCurrentExpiryInTwap}
            twapAvgPrice={currentTwapAvgPrice}
            scrubPrice={scrubPrice}
            onScrubPriceChange={setScrubPrice}
            height={isDesktop ? 284 : 228}
          />
        </div>

        {/* SECTION 2: Option-A Order Column (Mobile: right under chart; Desktop: sticky right column) */}
        <aside className="lg:col-start-8 lg:col-span-5 xl:col-start-9 xl:col-span-4 lg:row-start-1 lg:row-span-2 lg:sticky lg:top-20 self-start">
          {isPriorExpiry ? (
            <div className="space-y-4 rounded-2xl bg-[#121417] p-5">
              <div className="flex items-start gap-2.5">
                <Clock
                  className="mt-0.5 h-4 w-4 shrink-0 text-[#E6BA5C]"
                  aria-hidden="true"
                />
                <div className="space-y-1">
                  <div className="text-sm font-bold text-white">
                    {formatExpiryTabLabel(
                      currentExpiry,
                      "PRIOR",
                      locale,
                      isRwaAsset
                    )}
                  </div>
                  <p className="text-xs leading-relaxed text-[#7e8690]">
                    {t.priorExpiryViewOnly}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={handlePlayAgain}
                className="flex min-h-[48px] w-full items-center justify-center gap-1.5 rounded-full bg-white px-5 py-3 text-sm font-bold text-black hover:bg-white/90 transition cursor-pointer"
              >
                <span>{t.jumpToNextExpiry}</span>
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          ) : activeTicket && shelf ? (
            <OrderTicketPanel
              locale={locale}
              direction={direction}
              onChangeDirection={handleSwitchDirection}
              tiers={shelf.tiers}
              quickTiers={quickTiers}
              selectedTargetKey={effectiveTargetKey}
              onSelectTarget={handleSelectTarget}
              rangeMode={rangeMode}
              onChangeRangeMode={handleChangeRangeMode}
              customConfig={shelf.customConfig}
              customStartPrice={resolvedCustomSelection?.startPrice}
              customCapPrice={resolvedCustomSelection?.capPrice}
              customClampReason={effectiveCustomClamp.reason}
              customStartClamped={effectiveCustomClamp.startClamped}
              customCapClamped={effectiveCustomClamp.capClamped}
              customSyncing={customSyncing}
              onChangeCustomStart={handleChangeCustomStart}
              onChangeCustomCap={handleChangeCustomCap}
              ticket={activeTicket}
              spot={displaySpot}
              grid={shelf.grid}
              stakeUsdt={stakeUsdt}
              onChangeStake={(val) => {
                setStakeUsdt(val);
                if (stage === "SLIPPAGE_CONFIRM" || stage === "SUCCESS") {
                  resetFlowState();
                }
              }}
              walletConnected={wallet.kind !== "NONE"}
              usdtBalance={wallet.usdtBalance}
              isShelfSynced={isActiveTicketReady}
              quotingPaused={quotingPaused}
              rwaPaused={rwaCircuitBreakerActive}
              rwaPauseReason={rwaPauseReason}
              stage={stage}
              slippagePause={slippagePause}
              txHash={txHash}
              errorMsg={errorMsg}
              onOpenWallet={onOpenWallet}
              onInstantBuy={() => void handleInstantBuy()}
              onConfirmSlippageQuote={() => void handleConfirmSlippageQuote()}
              onRefreshSlippageQuote={() => void handleInstantBuy()}
              onCancelFlow={resetFlowState}
            />
          ) : (
            <div className="space-y-4 animate-pulse">
              <div className="h-11 rounded-full bg-[#131519]" />
              <div className="space-y-2.5 pt-1">
                <div className="h-5 w-44 rounded bg-[#15171b]" />
                <div className="h-6 rounded-full bg-[#15171b]" />
                <div className="flex justify-between">
                  <div className="h-4 w-12 rounded bg-[#15171b]" />
                  <div className="h-4 w-12 rounded bg-[#15171b]" />
                  <div className="h-4 w-12 rounded bg-[#15171b]" />
                  <div className="h-4 w-12 rounded bg-[#15171b]" />
                </div>
              </div>
              <div className="h-16 rounded-2xl bg-[#131519]" />
              <div className="h-13 rounded-full bg-[#15171b]" />
            </div>
          )}
        </aside>

        {/* SECTION 3: Settlement States (C1–C4) & Current-Expiry Hairline Position List (B1–B2) */}
        {(isCurrentExpiryInTwap ||
          isCurrentExpiryAwaiting ||
          outcomeGroup ||
          currentExpiryActivePositions.length > 0) && (
          <div className="space-y-5 lg:col-start-1 lg:col-span-7 xl:col-span-8 lg:row-start-2">
            {/* C1: Final 30m Warm-Gold TWAP Lock Status Banner */}
            {isCurrentExpiryInTwap && currentExpiry && (
              <section
                aria-label={t.twapLockBannerTitle}
                className="rounded-2xl border border-[#E6BA5C]/25 bg-[#121417] p-4 space-y-2.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-sm font-bold text-[#E6BA5C]">
                    <Lock className="h-4 w-4 shrink-0" aria-hidden="true" />
                    <span>{t.twapLockBannerTitle}</span>
                  </div>
                  <span className="rounded-full bg-[#E6BA5C]/15 px-2.5 py-0.5 text-xs font-bold text-[#E6BA5C] tabular-nums">
                    {formatShortCountdown(currentExpiry, nowSec, isZh)}
                  </span>
                </div>
                <p className="text-xs leading-relaxed text-[#b8bec6]">
                  {t.twapLockBannerDesc}
                </p>
                {currentTwapAvgPrice !== null && (
                  <div className="flex items-center justify-between border-t border-[#1d2025] pt-2.5 text-xs tabular-nums">
                    <span className="text-[#7e8690]">{t.twapLiveAvgLabel}</span>
                    <span className="font-bold text-[#E6BA5C]">
                      {formatStrikePrice(currentTwapAvgPrice, underlying)}
                    </span>
                  </div>
                )}
              </section>
            )}

            {/* C2: Awaiting Settlement 3-Step Auto-Settlement Card */}
            {isCurrentExpiryAwaiting && (
              <section
                aria-label={t.autoSettleTitle}
                className="rounded-2xl bg-[#121417] p-4 sm:p-5 space-y-4"
              >
                {isCurrentExpiryDisputed ? (
                  <div className="flex items-start gap-2.5 text-xs text-[#E85D4A]">
                    <AlertTriangle
                      className="mt-0.5 h-4 w-4 shrink-0"
                      aria-hidden="true"
                    />
                    <div className="space-y-1">
                      <div className="text-sm font-bold text-white">
                        {t.statusDisputed}
                      </div>
                      <p className="leading-relaxed text-[#b8bec6]">
                        {t.disputedExpiryNotice}
                      </p>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 text-sm font-bold text-white">
                        <Loader2
                          className="h-4 w-4 animate-spin text-[#E6BA5C]"
                          aria-hidden="true"
                        />
                        <span>{t.autoSettleTitle}</span>
                      </div>
                      <span className="text-xs font-semibold text-[#E6BA5C]">
                        Atlas TWAP
                      </span>
                    </div>

                    <ol className="space-y-2.5 text-xs">
                      <li className="flex items-center gap-2.5 text-white">
                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#2EC26B]/18 text-[#2EC26B]">
                          <Check className="h-3 w-3" aria-hidden="true" />
                        </span>
                        <span>{t.autoSettleStep1}</span>
                      </li>
                      <li className="flex items-center gap-2.5 text-white">
                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#E6BA5C]/18 text-[#E6BA5C]">
                          <Loader2
                            className="h-3 w-3 animate-spin"
                            aria-hidden="true"
                          />
                        </span>
                        <span>{t.autoSettleStep2}</span>
                      </li>
                      <li className="flex items-center gap-2.5 text-[#7e8690]">
                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#24282f] text-[10px] font-bold">
                          3
                        </span>
                        <span>{t.autoSettleStep3}</span>
                      </li>
                    </ol>

                    {settleErr && (
                      <div
                        role="alert"
                        className="rounded-xl bg-[#E85D4A]/12 px-3 py-2 text-xs text-[#E85D4A]"
                      >
                        {settleErr}
                      </div>
                    )}

                    {canManualSettleNow && (
                      <div className="space-y-2 border-t border-[#1d2025] pt-3">
                        <p className="text-[11.5px] text-[#7e8690]">
                          {t.manualSettleHint}
                        </p>
                        <button
                          type="button"
                          disabled={settlingBusy}
                          onClick={() => void handleTriggerManualSettle()}
                          className="flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded-full bg-white px-4 py-2.5 text-xs font-bold text-black hover:bg-white/90 disabled:opacity-50 transition cursor-pointer"
                        >
                          {settlingBusy ? (
                            <>
                              <Loader2
                                className="h-3.5 w-3.5 animate-spin"
                                aria-hidden="true"
                              />
                              <span>{t.manualSettling}</span>
                            </>
                          ) : (
                            <>
                              <ShieldCheck
                                className="h-3.5 w-3.5"
                                aria-hidden="true"
                              />
                              <span>{t.manualSettleCta}</span>
                            </>
                          )}
                        </button>
                      </div>
                    )}
                  </>
                )}
              </section>
            )}

            {/* C3 / C4: Grouped Settlement Outcome Card (Win / Partial "没有归零" / Miss) + batchRedeem */}
            {outcomeGroup && (
              <section
                aria-label={t.outcomeTotalClaimable}
                className="rounded-2xl bg-[#121417] p-5 space-y-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      {outcomeGroup.kind === "WIN" && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-[#2EC26B]/15 px-2.5 py-0.5 text-[11px] font-bold text-[#2EC26B]">
                          <Sparkles className="h-3 w-3" aria-hidden="true" />
                          {t.outcomeWinBadge}
                        </span>
                      )}
                      {outcomeGroup.kind === "PARTIAL" && (
                        <>
                          <span className="inline-flex items-center gap-1 rounded-full bg-[#E6BA5C]/18 px-2.5 py-0.5 text-[11px] font-bold text-[#E6BA5C]">
                            {t.outcomePartialBadge}
                          </span>
                          <span className="text-xs font-semibold text-[#E6BA5C]">
                            {t.outcomePartialTitle}
                          </span>
                        </>
                      )}
                      {outcomeGroup.kind === "MISS" && (
                        <span className="inline-flex items-center rounded-full bg-[#24282f] px-2.5 py-0.5 text-[11px] font-bold text-[#b8bec6]">
                          {t.outcomeMissBadge}
                        </span>
                      )}
                    </div>

                    <div className="flex items-baseline gap-2.5 tabular-nums">
                      <span
                        className={`text-[30px] font-bold leading-none tracking-[-0.03em] ${
                          outcomeGroup.kind === "WIN"
                            ? "text-[#2EC26B]"
                            : outcomeGroup.kind === "PARTIAL"
                              ? "text-[#E6BA5C]"
                              : "text-[#7e8690]"
                        }`}
                      >
                        ${outcomeGroup.totalClaimable.toFixed(2)}
                      </span>
                      <span
                        className={`text-xs font-semibold ${
                          outcomeGroup.netPnl >= 0
                            ? "text-[#2EC26B]"
                            : outcomeGroup.kind === "PARTIAL"
                              ? "text-[#E6BA5C]"
                              : "text-[#7e8690]"
                        }`}
                      >
                        ({formatSignedUsd(outcomeGroup.netPnl)})
                      </span>
                    </div>
                  </div>

                  {outcomeGroup.settlementPrice !== undefined && (
                    <div className="text-right tabular-nums">
                      <div className="text-[11px] text-[#7e8690]">
                        {t.outcomeSettlementPriceLabel}
                      </div>
                      <div className="mt-0.5 text-sm font-bold text-white">
                        {formatStrikePrice(
                          outcomeGroup.settlementPrice,
                          underlying
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {/* Breakdown Hairline Rows */}
                <div className="divide-y divide-[#1d2025] border-t border-b border-[#1d2025]">
                  {outcomeGroup.items.map((item) => {
                    const rowPartial =
                      item.claimableUsdt > 0 &&
                      item.claimableUsdt < item.totalStakeUsdt;
                    const rowWin =
                      item.claimableUsdt >= item.totalStakeUsdt &&
                      item.claimableUsdt > 0;
                    return (
                      <div
                        key={getPosId(item)}
                        className="flex items-center justify-between gap-3 py-2.5 text-xs tabular-nums"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 font-semibold text-white">
                            <span
                              className={`h-1.5 w-1.5 rounded-full shrink-0 ${
                                item.isUp ? "bg-[#2EC26B]" : "bg-[#E85D4A]"
                              }`}
                              aria-hidden="true"
                            />
                            <span>{item.isUp ? t.bull : t.bear}</span>
                            <span className="text-[#7e8690] font-normal">
                              {formatStrikePrice(item.startPrice, underlying)} →{" "}
                              {formatStrikePrice(item.capPrice, underlying)}
                            </span>
                            {rowPartial && (
                              <span className="rounded-full bg-[#E6BA5C]/15 px-1.5 py-0.5 text-[10px] font-bold text-[#E6BA5C]">
                                {t.outcomePartialBadge}
                              </span>
                            )}
                          </div>
                          <div className="mt-0.5 text-[11px] text-[#7e8690]">
                            {isZh ? "投入" : "Stake"} $
                            {item.totalStakeUsdt.toFixed(2)}
                          </div>
                        </div>

                        <div
                          className={`font-bold ${
                            rowWin
                              ? "text-[#2EC26B]"
                              : rowPartial
                                ? "text-[#E6BA5C]"
                                : "text-[#7e8690]"
                          }`}
                        >
                          ${item.claimableUsdt.toFixed(2)}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {claimErr && (
                  <div
                    role="alert"
                    className="rounded-xl bg-[#E85D4A]/12 px-3 py-2 text-xs text-[#E85D4A]"
                  >
                    {claimErr}
                  </div>
                )}

                <div className="flex flex-col gap-2 sm:flex-row">
                  {outcomeGroup.totalClaimable > 0 ? (
                    <button
                      type="button"
                      disabled={claimingBusy}
                      onClick={() => void handleClaimCurrentExpiry()}
                      className="flex min-h-[48px] flex-1 items-center justify-center gap-2 rounded-full bg-white px-5 py-3 text-sm font-bold text-black hover:bg-white/90 disabled:opacity-50 transition cursor-pointer tabular-nums"
                    >
                      {claimingBusy && (
                        <Loader2
                          className="h-4 w-4 animate-spin"
                          aria-hidden="true"
                        />
                      )}
                      <span>
                        {claimingBusy
                          ? t.outcomeClaiming
                          : t.outcomeBatchClaimCta(
                              outcomeGroup.totalClaimable.toFixed(2),
                              outcomeGroup.items.filter(
                                (p) => p.claimableUsdt > 0
                              ).length
                            )}
                      </span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setDismissedMissKey(outcomeGroup.groupKey)}
                      className="flex min-h-[46px] flex-1 items-center justify-center rounded-full bg-[#24282f] px-4 py-2.5 text-xs font-semibold text-[#b8bec6] hover:bg-[#2f343d] hover:text-white transition cursor-pointer"
                    >
                      {t.outcomeZeroClaimClose}
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={handlePlayAgain}
                    className={`flex min-h-[48px] items-center justify-center gap-1.5 rounded-full px-5 py-3 text-sm font-bold transition cursor-pointer ${
                      outcomeGroup.totalClaimable > 0
                        ? "bg-[#24282f] text-white hover:bg-[#2f343d] sm:w-auto"
                        : "flex-1 bg-white text-black hover:bg-white/90"
                    }`}
                  >
                    <span>{t.outcomePlayAgain}</span>
                    <ArrowRight className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>
              </section>
            )}

            {/* B1 / B2: In-Page Current-Expiry Hairline Position List (No row cards) */}
            {currentExpiryActivePositions.length > 0 && (
              <section
                aria-label={t.currentExpiryPositionsTitle}
                className="space-y-2.5"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <h2 className="text-sm font-bold text-white">
                      {t.currentExpiryPositionsTitle}
                    </h2>
                    <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-[#15171b] px-1.5 text-[11px] font-bold text-[#b8bec6] tabular-nums">
                      {currentExpiryActivePositions.length}
                    </span>
                  </div>

                  <div className="text-xs tabular-nums">
                    {scrubPrice !== null ? (
                      <span className="inline-flex flex-wrap items-baseline justify-end gap-x-1.5 gap-y-0.5 text-[#b8bec6]">
                        <span>
                          {t.positionsSimulatedTotal} (@{" "}
                          {formatStrikePrice(scrubPrice, underlying)})
                        </span>
                        <strong
                          className="text-sm font-bold"
                          style={{
                            color:
                              positionTotals.totalSimulated >=
                              positionTotals.totalStake
                                ? "#2EC26B"
                                : positionTotals.totalSimulated > 0
                                  ? "#E6BA5C"
                                  : "#7e8690",
                          }}
                        >
                          ${positionTotals.totalSimulated.toFixed(2)}
                        </strong>
                        <span
                          className="font-semibold"
                          style={{
                            color:
                              positionTotals.totalSimulatedPnl > 0.004
                                ? "#2EC26B"
                                : positionTotals.totalSimulatedPnl < -0.004
                                  ? "#E85D4A"
                                  : "#7e8690",
                          }}
                        >
                          ({formatSignedUsd(positionTotals.totalSimulatedPnl)})
                        </span>
                      </span>
                    ) : (
                      <span className="inline-flex flex-wrap items-baseline justify-end gap-x-1 text-[#7e8690]">
                        <span>
                          {t.positionsTotalValue}{" "}
                          <strong className="font-semibold text-white">
                            ${positionTotals.totalValue.toFixed(2)}
                          </strong>{" "}
                          <span
                            className="font-semibold"
                            style={{
                              color:
                                positionTotals.totalUnrealizedPnl > 0.004
                                  ? "#2EC26B"
                                  : positionTotals.totalUnrealizedPnl < -0.004
                                    ? "#E85D4A"
                                    : "#7e8690",
                            }}
                          >
                            (
                            {formatSignedUsd(positionTotals.totalUnrealizedPnl)}
                            )
                          </span>
                        </span>
                      </span>
                    )}
                  </div>
                </div>

                <ul
                  role="list"
                  className="divide-y divide-[#1d2025] border-t border-b border-[#1d2025]"
                >
                  {currentExpiryActivePositions.map((pos) => {
                    const posId = getPosId(pos);
                    const isSelected = selectedPositionId === posId;
                    const mult =
                      pos.totalStakeUsdt > 0
                        ? pos.initialMaxPayoutUsdt / pos.totalStakeUsdt
                        : 0;
                    const simulatedPayout =
                      scrubPrice !== null
                        ? computeExpiryPayoffUsdt(
                            pos.isUp,
                            pos.lowerStrike,
                            pos.upperStrike,
                            pos.remainingBalanceUsdt,
                            scrubPrice
                          )
                        : null;
                    const simDelta =
                      simulatedPayout !== null
                        ? simulatedPayout - pos.totalStakeUsdt
                        : null;
                    const simIsPartial =
                      simulatedPayout !== null &&
                      simulatedPayout > 0 &&
                      simulatedPayout < pos.totalStakeUsdt;

                    return (
                      <li
                        key={posId}
                        className={`relative flex items-center justify-between gap-3 px-2.5 py-3 transition-colors duration-150 ${
                          isSelected ? "bg-[#121417]" : "hover:bg-[#101216]"
                        }`}
                      >
                        {isSelected && (
                          <span
                            aria-hidden="true"
                            className={`pointer-events-none absolute inset-y-0 left-0 w-[2px] ${
                              pos.isUp ? "bg-[#2EC26B]" : "bg-[#E85D4A]"
                            }`}
                          />
                        )}

                        {/* Left: Position summary (click highlights chart range) + quiet sibling BscScan icon */}
                        <div className="min-w-0 flex-1 space-y-0.5">
                          <button
                            type="button"
                            aria-pressed={isSelected}
                            onClick={() =>
                              setSelectedPositionId(isSelected ? null : posId)
                            }
                            className="flex w-full flex-wrap items-center gap-1.5 text-left text-[14px] font-bold text-white tabular-nums cursor-pointer rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
                          >
                            <span
                              aria-hidden="true"
                              className={`h-2 w-2 rounded-full shrink-0 ${
                                pos.isUp ? "bg-[#2EC26B]" : "bg-[#E85D4A]"
                              }`}
                            />
                            <span
                              className={
                                pos.isUp ? "text-[#2EC26B]" : "text-[#E85D4A]"
                              }
                            >
                              {pos.isUp ? t.bull : t.bear}
                            </span>
                            {mult > 0 && <span>{mult.toFixed(2)}x</span>}
                            <span className="text-xs font-medium text-[#b8bec6]">
                              {formatStrikePrice(pos.startPrice, underlying)}{" "}
                              → {formatStrikePrice(pos.capPrice, underlying)}
                            </span>
                          </button>

                          <div className="flex flex-wrap items-center gap-1 text-xs text-[#7e8690] tabular-nums">
                            <button
                              type="button"
                              onClick={() =>
                                setSelectedPositionId(isSelected ? null : posId)
                              }
                              className="text-left hover:text-[#b8bec6] transition cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white rounded"
                            >
                              {isZh ? "投入" : "Stake"} $
                              {pos.totalStakeUsdt.toFixed(2)} ·{" "}
                              {isZh ? "最高赢" : "Max"} $
                              {pos.remainingBalanceUsdt.toFixed(2)}
                            </button>
                            {explorerBase && pos.openTxHash && (
                              <a
                                href={`${explorerBase}/tx/${pos.openTxHash}`}
                                target="_blank"
                                rel="noreferrer"
                                aria-label={
                                  isZh
                                    ? "在 BscScan 查看该笔交易"
                                    : "View transaction on BscScan"
                                }
                                title="BscScan"
                                className="inline-flex h-5 w-5 items-center justify-center rounded text-[#6b7280] hover:text-white transition focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-white"
                              >
                                <ExternalLink
                                  className="h-3 w-3"
                                  aria-hidden="true"
                                />
                              </a>
                            )}
                          </div>
                        </div>

                        {/* Right: Live Value/PnL + One-Click Sell Action (Option 1) */}
                        <div className="flex shrink-0 items-center gap-3">
                          <div className="text-right tabular-nums">
                            {simulatedPayout !== null && simDelta !== null ? (
                              <>
                                <div className="flex items-center justify-end gap-1.5">
                                  {simIsPartial && (
                                    <span className="rounded-full bg-[#E6BA5C]/15 px-1.5 py-0.5 text-[10px] font-bold text-[#E6BA5C]">
                                      {t.outcomePartialBadge}
                                    </span>
                                  )}
                                  <span
                                    className="text-[15px] font-bold"
                                    style={{
                                      color:
                                        simulatedPayout >= pos.totalStakeUsdt
                                          ? "#2EC26B"
                                          : simulatedPayout > 0
                                            ? "#E6BA5C"
                                            : "#7e8690",
                                    }}
                                  >
                                    ${simulatedPayout.toFixed(2)}
                                  </span>
                                </div>
                                <div
                                  className={`text-xs font-semibold ${
                                    simDelta >= 0
                                      ? "text-[#2EC26B]"
                                      : simIsPartial
                                        ? "text-[#E6BA5C]"
                                        : "text-[#7e8690]"
                                  }`}
                                >
                                  {formatSignedUsd(simDelta)}
                                </div>
                              </>
                            ) : (
                              <>
                                <div className="text-[15px] font-bold text-white">
                                  ${pos.indicativeExitUsdt.toFixed(2)}
                                </div>
                                <div
                                  className={`text-xs font-semibold ${
                                    pos.unrealizedPnlUsdt >= 0
                                      ? "text-[#2EC26B]"
                                      : "text-[#E85D4A]"
                                  }`}
                                >
                                  {formatSignedUsd(pos.unrealizedPnlUsdt)} (
                                  {pos.unrealizedPnlPct >= 0 ? "+" : ""}
                                  {pos.unrealizedPnlPct.toFixed(1)}%)
                                </div>
                              </>
                            )}
                          </div>

                          {pos.awaitingSettlement ? (
                            <span className="inline-flex min-h-[34px] items-center rounded-full bg-[#E6BA5C]/12 px-3 py-1 text-[11px] font-semibold text-[#E6BA5C]">
                              {pos.expiryPaused
                                ? t.statusDisputed
                                : t.awaitingTwapShortLabel}
                            </span>
                          ) : pos.inTwapWindow ? (
                            <span className="inline-flex min-h-[34px] items-center gap-1 rounded-full bg-[#E6BA5C]/12 px-3 py-1 text-[11px] font-semibold text-[#E6BA5C]">
                              <Lock
                                className="h-3 w-3 shrink-0"
                                aria-hidden="true"
                              />
                              <span>{t.statusTwapWindow}</span>
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => handleOpenEarlyClose(pos)}
                              className="min-h-[34px] [@media(pointer:coarse)]:min-h-[40px] rounded-full bg-[#24282f] px-4 py-1.5 text-xs font-bold text-white hover:bg-white hover:text-black active:scale-[0.98] transition cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
                            >
                              {t.actionSell}
                            </button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
          </div>
        )}
      </div>

      {/* B4 Early Close Dark Sell Sheet */}
      {activeClosingPos && (
        <EarlyCloseModal
          locale={locale}
          position={activeClosingPos}
          stage={closeStage}
          slippagePause={closeSlippagePause}
          errorMsg={closeErr}
          onInstantSell={(ratio) =>
            void handleInstantSell(activeClosingPos, ratio)
          }
          onConfirmSlippageClose={() => void handleConfirmSlippageClose()}
          onClearSlippagePause={() => {
            setCloseSlippagePause(undefined);
            setCloseStage("IDLE");
            setCloseErr(undefined);
          }}
          onCloseModal={() => {
            setClosingPos(null);
            setCloseSlippagePause(undefined);
            setCloseStage("IDLE");
            setCloseErr(undefined);
          }}
        />
      )}

      {/* Rules, Oracle & Settlement History Sheet */}
      <RulesOracleSheet
        open={rulesSheetOpen}
        onClose={onCloseRules}
        locale={locale}
        underlying={underlying}
        direction={direction}
        tenor={tenor}
        expiryIso={shelf?.expiryIso ?? new Date().toISOString()}
        ticket={activeTicket}
        grid={shelf?.grid}
        spot={displaySpot}
        atlasTelemetry={activeTelemetry}
        rwaTelemetry={activeRwaTelemetry}
        consensusGuard={activeGuard}
        signerAddress={health?.atlasSignerAddress}
        oracleAddress={health?.settlementOracleAddress}
        onReplayOnboarding={onOpenOnboarding}
      />
    </main>
  );
}

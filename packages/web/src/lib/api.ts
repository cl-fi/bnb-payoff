import type {
  AtlasConsensusStatus,
  AtlasFeedConfig,
  AtlasFeedTelemetry,
  CandleBar,
  CandlePoint,
  CloseRfqResponse,
  DataSourceStatus,
  Direction,
  ExpiryTenor,
  FixedGridMeta,
  HedgeLedgerEntry,
  OfficialSettlementPrice,
  OpenRfqResponse,
  Phase1Metrics,
  PositionView,
  TicketSummary,
  TierKind,
  UnderlyingSymbol,
} from "@payoff/shared";

export interface ConsensusGuardState {
  settlementSafe: boolean;
  quotingSafe: boolean;
  paused: boolean;
  reason: string | null;
  consensusStatus: AtlasConsensusStatus;
  consensusScore: number | null;
}

export interface HealthResponse {
  ok: boolean;
  chainId: number;
  isLocalDev: boolean;
  rpcUrl: string;
  usdtAddress: `0x${string}`;
  vaultAddress: `0x${string}`;
  lensAddress?: `0x${string}`;
  settlementOracleAddress?: `0x${string}`;
  settlementOracleSource?: string;
  atlasSignerAddress?: `0x${string}`;
  oracleAddress?: `0x${string}`;
  dbEngine?: "postgres" | "sqlite";
  protocolFeeBps: number;
  closeFeeBps?: number;
  effectiveNow: number;
  dataSource: DataSourceStatus | string;
  dataSourceStatus?: DataSourceStatus | string;
  spots: Record<UnderlyingSymbol, number>;
  atlasTelemetry?: Partial<Record<UnderlyingSymbol, AtlasFeedTelemetry>>;
  settlementCircuitBreaker?: Partial<
    Record<UnderlyingSymbol, ConsensusGuardState>
  >;
  vaultHealth: {
    usdtBalanceUsdt: number;
    lockedUsdt: number;
    makerMarginUsdt?: number;
    accruedProtocolFeesUsdt?: number;
    isSolvent: boolean;
  };
}

export interface OracleConsensusResponse {
  oracle: string;
  signerAddress: `0x${string}`;
  oracleAddress?: `0x${string}`;
  feeds: Record<UnderlyingSymbol, AtlasFeedConfig>;
  telemetry: Partial<Record<UnderlyingSymbol, AtlasFeedTelemetry>>;
  circuitBreaker: Partial<Record<UnderlyingSymbol, ConsensusGuardState>>;
  wsConnected?: boolean;
  updatedAtMs: number;
}

export interface SettlementHistoryRecord extends OfficialSettlementPrice {
  settledAt?: number;
}

export interface SettlementHistoryResponse {
  underlying: UnderlyingSymbol;
  feedId: string;
  feedIdHex?: `0x${string}`;
  pair?: string;
  oracleAddress?: `0x${string}`;
  signerAddress?: `0x${string}`;
  source?: string;
  records: SettlementHistoryRecord[];
}

export interface ShelfResponse {
  underlying: UnderlyingSymbol;
  direction: Direction;
  tenor: ExpiryTenor;
  stakeUsdt: number;
  spot: number;
  change24hPct: number;
  dataSource: DataSourceStatus | string;
  atlasTelemetry?: AtlasFeedTelemetry;
  quotingGuard?: ConsensusGuardState;
  expiry: number;
  expiryIso: string;
  hoursToExpiry: number;
  availableStrikes: number[];
  grid?: FixedGridMeta;
  tiers: TicketSummary[];
}

export interface DemoAccountInfo {
  chainId: number;
  rpcUrl: string;
  address: `0x${string}`;
  privateKey: `0x${string}`;
  usdtAddress: `0x${string}`;
  vaultAddress: `0x${string}`;
}

const API_BASE = ((import.meta as any).env?.VITE_API_BASE || "").replace(
  /\/+$/,
  ""
);

export function getWsUrl(address?: string): string {
  const qs = address ? `?address=${encodeURIComponent(address)}` : "";
  if (API_BASE) {
    const wsBase = API_BASE.replace(/^https:/i, "wss:").replace(
      /^http:/i,
      "ws:"
    );
    return `${wsBase}/ws/stream${qs}`;
  }
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws/stream${qs}`;
}

async function reqJson<T>(url: string, init?: RequestInit): Promise<T> {
  const target = url.startsWith("http") ? url : `${API_BASE}${url}`;
  const res = await fetch(target, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error || `Request failed (${res.status})`);
  }
  return data as T;
}

export const api = {
  getHealth: () => reqJson<HealthResponse>("/api/health"),

  getOracleConsensus: () =>
    reqJson<OracleConsensusResponse>("/api/oracle/consensus"),

  getSettlementHistory: (underlying: UnderlyingSymbol, limit = 10) =>
    reqJson<SettlementHistoryResponse>(
      `/api/market/settlement-history?underlying=${underlying}&limit=${limit}`
    ),

  getCandles: (params: {
    underlying: UnderlyingSymbol;
    bar: CandleBar;
    limit?: number;
  }) =>
    reqJson<{
      underlying: UnderlyingSymbol;
      bar: CandleBar;
      candles: CandlePoint[];
    }>(
      `/api/market/candles?underlying=${params.underlying}&bar=${params.bar}&limit=${params.limit ?? 120}`
    ),

  getShelf: (params: {
    underlying: UnderlyingSymbol;
    direction: Direction;
    tenor: ExpiryTenor;
    stakeUsdt: number;
  }) =>
    reqJson<ShelfResponse>(
      `/api/market/shelf?underlying=${params.underlying}&direction=${params.direction}&tenor=${params.tenor}&stake=${params.stakeUsdt}`
    ),

  previewCustom: (body: {
    underlying: UnderlyingSymbol;
    direction: Direction;
    tenor: ExpiryTenor;
    lowerStrike: number;
    upperStrike: number;
    stakeUsdt: number;
  }) =>
    reqJson<{ ticket: TicketSummary; availableStrikes: number[] }>(
      "/api/market/preview-custom",
      { method: "POST", body: JSON.stringify(body) }
    ),

  requestOpenRfq: (body: {
    taker: `0x${string}`;
    underlying: UnderlyingSymbol;
    direction: Direction;
    tenor: ExpiryTenor;
    tierKind: TierKind;
    lowerStrike: number;
    upperStrike: number;
    stakeUsdt: number;
  }) =>
    reqJson<OpenRfqResponse>("/api/rfq/open", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  requestCloseRfq: (body: {
    taker: `0x${string}`;
    seriesId: `0x${string}`;
    isUp: boolean;
    closeAmountUsdt?: number;
  }) =>
    reqJson<CloseRfqResponse>("/api/rfq/close", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  syncChain: () =>
    reqJson<{ ok: boolean }>("/api/chain/sync", { method: "POST", body: "{}" }),

  ingestTx: (txHash: string) =>
    reqJson<{ ok: boolean; processedEvents: number; blockNumber: number }>(
      "/api/tx/ingest",
      { method: "POST", body: JSON.stringify({ txHash }) }
    ),

  getPositions: (address: string) =>
    reqJson<{ positions: PositionView[] }>(`/api/positions/${address}`),

  getMetrics: () => reqJson<Phase1Metrics>("/api/metrics"),

  getLedger: (limit = 50) =>
    reqJson<{ entries: HedgeLedgerEntry[] }>(`/api/ledger?limit=${limit}`),

  getDemoAccount: () => reqJson<DemoAccountInfo>("/api/dev/demo-account"),

  claimFaucet: (address: `0x${string}`) =>
    reqJson<{ ok: boolean; txHash: string }>("/api/dev/faucet", {
      method: "POST",
      body: JSON.stringify({ address }),
    }),

  simulateExpiry: (body: {
    underlying: UnderlyingSymbol;
    expiry: number;
    settlementPrice: number;
  }) =>
    reqJson<{ ok: boolean; txHash: string; newBlockTimestamp: number }>(
      "/api/dev/simulate-expiry",
      { method: "POST", body: JSON.stringify(body) }
    ),
};

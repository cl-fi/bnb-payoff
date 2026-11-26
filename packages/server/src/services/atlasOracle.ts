import WebSocket, { type RawData } from "ws";
import { concatHex, keccak256, padHex, recoverAddress, type Hex } from "viem";
import { sign } from "viem/accounts";
import {
  ASSET_SPECS,
  ATLAS_FEEDS,
  ATLAS_MAGIC_MARKER,
  ATLAS_OFFICIAL_SIGNER,
  SETTLEMENT_EXACT_MATCH_GRACE_SEC,
  SETTLEMENT_FALLBACK_TOLERANCE_SEC,
  SETTLEMENT_TWAP_INTERVAL_SEC,
  SETTLEMENT_TWAP_SAMPLE_COUNT,
  SUPPORTED_UNDERLYINGS,
  type AtlasConsensusStatus,
  type AtlasFeedConfig,
  type AtlasFeedTelemetry,
  type SettlementSource,
  type UnderlyingSymbol,
} from "@payoff/shared";

export const ATLAS_API_BASE = "https://api.atlasoracle.io/report";
export const ATLAS_WS_BASE = "wss://push.atlasoracle.io/ws";

const MAX_LOW_S_VALUE =
  0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
const FEED_PACKAGE_BYTES = 20;
const PRICE_DECIMALS_DIFF = 10n ** 10n; // 18-dec Atlas -> 8-dec Vault

export interface AtlasConsensusScoreRaw {
  feedId: string;
  consensusScore?: number | string | null;
  consensusStatus?: string | null;
  twapPrice?: number | string | null;
  medianPrice?: number | string | null;
  priceChangePct?: number | string | null;
  priceVolatility?: number | string | null;
}

export interface AtlasPriceDetailRaw {
  feedId: string;
  timestampSeconds?: string | number;
  price?: number | string;
}

export interface AtlasSignedPayloadData {
  payload?: string;
  signature?: string;
  magicMarker?: string;
  parsedPayload?: string;
  consensusScores?: AtlasConsensusScoreRaw[];
  priceDetails?: AtlasPriceDetailRaw[];
}

export interface AtlasApiResponse {
  data?: AtlasSignedPayloadData;
  status?: {
    error_code?: string;
    error_message?: string;
  };
}

export interface DecodedAtlasPackage {
  feedId: string;
  feedIdHex: Hex;
  price18: bigint;
  price8: bigint;
  priceUsd: number;
  timestampSeconds: number;
}

export interface VerifiedAtlasPayload {
  payload: Hex;
  signature: Hex;
  magicMarker: Hex;
  extraData: Hex;
  recoveredSigner: Hex;
  packages: DecodedAtlasPackage[];
}

export interface AtlasSignedProofResult {
  underlying: UnderlyingSymbol;
  feedId: string;
  feedIdHex: Hex;
  payload: Hex;
  signature: Hex;
  magicMarker: Hex;
  extraData: Hex;
  price18: bigint;
  price8: bigint;
  priceUsd: number;
  timestampSeconds: number;
  recoveredSigner: Hex;
  source: Extract<SettlementSource, "ATLAS_PULL_HISTORY" | "ATLAS_PULL_LATEST">;
}

export interface AtlasSignedTwapResult {
  underlying: UnderlyingSymbol;
  expiry: number;
  feedId: string;
  feedIdHex: Hex;
  sampleCount: number;
  sampleIntervalSec: number;
  targetTimestamps: number[];
  actualTimestamps: number[];
  maxAbsTimestampDiffSec: number;
  proofs: Hex[];
  twapPrice8: bigint;
  twapPriceUsd: number;
  windowStartTimestamp: number;
  windowEndTimestamp: number;
  recoveredSigner: Hex;
  source: "ATLAS_TWAP_30M";
}

export function buildTwapSampleTimestamps(
  expirySec: number,
  sampleCount: number = SETTLEMENT_TWAP_SAMPLE_COUNT,
  intervalSec: number = SETTLEMENT_TWAP_INTERVAL_SEC
): number[] {
  const out: number[] = [];
  for (let i = 0; i < sampleCount; i++) {
    out.push(expirySec - (sampleCount - 1 - i) * intervalSec);
  }
  return out;
}

export interface ConsensusGuardState {
  settlementSafe: boolean;
  quotingSafe: boolean;
  paused: boolean;
  reason: string | null;
  consensusStatus: AtlasConsensusStatus;
  consensusScore: number | null;
}

export type AtlasHttpFetcher = (
  endpoint: "/v1/price/latest" | "/v1/price/history",
  body: Record<string, unknown>
) => Promise<AtlasSignedPayloadData>;

export function normalizeHex(value: string): Hex {
  const trimmed = value.trim();
  const body =
    trimmed.startsWith("0x") || trimmed.startsWith("0X")
      ? trimmed.slice(2)
      : trimmed;
  if (!/^[0-9a-fA-F]*$/.test(body) || body.length === 0 || body.length % 2 !== 0) {
    throw new Error("Invalid hex payload from Atlas Oracle");
  }
  return `0x${body.toLowerCase()}` as Hex;
}

export function feedIdToHex(feedId: string): Hex {
  const num = Number(feedId);
  if (!Number.isInteger(num) || num <= 0 || num > 0xffffffff) {
    throw new Error(`Invalid Atlas feedId: ${feedId}`);
  }
  return `0x${num.toString(16).padStart(8, "0")}` as Hex;
}

export function parseAtlasConsensusStatus(
  raw?: string | null
): AtlasConsensusStatus {
  const upper = (raw || "").trim().toUpperCase();
  switch (upper) {
    case "HEALTHY":
    case "DEGRADED":
    case "WARNING":
    case "CRITICAL":
    case "SPLIT_MARKET":
      return upper;
    default:
      return "UNKNOWN";
  }
}

function toFiniteNumber(val: unknown): number | null {
  if (val === null || val === undefined || val === "") return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

/**
 * Evaluates Atlas Enterprise ConsensusScore circuit-breaker rules:
 * - Automated settlement pauses on WARNING / CRITICAL / SPLIT_MARKET or score < 0.70
 * - New OpenQuote quoting halts on CRITICAL / SPLIT_MARKET
 */
export function evaluateConsensusGuard(
  telemetry?: Pick<AtlasFeedTelemetry, "consensusStatus" | "consensusScore"> | null
): ConsensusGuardState {
  const status: AtlasConsensusStatus = telemetry?.consensusStatus ?? "UNKNOWN";
  const score: number | null = telemetry?.consensusScore ?? null;

  const quotingHalted = status === "CRITICAL" || status === "SPLIT_MARKET";
  const statusBlocksSettlement =
    status === "WARNING" || status === "CRITICAL" || status === "SPLIT_MARKET";
  const scoreBlocksSettlement = score !== null && score < 0.7;

  const settlementSafe = !statusBlocksSettlement && !scoreBlocksSettlement;
  const quotingSafe = !quotingHalted;
  const paused = !settlementSafe;

  let reason: string | null = null;
  if (status === "SPLIT_MARKET") {
    reason =
      "Atlas ConsensusScore SPLIT_MARKET: automated settlement and new quotes halted";
  } else if (status === "CRITICAL") {
    reason =
      "Atlas ConsensusScore CRITICAL: automated settlement and new quotes halted";
  } else if (status === "WARNING") {
    reason =
      "Atlas ConsensusScore WARNING: automated settlement paused by circuit breaker";
  } else if (scoreBlocksSettlement) {
    reason = `Atlas ConsensusScore ${(score! * 100).toFixed(1)}% below 70.0% settlement threshold`;
  }

  return {
    settlementSafe,
    quotingSafe,
    paused,
    reason,
    consensusStatus: status,
    consensusScore: score,
  };
}

/**
 * Decodes binary Atlas Pull payload `[Packages (20B * count)][Count (1B)]`
 * matching `PullOracleCodec.sol` bit-for-bit.
 */
export function decodeAtlasPayloadPackages(
  payloadInput: string
): DecodedAtlasPackage[] {
  const payloadHex = normalizeHex(payloadInput);
  const raw = payloadHex.slice(2);
  const byteLen = raw.length / 2;
  if (byteLen < FEED_PACKAGE_BYTES + 1) {
    throw new Error(`Atlas payload too short (${byteLen} bytes)`);
  }

  const count = parseInt(raw.slice(raw.length - 2), 16);
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error(`Invalid Atlas package count: ${count}`);
  }
  const expectedBytes = count * FEED_PACKAGE_BYTES + 1;
  if (byteLen !== expectedBytes) {
    throw new Error(
      `Atlas payload length mismatch: expected ${expectedBytes} bytes for count=${count}, got ${byteLen}`
    );
  }

  const packages: DecodedAtlasPackage[] = [];
  for (let i = 0; i < count; i++) {
    const start = i * FEED_PACKAGE_BYTES * 2;
    const feedHexBody = raw.slice(start, start + 8);
    const priceHexBody = raw.slice(start + 8, start + 28);
    const tsHexBody = raw.slice(start + 28, start + 40);

    const feedIdHex = `0x${feedHexBody}` as Hex;
    const feedId = String(parseInt(feedHexBody, 16));
    const price18 = BigInt(`0x${priceHexBody}`);
    const price8 = price18 / PRICE_DECIMALS_DIFF;
    const priceUsd = Number(price8) / 1e8;
    const timestampSeconds = Number(BigInt(`0x${tsHexBody}`));

    packages.push({
      feedId,
      feedIdHex,
      price18,
      price8,
      priceUsd,
      timestampSeconds,
    });
  }
  return packages;
}

/**
 * Validates and concatenates Atlas trailing calldata `extraData`:
 * `concatHex([payload, signature, magicMarker])`.
 */
export function assembleAtlasExtraData(
  payload: string,
  signature: string,
  magicMarker: string = ATLAS_MAGIC_MARKER
): Hex {
  const payloadHex = normalizeHex(payload);
  const signatureHex = normalizeHex(signature);
  const markerHex = normalizeHex(magicMarker);

  // Validate payload package framing
  decodeAtlasPayloadPackages(payloadHex);

  const sigBody = signatureHex.slice(2);
  if (sigBody.length !== 130) {
    throw new Error(
      `Invalid Atlas signature length: expected 65 bytes, got ${sigBody.length / 2}`
    );
  }

  // EIP-2 low-s malleability check (matches PullOracleSignature.sol)
  const s = BigInt(`0x${sigBody.slice(64, 128)}`);
  if (s === 0n || s > MAX_LOW_S_VALUE) {
    throw new Error("Atlas signature fails EIP-2 low-s check");
  }

  if (markerHex.toLowerCase() !== ATLAS_MAGIC_MARKER.toLowerCase()) {
    throw new Error(
      `Unexpected Atlas magicMarker: expected ${ATLAS_MAGIC_MARKER}, got ${markerHex}`
    );
  }

  return concatHex([payloadHex, signatureHex, markerHex]);
}

/**
 * Performs off-chain ECDSA pre-verification identical to `PullOracleSignature._recoverSigner`:
 * raw `keccak256(payload)` (without EIP-191 prefix) recovered against `expectedSigner`.
 */
export async function verifyAtlasSignedPayload(params: {
  payload: string;
  signature: string;
  magicMarker?: string;
  expectedSigner?: Hex;
}): Promise<VerifiedAtlasPayload> {
  const payloadHex = normalizeHex(params.payload);
  const signatureHex = normalizeHex(params.signature);
  const markerHex = normalizeHex(params.magicMarker ?? ATLAS_MAGIC_MARKER);
  const extraData = assembleAtlasExtraData(payloadHex, signatureHex, markerHex);
  const packages = decodeAtlasPayloadPackages(payloadHex);

  const digest = keccak256(payloadHex);
  const recoveredSigner = await recoverAddress({
    hash: digest,
    signature: signatureHex,
  });

  const expected = params.expectedSigner ?? ATLAS_OFFICIAL_SIGNER;
  if (recoveredSigner.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(
      `Atlas signer mismatch: recovered ${recoveredSigner}, expected ${expected}`
    );
  }

  return {
    payload: payloadHex,
    signature: signatureHex,
    magicMarker: markerHex,
    extraData,
    recoveredSigner,
    packages,
  };
}

/**
 * Builds a valid Atlas Pull proof signed by a local private key (used for local Hardhat devnet
 * simulation and unit tests).
 */
export async function buildSignedAtlasProofWithKey(params: {
  privateKey: Hex;
  packages: Array<{
    feedIdHex: Hex;
    price18: bigint;
    timestampSeconds: number;
  }>;
  magicMarker?: Hex;
}): Promise<{ payload: Hex; signature: Hex; magicMarker: Hex; extraData: Hex }> {
  const marker = normalizeHex(params.magicMarker ?? ATLAS_MAGIC_MARKER);
  const pkgHexes = params.packages.map((pkg) => {
    const feedBody = normalizeHex(pkg.feedIdHex).slice(2);
    if (feedBody.length !== 8) {
      throw new Error(`feedIdHex must be 4 bytes, got ${pkg.feedIdHex}`);
    }
    const priceHex = pkg.price18.toString(16).padStart(20, "0");
    const tsHex = BigInt(pkg.timestampSeconds).toString(16).padStart(12, "0");
    return `0x${feedBody}${priceHex}${tsHex}` as Hex;
  });
  const countHex = `0x${params.packages.length.toString(16).padStart(2, "0")}` as Hex;
  const payload = concatHex([...pkgHexes, countHex]);

  const digest = keccak256(payload);
  const sigObj = await sign({
    hash: digest,
    privateKey: params.privateKey,
    to: "object",
  });
  const vRaw =
    sigObj.v !== undefined ? Number(sigObj.v) : 27 + (sigObj.yParity ?? 0);
  const vNum = vRaw === 0 || vRaw === 1 ? vRaw + 27 : vRaw;
  const vHex = `0x${vNum.toString(16).padStart(2, "0")}` as Hex;
  const rHex = padHex(sigObj.r, { size: 32 });
  const sHex = padHex(sigObj.s, { size: 32 });
  const signature = concatHex([rHex, sHex, vHex]);
  const extraData = concatHex([payload, signature, marker]);
  return { payload, signature, magicMarker: marker, extraData };
}

function parseParsedPayloadJson(
  raw?: string
): Array<{ feedId: string; price18: bigint; timestampSeconds: number }> {
  if (!raw) return [];
  try {
    // Quote large 18-decimal integer price values before JSON.parse to preserve precision
    const normalized = raw.replace(/"price"\s*:\s*(\d+)/g, '"price":"$1"');
    const arr = JSON.parse(normalized) as Array<{
      feedId?: string | number;
      price?: string | number;
      timestampSeconds?: string | number;
    }>;
    if (!Array.isArray(arr)) return [];
    const out: Array<{ feedId: string; price18: bigint; timestampSeconds: number }> = [];
    for (const item of arr) {
      if (item.feedId === undefined || item.price === undefined) continue;
      const ts = Number(item.timestampSeconds ?? 0);
      try {
        out.push({
          feedId: String(item.feedId),
          price18: BigInt(String(item.price)),
          timestampSeconds: Number.isFinite(ts) ? ts : 0,
        });
      } catch {
        // ignore unparseable entry
      }
    }
    return out;
  } catch {
    return [];
  }
}

export interface AtlasOracleServiceOptions {
  apiKey?: string;
  btcFeedId?: string;
  ethFeedId?: string;
  nvdabFeedId?: string;
  authorizedSigner?: Hex;
  enableLiveAtlas?: boolean;
  pollIntervalMs?: number;
  expiryWindowSec?: number;
  onTelemetryUpdate?: (telemetry: AtlasFeedTelemetry) => void;
  httpFetcher?: AtlasHttpFetcher;
}

export class AtlasOracleService {
  private readonly apiKey?: string;
  private readonly feeds: Record<UnderlyingSymbol, AtlasFeedConfig>;
  private readonly feedIdToUnderlying = new Map<string, UnderlyingSymbol>();
  private readonly authorizedSigner: Hex;
  private readonly enableLiveAtlas: boolean;
  private readonly pollIntervalMs: number;
  private readonly expiryWindowSec: number;
  private readonly onTelemetryUpdate?: (telemetry: AtlasFeedTelemetry) => void;
  private httpFetcher?: AtlasHttpFetcher;

  private telemetry = new Map<UnderlyingSymbol, AtlasFeedTelemetry>();
  private baseline24hPrice = new Map<UnderlyingSymbol, { price: number; fetchedAtMs: number }>();
  private lastLiveUpdateMs = new Map<UnderlyingSymbol, number>();

  private ws: WebSocket | null = null;
  private wsConnected = false;
  private lastWsMessageMs = 0;
  private stopped = true;
  private reconnectAttempts = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private pollTimer?: NodeJS.Timeout;
  private baselineTimer?: NodeJS.Timeout;
  private twapCache = new Map<
    string,
    { cachedAtMs: number; result: AtlasSignedTwapResult }
  >();
  private twapFailureCache = new Map<
    string,
    { failedAtMs: number; message: string }
  >();
  private twapInFlight = new Map<string, Promise<AtlasSignedTwapResult | null>>();

  constructor(opts: AtlasOracleServiceOptions = {}) {
    this.apiKey = opts.apiKey?.trim() || undefined;
    const feedIdOverrides: Partial<Record<UnderlyingSymbol, string | undefined>> =
      {
        BTC: opts.btcFeedId?.trim(),
        ETH: opts.ethFeedId?.trim(),
        NVDAB: opts.nvdabFeedId?.trim(),
      };
    const feedsInit = {} as Record<UnderlyingSymbol, AtlasFeedConfig>;
    for (const sym of SUPPORTED_UNDERLYINGS) {
      const feedId = feedIdOverrides[sym] || ATLAS_FEEDS[sym].feedId;
      feedsInit[sym] = {
        feedId,
        feedIdHex: feedIdToHex(feedId),
        pair: ATLAS_FEEDS[sym].pair,
      };
      this.feedIdToUnderlying.set(feedId, sym);
    }
    this.feeds = feedsInit;

    this.authorizedSigner = opts.authorizedSigner ?? ATLAS_OFFICIAL_SIGNER;
    this.enableLiveAtlas = opts.enableLiveAtlas ?? true;
    this.pollIntervalMs = Math.max(2000, opts.pollIntervalMs ?? 5000);
    this.expiryWindowSec = opts.expiryWindowSec ?? 60;
    this.onTelemetryUpdate = opts.onTelemetryUpdate;
    this.httpFetcher = opts.httpFetcher;

    const nowSec = Math.floor(Date.now() / 1000);
    for (const sym of SUPPORTED_UNDERLYINGS) {
      const cfg = this.feeds[sym];
      this.telemetry.set(sym, {
        underlying: sym,
        feedId: cfg.feedId,
        feedIdHex: cfg.feedIdHex,
        price: ASSET_SPECS[sym].defaultSpot,
        timestampSeconds: nowSec,
        consensusScore: null,
        consensusStatus: "UNKNOWN",
        twapPrice: null,
        medianPrice: null,
        priceChangePct: null,
        priceVolatility: null,
        updatedAtMs: 0,
      });
    }
  }

  setHttpFetcher(fetcher?: AtlasHttpFetcher) {
    this.httpFetcher = fetcher;
  }

  getAuthorizedSigner(): Hex {
    return this.authorizedSigner;
  }

  getFeedsConfig(): Record<UnderlyingSymbol, AtlasFeedConfig> {
    const out = {} as Record<UnderlyingSymbol, AtlasFeedConfig>;
    for (const sym of SUPPORTED_UNDERLYINGS) {
      out[sym] = { ...this.feeds[sym] };
    }
    return out;
  }

  isWsConnected(): boolean {
    return this.wsConnected;
  }

  /**
   * True only when live Atlas feeds are both enabled AND configured with an API key
   * or injected test fetcher (prevents false 503 blocks in synthetic local dev mode).
   */
  isLiveModeActive(): boolean {
    return this.enableLiveAtlas && Boolean(this.apiKey || this.httpFetcher);
  }

  isLiveDataAvailable(
    underlying?: UnderlyingSymbol,
    maxAgeMs = 60_000
  ): boolean {
    if (!this.enableLiveAtlas && !this.httpFetcher) return false;
    const now = Date.now();
    const nowSec = Math.floor(now / 1000);
    const maxOracleLagSec = Math.max(90, Math.ceil(maxAgeMs / 1000) + 30);
    if (underlying) {
      const receivedAtMs = this.lastLiveUpdateMs.get(underlying) ?? 0;
      if (!(receivedAtMs > 0 && now - receivedAtMs <= maxAgeMs)) {
        return false;
      }
      const tel = this.telemetry.get(underlying);
      if (!tel || !(tel.timestampSeconds > 0)) return false;
      return nowSec - tel.timestampSeconds <= maxOracleLagSec;
    }
    return SUPPORTED_UNDERLYINGS.some((sym) =>
      this.isLiveDataAvailable(sym, maxAgeMs)
    );
  }

  getTelemetry(underlying: UnderlyingSymbol): AtlasFeedTelemetry {
    return { ...this.telemetry.get(underlying)! };
  }

  getAllTelemetry(): Record<UnderlyingSymbol, AtlasFeedTelemetry> {
    const out = {} as Record<UnderlyingSymbol, AtlasFeedTelemetry>;
    for (const sym of SUPPORTED_UNDERLYINGS) {
      out[sym] = this.getTelemetry(sym);
    }
    return out;
  }

  /** Test & local simulation helper for injecting ConsensusScore / telemetry states. */
  setTelemetryOverride(
    underlying: UnderlyingSymbol,
    patch: Partial<AtlasFeedTelemetry>,
    markLive = false
  ) {
    const current = this.telemetry.get(underlying)!;
    const next: AtlasFeedTelemetry = {
      ...current,
      ...patch,
      underlying,
      updatedAtMs: patch.updatedAtMs ?? Date.now(),
    };
    this.telemetry.set(underlying, next);
    if (markLive) {
      this.lastLiveUpdateMs.set(underlying, Date.now());
    }
    this.onTelemetryUpdate?.(next);
  }

  get24hChangePct(underlying: UnderlyingSymbol): number {
    const t = this.telemetry.get(underlying);
    if (!t) return 0;
    const baseline = this.baseline24hPrice.get(underlying);
    if (baseline && baseline.price > 0 && t.price > 0) {
      return Number((((t.price - baseline.price) / baseline.price) * 100).toFixed(2));
    }
    if (t.priceChangePct !== null && Number.isFinite(t.priceChangePct)) {
      return Number(t.priceChangePct.toFixed(2));
    }
    return 0;
  }

  getConsensusGuard(underlying: UnderlyingSymbol): ConsensusGuardState {
    return evaluateConsensusGuard(this.telemetry.get(underlying));
  }

  getAllConsensusGuards(): Record<UnderlyingSymbol, ConsensusGuardState> {
    const out = {} as Record<UnderlyingSymbol, ConsensusGuardState>;
    for (const sym of SUPPORTED_UNDERLYINGS) {
      out[sym] = this.getConsensusGuard(sym);
    }
    return out;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;

    if (!this.enableLiveAtlas) return;
    if (!this.apiKey && !this.httpFetcher) {
      console.warn(
        "[AtlasOracle] ATLAS_API_KEY not configured; running in synthetic fallback mode"
      );
      return;
    }

    // Warm telemetry immediately via HTTP, then keep live over Enterprise WebSocket
    void this.refreshLatest();
    void this.refresh24hBaselines();

    if (this.apiKey) {
      this.connectWebSocket();
    }

    // Fallback HTTP poll & WS zombie connection watchdog
    this.pollTimer = setInterval(() => {
      const now = Date.now();
      if (this.wsConnected && this.ws) {
        const wsSilentMs = now - this.lastWsMessageMs;
        if (wsSilentMs > 30_000) {
          // Half-open / zombie WebSocket: terminate and let close handler reconnect
          this.wsConnected = false;
          try {
            this.ws.terminate();
          } catch {
            // ignore terminate error
          }
        } else if (wsSilentMs > 15_000) {
          try {
            this.ws.ping();
          } catch {
            // ignore ping error
          }
        }
      }
      const anyStale = SUPPORTED_UNDERLYINGS.some(
        (sym) => now - (this.lastLiveUpdateMs.get(sym) ?? 0) > 15_000
      );
      if (!this.wsConnected || anyStale) {
        void this.refreshLatest();
      }
    }, this.pollIntervalMs);
    this.pollTimer.unref?.();

    this.baselineTimer = setInterval(() => {
      void this.refresh24hBaselines();
    }, 300_000);
    this.baselineTimer.unref?.();
  }

  stop() {
    this.stopped = true;
    this.wsConnected = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.baselineTimer) {
      clearInterval(this.baselineTimer);
      this.baselineTimer = undefined;
    }
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.on("error", () => {});
        this.ws.terminate();
      } catch {
        // ignore close error
      }
      this.ws = null;
    }
  }

  private connectWebSocket() {
    if (this.stopped || !this.enableLiveAtlas || !this.apiKey) return;

    const wsUrl = `${ATLAS_WS_BASE}?apiKey=${encodeURIComponent(this.apiKey)}`;
    const socket = new WebSocket(wsUrl);
    this.ws = socket;

    socket.on("open", () => {
      if (this.stopped) {
        socket.terminate();
        return;
      }
      this.wsConnected = true;
      this.lastWsMessageMs = Date.now();
      this.reconnectAttempts = 0;
      const subPayload = {
        method: "SUBSCRIPTION",
        params: SUPPORTED_UNDERLYINGS.map(
          (sym) => `modix@auth.price@${this.feeds[sym].feedId}`
        ),
      };
      try {
        socket.send(JSON.stringify(subPayload));
      } catch {
        // will trigger close/reconnect
      }
    });

    socket.on("pong", () => {
      this.lastWsMessageMs = Date.now();
    });

    socket.on("message", (raw: RawData) => {
      this.lastWsMessageMs = Date.now();
      try {
        const text = typeof raw === "string" ? raw : raw.toString("utf8");
        const parsed = JSON.parse(text) as { d?: AtlasSignedPayloadData };
        if (parsed && parsed.d) {
          this.ingestAtlasPayloadData(parsed.d);
        }
      } catch {
        // ignore non-data / ack / heartbeat frames
      }
    });

    socket.on("error", () => {
      // Never log raw WS error URL (may contain apiKey query param)
      this.wsConnected = false;
    });

    socket.on("close", () => {
      this.wsConnected = false;
      if (this.ws === socket) {
        this.ws = null;
      }
      if (!this.stopped) {
        this.scheduleReconnect();
      }
    });
  }

  private scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const delayMs = Math.min(60_000, 2000 * 2 ** Math.min(this.reconnectAttempts, 5));
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connectWebSocket();
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  private async postAtlasApi(
    endpoint: "/v1/price/latest" | "/v1/price/history",
    body: Record<string, unknown>
  ): Promise<AtlasSignedPayloadData> {
    if (this.httpFetcher) {
      return this.httpFetcher(endpoint, body);
    }
    if (!this.apiKey) {
      throw new Error("ATLAS_API_KEY is not configured");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(`${ATLAS_API_BASE}${endpoint}`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "X-API-KEY": this.apiKey,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        throw new Error(`Atlas API ${endpoint} HTTP ${res.status}`);
      }
      const json = (await res.json()) as AtlasApiResponse;
      if (!json.data) {
        const msg = json.status?.error_message || "empty Atlas response";
        throw new Error(`Atlas API ${endpoint} error: ${msg}`);
      }
      return json.data;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Ingests a `data` / `msg.d` block from Atlas HTTP `/v1/price/latest` or Enterprise WS
   * and updates live `AtlasFeedTelemetry` per asset.
   */
  ingestAtlasPayloadData(data: AtlasSignedPayloadData): AtlasFeedTelemetry[] {
    const nowMs = Date.now();
    const updated: AtlasFeedTelemetry[] = [];

    const consensusByFeed = new Map<string, AtlasConsensusScoreRaw>();
    for (const cs of data.consensusScores || []) {
      if (cs?.feedId !== undefined) {
        consensusByFeed.set(String(cs.feedId), cs);
      }
    }

    const detailsByFeed = new Map<string, AtlasPriceDetailRaw>();
    for (const d of data.priceDetails || []) {
      if (d?.feedId !== undefined) {
        detailsByFeed.set(String(d.feedId), d);
      }
    }

    const parsedEntries = parseParsedPayloadJson(data.parsedPayload);
    const parsedByFeed = new Map(parsedEntries.map((e) => [e.feedId, e]));

    const decodedByFeed = new Map<string, DecodedAtlasPackage>();
    if (data.payload) {
      try {
        for (const pkg of decodeAtlasPayloadPackages(data.payload)) {
          decodedByFeed.set(pkg.feedId, pkg);
        }
      } catch {
        // ignore if non-signed frame omits binary payload
      }
    }

    const touchedFeedIds = new Set<string>([
      ...consensusByFeed.keys(),
      ...detailsByFeed.keys(),
      ...parsedByFeed.keys(),
      ...decodedByFeed.keys(),
    ]);

    for (const feedId of touchedFeedIds) {
      const sym = this.feedIdToUnderlying.get(feedId);
      if (!sym) continue;

      const prev = this.telemetry.get(sym)!;
      const detail = detailsByFeed.get(feedId);
      const parsed = parsedByFeed.get(feedId);
      const decoded = decodedByFeed.get(feedId);
      const cs = consensusByFeed.get(feedId);

      const price =
        toFiniteNumber(detail?.price) ??
        decoded?.priceUsd ??
        (parsed ? Number(parsed.price18 / PRICE_DECIMALS_DIFF) / 1e8 : null) ??
        prev.price;

      const timestampSeconds =
        toFiniteNumber(detail?.timestampSeconds) ??
        decoded?.timestampSeconds ??
        parsed?.timestampSeconds ??
        prev.timestampSeconds;

      if (!(price > 0)) continue;

      const next: AtlasFeedTelemetry = {
        underlying: sym,
        feedId: this.feeds[sym].feedId,
        feedIdHex: this.feeds[sym].feedIdHex,
        price: Number(price.toFixed(6)),
        timestampSeconds: Math.floor(timestampSeconds),
        consensusScore: cs
          ? toFiniteNumber(cs.consensusScore)
          : prev.consensusScore,
        consensusStatus: cs
          ? parseAtlasConsensusStatus(cs.consensusStatus)
          : prev.consensusStatus,
        twapPrice: cs ? toFiniteNumber(cs.twapPrice) : prev.twapPrice,
        medianPrice: cs ? toFiniteNumber(cs.medianPrice) : prev.medianPrice,
        priceChangePct: cs
          ? toFiniteNumber(cs.priceChangePct)
          : prev.priceChangePct,
        priceVolatility: cs
          ? toFiniteNumber(cs.priceVolatility)
          : prev.priceVolatility,
        updatedAtMs: nowMs,
      };

      this.telemetry.set(sym, next);
      this.lastLiveUpdateMs.set(sym, nowMs);
      updated.push(next);
      this.onTelemetryUpdate?.(next);
    }

    return updated;
  }

  async refreshLatest(): Promise<boolean> {
    if (!this.enableLiveAtlas && !this.httpFetcher) return false;
    if (!this.apiKey && !this.httpFetcher) return false;

    try {
      const data = await this.postAtlasApi("/v1/price/latest", {
        feedIds: SUPPORTED_UNDERLYINGS.map((sym) => this.feeds[sym].feedId),
        signed: true,
      });
      const updated = this.ingestAtlasPayloadData(data);
      return updated.length > 0;
    } catch {
      return false;
    }
  }

  async refresh24hBaselines(): Promise<void> {
    if (!this.enableLiveAtlas && !this.httpFetcher) return;
    if (!this.apiKey && !this.httpFetcher) return;

    const ts24hAgo = Math.floor(Date.now() / 1000) - 86400;
    try {
      const data = await this.postAtlasApi("/v1/price/history", {
        feedIds: SUPPORTED_UNDERLYINGS.map((sym) => this.feeds[sym].feedId),
        timestamp: ts24hAgo,
        signed: false,
      });
      const nowMs = Date.now();
      for (const detail of data.priceDetails || []) {
        const sym = this.feedIdToUnderlying.get(String(detail.feedId));
        const px = toFiniteNumber(detail.price);
        if (sym && px && px > 0) {
          this.baseline24hPrice.set(sym, { price: px, fetchedAtMs: nowMs });
        }
      }
      if (
        this.baseline24hPrice.size < SUPPORTED_UNDERLYINGS.length &&
        data.parsedPayload
      ) {
        for (const p of parseParsedPayloadJson(data.parsedPayload)) {
          const sym = this.feedIdToUnderlying.get(p.feedId);
          if (sym && !this.baseline24hPrice.has(sym) && p.price18 > 0n) {
            const px = Number(p.price18 / PRICE_DECIMALS_DIFF) / 1e8;
            this.baseline24hPrice.set(sym, { price: px, fetchedAtMs: nowMs });
          }
        }
      }
    } catch {
      // keep existing baseline or fall back to consensusScore.priceChangePct
    }
  }

  /**
   * Fetches and cryptographically pre-verifies a live signed Atlas Pull proof
   * for `underlying` from `/v1/price/latest`.
   */
  async fetchSignedLatestProof(
    underlying: UnderlyingSymbol
  ): Promise<AtlasSignedProofResult> {
    const feed = this.feeds[underlying];
    const data = await this.postAtlasApi("/v1/price/latest", {
      feedIds: [feed.feedId],
      signed: true,
    });
    this.ingestAtlasPayloadData(data);

    if (!data.payload || !data.signature) {
      throw new Error(`Atlas /v1/price/latest omitted signed payload for ${underlying}`);
    }

    const verified = await verifyAtlasSignedPayload({
      payload: data.payload,
      signature: data.signature,
      magicMarker: data.magicMarker ?? ATLAS_MAGIC_MARKER,
      expectedSigner: this.authorizedSigner,
    });

    const pkg = verified.packages.find((p) => p.feedId === feed.feedId);
    if (!pkg) {
      throw new Error(
        `Atlas signed payload missing feed #${feed.feedId} (${underlying})`
      );
    }

    return {
      underlying,
      feedId: feed.feedId,
      feedIdHex: pkg.feedIdHex,
      payload: verified.payload,
      signature: verified.signature,
      magicMarker: verified.magicMarker,
      extraData: verified.extraData,
      price18: pkg.price18,
      price8: pkg.price8,
      priceUsd: pkg.priceUsd,
      timestampSeconds: pkg.timestampSeconds,
      recoveredSigner: verified.recoveredSigner,
      source: "ATLAS_PULL_LATEST",
    };
  }

  /**
   * Fetches and cryptographically pre-verifies all 30 deterministic 1-minute signed
   * Atlas historical proofs (`[expiry - 29m .. expiry]`) for `settleWithAtlasTwap`.
   *
   * Uses in-flight singleflight deduplication and a 15-minute in-memory cache so
   * concurrent API/Keeper callers never hammer the upstream Atlas API quota.
   */
  async fetchSignedTwapProofs(
    underlying: UnderlyingSymbol,
    expirySec: number,
    opts?: {
      nowSec?: number;
      sampleCount?: number;
      sampleIntervalSec?: number;
      exactMatchGraceSec?: number;
      fallbackToleranceSec?: number;
      bypassCache?: boolean;
    }
  ): Promise<AtlasSignedTwapResult | null> {
    if (!this.enableLiveAtlas && !this.httpFetcher) return null;
    if (!this.apiKey && !this.httpFetcher) return null;

    const sampleCount = opts?.sampleCount ?? SETTLEMENT_TWAP_SAMPLE_COUNT;
    const sampleIntervalSec =
      opts?.sampleIntervalSec ?? SETTLEMENT_TWAP_INTERVAL_SEC;
    const exactMatchGraceSec =
      opts?.exactMatchGraceSec ?? SETTLEMENT_EXACT_MATCH_GRACE_SEC;
    const fallbackToleranceSec =
      opts?.fallbackToleranceSec ?? SETTLEMENT_FALLBACK_TOLERANCE_SEC;
    const nowSec = opts?.nowSec ?? Math.floor(Date.now() / 1000);
    const toleranceSec =
      nowSec <= expirySec + exactMatchGraceSec ? 0 : fallbackToleranceSec;

    const cacheKey = `${underlying}:${expirySec}:${sampleCount}:${sampleIntervalSec}:${toleranceSec}`;
    if (!opts?.bypassCache) {
      const cached = this.twapCache.get(cacheKey);
      if (cached && Date.now() - cached.cachedAtMs < 15 * 60_000) {
        return cached.result;
      }
      const failed = this.twapFailureCache.get(cacheKey);
      if (failed && Date.now() - failed.failedAtMs < 60_000) {
        throw new Error(failed.message);
      }
      const pending = this.twapInFlight.get(cacheKey);
      if (pending) return pending;
    }

    const work = this._doFetchSignedTwapProofs({
      underlying,
      expirySec,
      sampleCount,
      sampleIntervalSec,
      toleranceSec,
    })
      .then((res) => {
        if (res) {
          this.twapFailureCache.delete(cacheKey);
          this.twapCache.set(cacheKey, { cachedAtMs: Date.now(), result: res });
        }
        return res;
      })
      .catch((err: unknown) => {
        const msg =
          err instanceof Error
            ? err.message
            : "Atlas 30m TWAP proof fetch failed";
        this.twapFailureCache.set(cacheKey, {
          failedAtMs: Date.now(),
          message: msg,
        });
        throw err;
      })
      .finally(() => {
        if (this.twapInFlight.get(cacheKey) === work) {
          this.twapInFlight.delete(cacheKey);
        }
      });

    if (!opts?.bypassCache) {
      this.twapInFlight.set(cacheKey, work);
    }
    return work;
  }

  private async _doFetchSignedTwapProofs(params: {
    underlying: UnderlyingSymbol;
    expirySec: number;
    sampleCount: number;
    sampleIntervalSec: number;
    toleranceSec: number;
  }): Promise<AtlasSignedTwapResult | null> {
    const {
      underlying,
      expirySec,
      sampleCount,
      sampleIntervalSec,
      toleranceSec,
    } = params;
    const feed = this.feeds[underlying];
    const targetTimestamps = buildTwapSampleTimestamps(
      expirySec,
      sampleCount,
      sampleIntervalSec
    );

    const proofs: Hex[] = new Array(sampleCount);
    const actualTimestamps: number[] = new Array(sampleCount);
    const prices18: bigint[] = new Array(sampleCount);
    let recoveredSigner: Hex = this.authorizedSigner;
    let maxAbsDiff = 0;

    const CONCURRENCY = 6;
    for (let start = 0; start < sampleCount; start += CONCURRENCY) {
      const slice = targetTimestamps.slice(start, start + CONCURRENCY);
      await Promise.all(
        slice.map(async (targetTs, offset) => {
          const idx = start + offset;
          let data: AtlasSignedPayloadData | null = null;
          let lastErr: unknown;
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              data = await this.postAtlasApi("/v1/price/history", {
                feedIds: [feed.feedId],
                timestamp: targetTs,
                signed: true,
              });
              if (data?.payload && data?.signature) break;
            } catch (err) {
              lastErr = err;
            }
            if (attempt < 2) {
              await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
            }
          }

          if (!data || !data.payload || !data.signature) {
            throw new Error(
              `Missing signed Atlas history proof for ${underlying} sample #${idx} (ts=${targetTs}): ${
                lastErr instanceof Error ? lastErr.message : "empty payload"
              }`
            );
          }

          const verified = await verifyAtlasSignedPayload({
            payload: data.payload,
            signature: data.signature,
            magicMarker: data.magicMarker ?? ATLAS_MAGIC_MARKER,
            expectedSigner: this.authorizedSigner,
          });

          const pkg = verified.packages.find((p) => p.feedId === feed.feedId);
          if (!pkg) {
            throw new Error(
              `Atlas proof #${idx} missing feed #${feed.feedId} (${underlying})`
            );
          }
          if (pkg.price18 <= 0n) {
            throw new Error(
              `Atlas proof #${idx} has non-positive price for ${underlying}`
            );
          }

          const diff = Math.abs(pkg.timestampSeconds - targetTs);
          if (diff > toleranceSec) {
            throw new Error(
              `Atlas proof #${idx} timestamp ${pkg.timestampSeconds} deviates by ${diff}s from target ${targetTs} (max tolerance ${toleranceSec}s)`
            );
          }
          if (diff > maxAbsDiff) maxAbsDiff = diff;

          proofs[idx] = verified.extraData;
          actualTimestamps[idx] = pkg.timestampSeconds;
          prices18[idx] = pkg.price18;
          recoveredSigner = verified.recoveredSigner;
        })
      );
    }

    let sumPrice18 = 0n;
    for (const p of prices18) {
      sumPrice18 += p;
    }
    const twapPrice8 = sumPrice18 / (BigInt(sampleCount) * PRICE_DECIMALS_DIFF);
    if (twapPrice8 <= 0n) return null;

    return {
      underlying,
      expiry: expirySec,
      feedId: feed.feedId,
      feedIdHex: feed.feedIdHex,
      sampleCount,
      sampleIntervalSec,
      targetTimestamps,
      actualTimestamps,
      maxAbsTimestampDiffSec: maxAbsDiff,
      proofs,
      twapPrice8,
      twapPriceUsd: Number(twapPrice8) / 1e8,
      windowStartTimestamp: actualTimestamps[0]!,
      windowEndTimestamp: actualTimestamps[sampleCount - 1]!,
      recoveredSigner,
      source: "ATLAS_TWAP_30M",
    };
  }
}

export type WalletTransferKind = "FAUCET" | "WITHDRAW";

export interface WalletTransferRecord {
  id: string;
  kind: WalletTransferKind;
  amountUsdt: number;
  toAddress?: `0x${string}`;
  txHash?: `0x${string}`;
  timestampSec: number;
  chainId: number;
}

const STORAGE_PREFIX = "payoff.walletActivity.v1:";
const MAX_RECORDS = 50;

function storageKey(address: string): string {
  return `${STORAGE_PREFIX}${address.toLowerCase()}`;
}

export function loadWalletTransfers(
  address: string | undefined
): WalletTransferRecord[] {
  if (!address || typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(storageKey(address));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is WalletTransferRecord =>
        Boolean(item) &&
        typeof item.id === "string" &&
        (item.kind === "FAUCET" || item.kind === "WITHDRAW") &&
        typeof item.amountUsdt === "number" &&
        typeof item.timestampSec === "number"
    );
  } catch {
    return [];
  }
}

export function appendWalletTransfer(
  address: string | undefined,
  entry: Omit<WalletTransferRecord, "id" | "timestampSec"> & {
    timestampSec?: number;
  }
): WalletTransferRecord[] {
  if (!address || typeof window === "undefined") return [];
  const record: WalletTransferRecord = {
    ...entry,
    id:
      entry.txHash ||
      `${entry.kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestampSec: entry.timestampSec ?? Math.floor(Date.now() / 1000),
  };
  const existing = loadWalletTransfers(address);
  const next = [record, ...existing.filter((r) => r.id !== record.id)].slice(
    0,
    MAX_RECORDS
  );
  try {
    window.localStorage.setItem(storageKey(address), JSON.stringify(next));
  } catch {
    // Ignore quota/private-mode storage errors
  }
  return next;
}

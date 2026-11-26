import {
  PrivyClient,
  isEmbeddedWalletLinkedAccount,
  type LinkedAccount,
  type User,
} from "@privy-io/node";
import type { Hex } from "viem";
import type { ServerConfig } from "../config.js";
import type { PayoffDatabase } from "../db/database.js";
import type { ChainService } from "./chainService.js";

export interface VerifiedPrivyUser {
  userId: string;
  email?: string;
  embeddedWalletAddress?: Hex;
}

export interface WelcomeAirdropResult {
  status: "MINTED" | "ALREADY_CLAIMED";
  userId: string;
  email?: string;
  walletAddress: Hex;
  amountUsdt: number;
  txHash: string;
}

export class PrivyAuthError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code: string
  ) {
    super(message);
    this.name = "PrivyAuthError";
  }
}

export type PrivyTokenVerifier = (
  accessToken: string
) => Promise<VerifiedPrivyUser>;

function extractEmail(accounts: readonly LinkedAccount[]): string | undefined {
  for (const acc of accounts) {
    if (acc.type === "email" && typeof acc.address === "string") {
      return acc.address;
    }
  }
  return undefined;
}

function extractEmbeddedEthereumAddress(
  accounts: readonly LinkedAccount[]
): Hex | undefined {
  for (const acc of accounts) {
    if (isEmbeddedWalletLinkedAccount(acc) && acc.chain_type === "ethereum") {
      if (
        typeof acc.address === "string" &&
        /^0x[0-9a-fA-F]{40}$/.test(acc.address)
      ) {
        return acc.address as Hex;
      }
    }
  }
  // Fallback for legacy embedded wallet payloads
  for (const acc of accounts) {
    if (
      acc.type === "wallet" &&
      "chain_type" in acc &&
      acc.chain_type === "ethereum" &&
      "wallet_client" in acc &&
      acc.wallet_client === "privy" &&
      typeof acc.address === "string" &&
      /^0x[0-9a-fA-F]{40}$/.test(acc.address)
    ) {
      return acc.address as Hex;
    }
  }
  return undefined;
}

export function extractVerifiedUserFromPrivyUser(user: User): VerifiedPrivyUser {
  return {
    userId: user.id,
    email: extractEmail(user.linked_accounts),
    embeddedWalletAddress: extractEmbeddedEthereumAddress(user.linked_accounts),
  };
}

export class PrivyAuthService {
  private readonly client: PrivyClient | null;
  private verifierOverride?: PrivyTokenVerifier;
  private readonly inFlightAirdrops = new Map<
    string,
    Promise<WelcomeAirdropResult>
  >();

  constructor(
    private readonly config: ServerConfig,
    private readonly db: PayoffDatabase,
    private readonly chain: ChainService
  ) {
    if (config.privyAppId && config.privyAppSecret) {
      this.client = new PrivyClient({
        appId: config.privyAppId,
        appSecret: config.privyAppSecret,
      });
    } else {
      this.client = null;
    }
  }

  isConfigured(): boolean {
    return Boolean(this.client || this.verifierOverride);
  }

  /** Test hook for injecting a deterministic access-token verifier in unit tests. */
  setTokenVerifier(verifier?: PrivyTokenVerifier): void {
    this.verifierOverride = verifier;
  }

  async verifyAccessToken(accessToken: string): Promise<VerifiedPrivyUser> {
    const trimmed = accessToken.trim();
    if (!trimmed) {
      throw new PrivyAuthError(
        401,
        "Missing Privy access token",
        "MISSING_TOKEN"
      );
    }

    if (this.verifierOverride) {
      return this.verifierOverride(trimmed);
    }

    if (!this.client) {
      throw new PrivyAuthError(
        503,
        "Privy server authentication is not configured (PRIVY_APP_ID / PRIVY_APP_SECRET missing)",
        "PRIVY_NOT_CONFIGURED"
      );
    }

    try {
      const verified = await this.client
        .utils()
        .auth()
        .verifyAccessToken(trimmed);
      const user = await this.client.users()._get(verified.user_id);
      return extractVerifiedUserFromPrivyUser(user);
    } catch (err: any) {
      if (err instanceof PrivyAuthError) throw err;
      throw new PrivyAuthError(
        401,
        err?.message || "Invalid or expired Privy access token",
        "INVALID_TOKEN"
      );
    }
  }

  async claimWelcomeAirdrop(
    accessToken: string
  ): Promise<WelcomeAirdropResult> {
    const amountUsdt = this.config.welcomeAirdropUsdt;
    if (!(amountUsdt > 0)) {
      throw new PrivyAuthError(
        503,
        "Welcome airdrop is disabled",
        "AIRDROP_DISABLED"
      );
    }

    const user = await this.verifyAccessToken(accessToken);
    if (!user.embeddedWalletAddress) {
      throw new PrivyAuthError(
        409,
        "Privy embedded wallet is still initializing; please retry shortly",
        "WALLET_NOT_READY"
      );
    }

    const existingPromise = this.inFlightAirdrops.get(user.userId);
    if (existingPromise) {
      return existingPromise;
    }

    const run = this.executeWelcomeAirdrop(
      user.userId,
      user.email,
      user.embeddedWalletAddress,
      amountUsdt
    ).finally(() => {
      this.inFlightAirdrops.delete(user.userId);
    });

    this.inFlightAirdrops.set(user.userId, run);
    return run;
  }

  private async executeWelcomeAirdrop(
    userId: string,
    email: string | undefined,
    walletAddress: Hex,
    amountUsdt: number
  ): Promise<WelcomeAirdropResult> {
    const nowSec = Math.floor(Date.now() / 1000);
    const reservation = await this.db.tryReserveWelcomeAirdrop({
      privyUserId: userId,
      walletAddress,
      amountUsdt,
      timestamp: nowSec,
    });

    if (!reservation.reserved) {
      const existing = reservation.existing;
      if (existing && existing.status === "COMPLETED") {
        return {
          status: "ALREADY_CLAIMED",
          userId,
          email,
          walletAddress: existing.walletAddress as Hex,
          amountUsdt: existing.amountUsdt,
          txHash: existing.txHash,
        };
      }
      throw new PrivyAuthError(
        409,
        "Welcome airdrop is already being processed for this account",
        "AIRDROP_IN_PROGRESS"
      );
    }

    try {
      const txHash = await this.chain.mintWelcomeUsdt(
        walletAddress,
        amountUsdt
      );
      await this.db.completeWelcomeAirdrop({
        privyUserId: userId,
        txHash,
        timestamp: Math.floor(Date.now() / 1000),
      });
      return {
        status: "MINTED",
        userId,
        email,
        walletAddress,
        amountUsdt,
        txHash,
      };
    } catch (err: any) {
      await this.db.failWelcomeAirdrop({
        privyUserId: userId,
        timestamp: Math.floor(Date.now() / 1000),
      });
      throw new PrivyAuthError(
        502,
        err?.shortMessage ||
          err?.message ||
          "Failed to mint welcome tUSDT on-chain",
        "MINT_FAILED"
      );
    }
  }
}

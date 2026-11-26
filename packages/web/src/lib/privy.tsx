import { useEffect, useState, type ReactNode } from "react";
import { PrivyProvider, type PrivyClientConfig } from "@privy-io/react-auth";
import { api } from "./api";
import { bscTestnetChain, localHardhatChain } from "./wagmi";

declare const __PAYOFF_PRIVY_APP_ID__: string | undefined;

export function resolveStaticPrivyAppId(): string {
  const fromViteEnv = (
    (import.meta as any).env?.VITE_PRIVY_APP_ID || ""
  ).trim();
  if (fromViteEnv) return fromViteEnv;
  if (
    typeof __PAYOFF_PRIVY_APP_ID__ === "string" &&
    __PAYOFF_PRIVY_APP_ID__.trim()
  ) {
    return __PAYOFF_PRIVY_APP_ID__.trim();
  }
  return "";
}

export const privyConfig: PrivyClientConfig = {
  loginMethods: ["email"],
  defaultChain: bscTestnetChain,
  supportedChains: [bscTestnetChain, localHardhatChain],
  embeddedWallets: {
    ethereum: {
      createOnLogin: "all-users",
    },
    showWalletUIs: false,
  },
  appearance: {
    theme: "#000000",
    accentColor: "#FFFFFF",
    showWalletLoginFirst: false,
  },
};

export function PrivyBootProvider({ children }: { children: ReactNode }) {
  const staticAppId = resolveStaticPrivyAppId();
  const [appId, setAppId] = useState<string>(staticAppId);
  const [bootError, setBootError] = useState<string | null>(null);

  useEffect(() => {
    if (appId) return;
    let cancelled = false;
    api
      .getHealth()
      .then((h) => {
        if (cancelled) return;
        const resolved = (h.privyAppId || "").trim();
        if (resolved) {
          setAppId(resolved);
        } else {
          setBootError(
            "Privy App ID is not configured. Set PRIVY_APP_ID in .env (or VITE_PRIVY_APP_ID)."
          );
        }
      })
      .catch(() => {
        if (!cancelled) {
          setBootError(
            "Unable to load Privy configuration from server. Please check API connectivity or set VITE_PRIVY_APP_ID."
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [appId]);

  if (bootError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-black p-6 text-white">
        <div className="max-w-md rounded-2xl border border-[#1d2025] bg-[#121417] p-6 text-center space-y-3">
          <h1 className="text-base font-bold text-white">
            Privy Configuration Required
          </h1>
          <p className="text-xs text-[#7e8690] leading-relaxed">{bootError}</p>
        </div>
      </div>
    );
  }

  if (!appId) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-black text-[#7e8690] text-xs font-medium">
        Loading Payoff...
      </div>
    );
  }

  return (
    <PrivyProvider appId={appId} config={privyConfig}>
      {children}
    </PrivyProvider>
  );
}

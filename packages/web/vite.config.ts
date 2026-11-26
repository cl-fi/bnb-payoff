import path from "path";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig(({ mode }) => {
  const rootDir = path.resolve(__dirname, "../..");
  // Read ONLY public Privy App ID from workspace root or web env (NEVER expose PRIVY_APP_SECRET!)
  const rootEnv = loadEnv(mode, rootDir, "");
  const webEnv = loadEnv(mode, __dirname, "");
  const privyAppId = (
    process.env.VITE_PRIVY_APP_ID ||
    webEnv.VITE_PRIVY_APP_ID ||
    rootEnv.VITE_PRIVY_APP_ID ||
    process.env.PRIVY_APP_ID ||
    rootEnv.PRIVY_APP_ID ||
    ""
  ).trim();

  const apiTarget =
    process.env.VITE_API_PROXY_TARGET || "http://127.0.0.1:4000";
  const wsTarget = apiTarget
    .replace(/^https:/i, "wss:")
    .replace(/^http:/i, "ws:");

  return {
    plugins: [
      react(),
      tailwindcss(),
      nodePolyfills({
        globals: {
          Buffer: true,
          global: true,
          process: true,
        },
      }),
    ],
    define: {
      __PAYOFF_PRIVY_APP_ID__: JSON.stringify(privyAppId),
    },
    server: {
      port: 5173,
      proxy: {
        "/api": {
          target: apiTarget,
          changeOrigin: true,
        },
        "/ws": {
          target: wsTarget,
          ws: true,
        },
      },
    },
  };
});

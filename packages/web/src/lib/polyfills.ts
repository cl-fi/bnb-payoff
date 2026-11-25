import { Buffer } from "buffer";

// Browser polyfill required by @binance/w3w-ethereum-provider QR relay encryption
if (typeof globalThis.Buffer === "undefined") {
  (globalThis as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;
}

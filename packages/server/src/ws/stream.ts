import type { FastifyInstance } from "fastify";
import type { AppServices } from "../routes/api.js";

interface WsLike {
  readyState: number;
  send(data: string): void;
  on(event: "message", cb: (raw: Buffer) => void): void;
  on(event: "close", cb: () => void): void;
}

interface ClientSub {
  ws: WsLike;
  address?: string;
}

export function registerWsStream(app: FastifyInstance, svc: AppServices) {
  const clients = new Set<ClientSub>();

  app.get("/ws/stream", { websocket: true }, (socket, req) => {
    const query = (req.query || {}) as { address?: string };
    const sub: ClientSub = {
      ws: socket as unknown as WsLike,
      address: query.address?.toLowerCase(),
    };
    clients.add(sub);

    socket.on("message", (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (typeof msg.address === "string") {
          sub.address = msg.address.toLowerCase();
        }
      } catch {
        // ignore malformed client messages
      }
    });

    socket.on("close", () => {
      clients.delete(sub);
    });

    void pushToClient(sub);
  });

  async function pushToClient(sub: ClientSub) {
    if (sub.ws.readyState !== 1) return;
    const btc = svc.marketData.getSnapshot("BTC");
    const eth = svc.marketData.getSnapshot("ETH");
    const positions = sub.address
      ? await svc.positions.getPositionsForAddress(sub.address)
      : undefined;
    sub.ws.send(
      JSON.stringify({
        type: "TICK",
        ts: Date.now(),
        dataSource: btc.dataSource,
        spots: {
          BTC: { spot: btc.spot, change24hPct: btc.change24hPct },
          ETH: { spot: eth.spot, change24hPct: eth.change24hPct },
        },
        atlasTelemetry: svc.atlasOracle.getAllTelemetry(),
        settlementCircuitBreaker: svc.chain.getSettlementCircuitBreaker(),
        positions,
      })
    );
  }

  const timer = setInterval(() => {
    for (const sub of clients) {
      void pushToClient(sub);
    }
  }, 1500);
  timer.unref?.();

  app.addHook("onClose", async () => {
    clearInterval(timer);
  });
}

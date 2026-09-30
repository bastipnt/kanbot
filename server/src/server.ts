import { createApp } from "./app.ts";
import { upgradeWebSocket, websocketHandler, type WsData } from "./realtime/ws.ts";

/** Start the HTTP + WebSocket server. `port: 0` picks a free port (used by tests). */
export function startServer(port: number) {
  const app = createApp();
  return Bun.serve({
    port,
    idleTimeout: 60,
    fetch(req, server) {
      if (new URL(req.url).pathname === "/ws") return upgradeWebSocket(req, server);
      return app.fetch(req, { server });
    },
    websocket: { ...websocketHandler, data: {} as WsData, idleTimeout: 120 },
  });
}

/**
 * WebSocket realtime endpoint: `GET /ws?token=<accessToken>&workspaceId=<id>`.
 * On connect the server sends `{"kind":"hello","latestSeq":N}`, then `{"kind":"event","event":Event}`
 * for every event committed after that. `{"kind":"ping"}` is answered with `{"kind":"pong"}`.
 */
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import { ApiError, errorBody, unauthorized } from "../lib/errors.ts";
import { bearerToken } from "../lib/http.ts";
import type { Event } from "../lib/serialize.ts";
import { authorize } from "../services/access.ts";
import { authenticate } from "../services/auth.ts";
import { latestSeq } from "../services/events.ts";
import { hub } from "./hub.ts";

export interface WsData {
  workspaceId: string;
  userId?: string;
  unsubscribe?: () => void;
  /** Events received before `hello` was sent; flushed right after it. */
  pending: Event[] | null;
}

const send = (ws: ServerWebSocket<WsData>, msg: unknown) => ws.send(JSON.stringify(msg));

/** Authenticate and upgrade. Returns a Response on failure, or undefined when upgraded. */
export async function upgradeWebSocket(req: Request, server: Server<WsData>): Promise<Response | undefined> {
  const url = new URL(req.url);
  try {
    const token = url.searchParams.get("token") ?? bearerToken(req.headers.get("Authorization"));
    if (!token) throw unauthorized();
    const principal = await authenticate(token);
    if (!principal) throw unauthorized("Invalid or expired credentials");
    const workspaceId = url.searchParams.get("workspaceId") ?? "";
    await authorize(principal, workspaceId);
    const data: WsData = {
      workspaceId,
      userId: principal.kind === "user" ? principal.user.id : undefined,
      pending: [],
    };
    if (server.upgrade(req, { data })) return undefined;
    return Response.json(errorBody("bad_request", "Expected a WebSocket upgrade request"), { status: 400 });
  } catch (err) {
    if (err instanceof ApiError) return Response.json(errorBody(err.code, err.message), { status: err.status });
    throw err;
  }
}

export const websocketHandler: WebSocketHandler<WsData> = {
  async open(ws) {
    // Subscribe before reading latestSeq so nothing committed in between is lost; events that
    // arrive before `hello` are buffered and only those newer than latestSeq are forwarded.
    ws.data.unsubscribe = hub.subscribe(ws.data.workspaceId, {
      userId: ws.data.userId,
      onEvent(event) {
        if (ws.data.pending) ws.data.pending.push(event);
        else send(ws, { kind: "event", event });
      },
      onKick() {
        ws.close(4403, "removed from workspace");
      },
    });
    try {
      const seq = await latestSeq(ws.data.workspaceId);
      send(ws, { kind: "hello", latestSeq: seq });
      const pending = ws.data.pending ?? [];
      ws.data.pending = null;
      for (const event of pending) if (event.seq > seq) send(ws, { kind: "event", event });
    } catch {
      ws.close(1011, "failed to initialise");
    }
  },
  message(ws, message) {
    let msg: unknown;
    try {
      msg = JSON.parse(typeof message === "string" ? message : message.toString());
    } catch {
      return;
    }
    if (msg && typeof msg === "object" && (msg as { kind?: unknown }).kind === "ping") send(ws, { kind: "pong" });
  },
  close(ws) {
    ws.data.unsubscribe?.();
  },
};

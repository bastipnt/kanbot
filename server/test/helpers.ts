import { startServer } from "../src/server.ts";

let server: ReturnType<typeof startServer> | undefined;

/** Shared in-process server on a random port. */
export function baseUrl(): string {
  server ??= startServer(0);
  return server.url.origin;
}

export interface Res<T = any> {
  status: number;
  body: T;
}

export async function api<T = any>(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<Res<T>> {
  const res = await fetch(baseUrl() + path, {
    method,
    headers: {
      ...(opts.token && { Authorization: `Bearer ${opts.token}` }),
      ...(opts.body !== undefined && { "Content-Type": "application/json" }),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

let counter = 0;
export const uniqueEmail = (prefix = "user") => `${prefix}-${Date.now()}-${++counter}@example.com`;

export interface TestUser {
  id: string;
  email: string;
  name: string;
  token: string;
  refreshToken: string;
}

export async function registerUser(name = "Test User"): Promise<TestUser> {
  const email = uniqueEmail(name.toLowerCase().replace(/\W+/g, "-"));
  const res = await api("POST", "/auth/register", { body: { email, password: "correct horse battery", name } });
  if (res.status !== 200) throw new Error(`register failed: ${JSON.stringify(res.body)}`);
  return { ...res.body.user, token: res.body.accessToken, refreshToken: res.body.refreshToken };
}

export async function createWorkspace(user: TestUser, name = "WS"): Promise<{ id: string }> {
  const res = await api("POST", "/workspaces", { token: user.token, body: { name } });
  if (res.status !== 200) throw new Error(`workspace failed: ${JSON.stringify(res.body)}`);
  return res.body;
}

export async function createBoard(user: TestUser, workspaceId: string, name = "Board") {
  const res = await api("POST", `/workspaces/${workspaceId}/boards`, { token: user.token, body: { name } });
  if (res.status !== 200) throw new Error(`board failed: ${JSON.stringify(res.body)}`);
  const snap = await api("GET", `/boards/${res.body.id}`, { token: user.token });
  return snap.body as { board: any; columns: any[]; tasks: any[] };
}

/** User + workspace + board, the common starting point. */
export async function setup(name = "Owner") {
  const user = await registerUser(name);
  const ws = await createWorkspace(user);
  const snap = await createBoard(user, ws.id);
  const col = (n: string) => snap.columns.find((c) => c.name === n)!;
  return { user, ws, board: snap.board, columns: snap.columns, col };
}

export async function createTask(user: TestUser, boardId: string, columnId: string, title: string) {
  const res = await api("POST", `/boards/${boardId}/tasks`, { token: user.token, body: { title, columnId } });
  if (res.status !== 200) throw new Error(`task failed: ${JSON.stringify(res.body)}`);
  return res.body;
}

/** Open a WebSocket and collect messages. */
export function connectWs(token: string, workspaceId: string) {
  const url = baseUrl().replace(/^http/, "ws") + `/ws?token=${encodeURIComponent(token)}&workspaceId=${workspaceId}`;
  const ws = new WebSocket(url);
  const messages: any[] = [];
  const waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  ws.onmessage = (e) => {
    const msg = JSON.parse(String(e.data));
    messages.push(msg);
    for (const w of [...waiters]) {
      if (w.pred(msg)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(msg);
      }
    }
  };
  const next = (pred: (m: any) => boolean, timeoutMs = 5000) =>
    new Promise<any>((resolve, reject) => {
      const found = messages.find(pred);
      if (found) return resolve(found);
      const timer = setTimeout(() => reject(new Error("timed out waiting for ws message")), timeoutMs);
      waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  const opened = new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("ws error"));
  });
  return { ws, messages, next, opened };
}

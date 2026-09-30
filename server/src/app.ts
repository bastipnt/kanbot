import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { ApiError, errorBody } from "./lib/errors.ts";
import { requireAuth, type AppEnv } from "./lib/http.ts";
import { handleMcpRequest } from "./mcp.ts";
import { authRoutes } from "./routes/auth.ts";
import { boardRoutes } from "./routes/boards.ts";
import { workspaceRoutes } from "./routes/workspaces.ts";

/** Paths reachable without a bearer token (or with their own auth, like /mcp). */
const PUBLIC_PATHS = new Set(["/health", "/auth/register", "/auth/login", "/auth/refresh", "/mcp"]);

export function createApp() {
  const app = new Hono<AppEnv>();

  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json(errorBody(err.code, err.message), err.status);
    if (err instanceof HTTPException && err.status < 500) {
      const code = err.status === 401 ? "unauthorized" : err.status === 404 ? "not_found" : "bad_request";
      return c.json(errorBody(code, err.message || "Bad request"), err.status);
    }
    console.error(err);
    return c.json(errorBody("internal", "Internal server error"), 500);
  });
  app.notFound((c) => c.json(errorBody("not_found", `No route for ${c.req.method} ${c.req.path}`), 404));

  app.get("/health", (c) => c.json({ ok: true }));
  app.all("/mcp", (c) => handleMcpRequest(c.req.raw));

  app.use("*", async (c, next) => (PUBLIC_PATHS.has(c.req.path) ? next() : requireAuth(c, next)));

  app.route("/", authRoutes);
  app.route("/", workspaceRoutes);
  app.route("/", boardRoutes);
  return app;
}

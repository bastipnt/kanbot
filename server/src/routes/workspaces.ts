import { Hono } from "hono";
import { z } from "zod";
import { principal, validate, type AppEnv } from "../lib/http.ts";
import * as s from "../lib/schemas.ts";
import * as apiKeys from "../services/apiKeys.ts";
import * as events from "../services/events.ts";
import * as tasks from "../services/tasks.ts";
import * as ws from "../services/workspaces.ts";

export const workspaceRoutes = new Hono<AppEnv>()
  .get("/workspaces", async (c) => c.json(await ws.listWorkspaces(principal(c))))
  .post("/workspaces", validate("json", z.object({ name: s.name })), async (c) =>
    c.json(await ws.createWorkspace(principal(c), c.req.valid("json").name)),
  )
  .get("/workspaces/:id/members", async (c) => c.json(await ws.listMembers(principal(c), c.req.param("id"))))
  .post(
    "/workspaces/:id/invites",
    validate("json", z.object({ role: z.enum(["admin", "member"]).default("member") })),
    async (c) => c.json(await ws.createInvite(principal(c), c.req.param("id"), c.req.valid("json").role)),
  )
  .post("/invites/:token/accept", async (c) => c.json(await ws.acceptInvite(principal(c), c.req.param("token"))))
  .delete("/workspaces/:id/members/:userId", async (c) => {
    await ws.removeMember(principal(c), c.req.param("id"), c.req.param("userId"));
    return c.body(null, 204);
  })
  .get(
    "/workspaces/:id/tasks/search",
    validate(
      "query",
      z.object({
        q: z.string().max(500).default(""),
        boardId: s.uuid.optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      }),
    ),
    async (c) => {
      const { q, boardId, limit } = c.req.valid("query");
      return c.json(await tasks.searchTasks(principal(c), c.req.param("id"), q, { boardId, limit }));
    },
  )
  .get(
    "/workspaces/:id/events",
    validate(
      "query",
      z.object({
        since: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(1000).default(500),
      }),
    ),
    async (c) => {
      const { since, limit } = c.req.valid("query");
      return c.json(await events.listEvents(principal(c), c.req.param("id"), since, limit));
    },
  )
  .get("/workspaces/:id/api-keys", async (c) => c.json(await apiKeys.listApiKeys(principal(c), c.req.param("id"))))
  .post("/workspaces/:id/api-keys", validate("json", z.object({ name: s.name })), async (c) =>
    c.json(await apiKeys.createApiKey(principal(c), c.req.param("id"), c.req.valid("json").name)),
  )
  .delete("/api-keys/:id", async (c) => {
    await apiKeys.deleteApiKey(principal(c), c.req.param("id"));
    return c.body(null, 204);
  });

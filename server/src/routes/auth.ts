import { Hono } from "hono";
import { z } from "zod";
import { forbidden } from "../lib/errors.ts";
import { principal, validate, type AppEnv } from "../lib/http.ts";
import * as s from "../lib/schemas.ts";
import { toUser } from "../lib/serialize.ts";
import * as auth from "../services/auth.ts";

export const authRoutes = new Hono<AppEnv>()
  .post(
    "/auth/register",
    validate(
      "json",
      z.object({ email: s.email, password: s.password, name: s.name, inviteToken: z.string().min(1).max(256).optional() }),
    ),
    async (c) => c.json(await auth.register(c.req.valid("json"))),
  )
  .post(
    "/auth/login",
    validate("json", z.object({ email: z.string().min(1), password: z.string().min(1) })),
    async (c) => c.json(await auth.login(c.req.valid("json"))),
  )
  .post(
    "/auth/refresh",
    validate("json", z.object({ refreshToken: z.string().min(1) })),
    async (c) => c.json(await auth.refresh(c.req.valid("json").refreshToken)),
  )
  .get("/me", (c) => {
    const p = principal(c);
    if (p.kind !== "user") throw forbidden("/me is only available to user accounts");
    return c.json(toUser(p.user));
  });

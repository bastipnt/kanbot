import { zValidator } from "@hono/zod-validator";
import type { Context, MiddlewareHandler, ValidationTargets } from "hono";
import { createMiddleware } from "hono/factory";
import type { z } from "zod";
import { authenticate } from "../services/auth.ts";
import { badRequest, unauthorized } from "./errors.ts";
import type { Principal } from "./principal.ts";

export type AppEnv = { Variables: { principal: Principal } };

export function bearerToken(header: string | undefined | null): string | null {
  const m = header?.match(/^Bearer\s+(.+)$/i);
  return m ? m[1]!.trim() : null;
}

/** Requires `Authorization: Bearer <accessToken | kb_apiKey>` and stores the principal on the context. */
export const requireAuth: MiddlewareHandler<AppEnv> = createMiddleware<AppEnv>(async (c, next) => {
  const token = bearerToken(c.req.header("Authorization"));
  if (!token) throw unauthorized();
  const principal = await authenticate(token);
  if (!principal) throw unauthorized("Invalid or expired credentials");
  c.set("principal", principal);
  await next();
});

export const principal = (c: Context<AppEnv>) => c.get("principal");

function formatIssues(error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }): string {
  return error.issues
    .map((i) => (i.path.length ? `${i.path.map(String).join(".")}: ${i.message}` : i.message))
    .join("; ");
}

/** zod validation that fails with the contract's `bad_request` error shape. */
export const validate = <Target extends keyof ValidationTargets, Schema extends z.ZodType>(
  target: Target,
  schema: Schema,
) =>
  zValidator(target, schema, (result) => {
    if (!result.success) throw badRequest(formatIssues(result.error));
  });

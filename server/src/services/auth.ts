import { and, eq, gt, lt, sql } from "drizzle-orm";
import { sign, verify } from "hono/jwt";
import { db } from "../db/index.ts";
import { apiKeys, refreshTokens, users, type UserRow } from "../db/schema.ts";
import { env } from "../env.ts";
import { randomToken, sha256 } from "../lib/crypto.ts";
import { conflict, unauthorized } from "../lib/errors.ts";
import type { Principal } from "../lib/principal.ts";
import { toUser, type User } from "../lib/serialize.ts";

export const ACCESS_TOKEN_TTL_S = 15 * 60;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const API_KEY_TOUCH_INTERVAL_MS = 60_000;

export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

async function issueAccessToken(userId: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return sign({ sub: userId, typ: "access", iat: now, exp: now + ACCESS_TOKEN_TTL_S }, env.jwtSecret, "HS256");
}

async function issueRefreshToken(userId: string, ex: Pick<typeof db, "insert"> = db): Promise<string> {
  const token = randomToken(32);
  await ex.insert(refreshTokens).values({
    userId,
    tokenHash: sha256(token),
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
  });
  return token;
}

async function issueTokens(userId: string): Promise<Tokens> {
  return { accessToken: await issueAccessToken(userId), refreshToken: await issueRefreshToken(userId) };
}

const normalizeEmail = (email: string) => email.trim().toLowerCase();

export async function register(input: { email: string; password: string; name: string }): Promise<{ user: User } & Tokens> {
  const email = normalizeEmail(input.email);
  const passwordHash = await Bun.password.hash(input.password, { algorithm: "argon2id" });
  const [user] = await db
    .insert(users)
    .values({ email, name: input.name.trim(), passwordHash })
    .onConflictDoNothing()
    .returning();
  if (!user) throw conflict("An account with this email already exists");
  return { user: toUser(user), ...(await issueTokens(user.id)) };
}

export async function login(input: { email: string; password: string }): Promise<{ user: User } & Tokens> {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(sql`lower(${users.email})`, normalizeEmail(input.email)));
  // Always run a verify to keep timing roughly constant for unknown emails.
  const ok = user
    ? await Bun.password.verify(input.password, user.passwordHash)
    : (await Bun.password.hash(input.password, { algorithm: "argon2id" }), false);
  if (!user || !ok) throw unauthorized("Invalid email or password");
  return { user: toUser(user), ...(await issueTokens(user.id)) };
}

/** Exchange a refresh token for a new pair. The old refresh token is consumed atomically (single use). */
export async function refresh(refreshToken: string): Promise<Tokens> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .delete(refreshTokens)
      .where(and(eq(refreshTokens.tokenHash, sha256(refreshToken)), gt(refreshTokens.expiresAt, new Date())))
      .returning();
    if (!row) throw unauthorized("Invalid or expired refresh token");
    // Opportunistic cleanup of this user's expired tokens.
    await tx.delete(refreshTokens).where(and(eq(refreshTokens.userId, row.userId), lt(refreshTokens.expiresAt, new Date())));
    return { accessToken: await issueAccessToken(row.userId), refreshToken: await issueRefreshToken(row.userId, tx) };
  });
}

export async function getUser(userId: string): Promise<UserRow | undefined> {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  return user;
}

/**
 * Resolve a bearer credential to a principal: `kb_...` API keys act as agents, anything else must be
 * a valid access JWT. Returns null when the credential is invalid.
 */
export async function authenticate(token: string): Promise<Principal | null> {
  if (token.startsWith("kb_")) {
    const [key] = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, sha256(token)));
    if (!key) return null;
    const now = new Date();
    if (!key.lastUsedAt || now.getTime() - key.lastUsedAt.getTime() > API_KEY_TOUCH_INTERVAL_MS) {
      key.lastUsedAt = now;
      db.update(apiKeys)
        .set({ lastUsedAt: now })
        .where(eq(apiKeys.id, key.id))
        .catch((err) => console.error("failed to update api key lastUsedAt", err));
    }
    return { kind: "agent", apiKey: key };
  }
  try {
    const payload = await verify(token, env.jwtSecret, "HS256");
    if (payload.typ !== "access" || typeof payload.sub !== "string") return null;
    const user = await getUser(payload.sub);
    return user ? { kind: "user", user } : null;
  } catch {
    return null;
  }
}

import { and, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { sign, verify } from "hono/jwt";
import { db } from "../db/index.ts";
import { apiKeys, refreshTokens, signupInvites, users, type UserRow } from "../db/schema.ts";
import { env } from "../env.ts";
import { randomToken, sha256 } from "../lib/crypto.ts";
import { conflict, forbidden, unauthorized } from "../lib/errors.ts";
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

export const SIGNUP_INVITE_TTL_DAYS = 7;

/** Create a single-use signup invite (CLI only). With `email`, only that address may register with it. */
export async function createSignupInvite(
  input: { email?: string; days?: number } = {},
): Promise<{ token: string; email: string | null; expiresAt: Date }> {
  const token = randomToken(32);
  const email = input.email ? normalizeEmail(input.email) : null;
  const expiresAt = new Date(Date.now() + (input.days ?? SIGNUP_INVITE_TTL_DAYS) * 24 * 60 * 60 * 1000);
  await db.insert(signupInvites).values({ tokenHash: sha256(token), email, expiresAt });
  return { token, email, expiresAt };
}

/**
 * Create an account. While registration is disabled a valid, unused signup invite is required; it is consumed
 * in the same transaction as the user insert, so a failed registration (e.g. duplicate email) keeps it usable.
 */
export async function register(input: {
  email: string;
  password: string;
  name: string;
  inviteToken?: string;
}): Promise<{ user: User } & Tokens> {
  const email = normalizeEmail(input.email);
  if (env.registrationDisabled && !input.inviteToken) {
    throw forbidden("Registration is disabled; an invite is required");
  }
  const passwordHash = await Bun.password.hash(input.password, { algorithm: "argon2id" });
  const user = await db.transaction(async (tx) => {
    let inviteId: string | undefined;
    if (env.registrationDisabled && input.inviteToken) {
      const [invite] = await tx
        .update(signupInvites)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(signupInvites.tokenHash, sha256(input.inviteToken)),
            isNull(signupInvites.usedAt),
            gt(signupInvites.expiresAt, new Date()),
            or(isNull(signupInvites.email), eq(signupInvites.email, email)),
          ),
        )
        .returning({ id: signupInvites.id });
      if (!invite) throw forbidden("Invalid or expired invite");
      inviteId = invite.id;
    }
    const [row] = await tx
      .insert(users)
      .values({ email, name: input.name.trim(), passwordHash })
      .onConflictDoNothing()
      .returning();
    if (!row) throw conflict("An account with this email already exists");
    if (inviteId) await tx.update(signupInvites).set({ usedBy: row.id }).where(eq(signupInvites.id, inviteId));
    return row;
  });
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

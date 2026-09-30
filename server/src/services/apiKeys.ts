import { asc, eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { apiKeys } from "../db/schema.ts";
import { isUuid, randomToken, sha256 } from "../lib/crypto.ts";
import { forbidden, notFound } from "../lib/errors.ts";
import type { Principal } from "../lib/principal.ts";
import { toApiKey, type ApiKey } from "../lib/serialize.ts";
import { hub } from "../realtime/hub.ts";
import { authorize } from "./access.ts";

export const API_KEY_PREFIX_LENGTH = 8;

export async function listApiKeys(p: Principal, workspaceId: string): Promise<ApiKey[]> {
  await authorize(p, workspaceId, "admin");
  const rows = await db.select().from(apiKeys).where(eq(apiKeys.workspaceId, workspaceId)).orderBy(asc(apiKeys.createdAt));
  return rows.map(toApiKey);
}

/** Creates an agent API key. The secret (`kb_` + 43 random base64url chars) is returned once; only its sha256 is stored. */
export async function createApiKey(
  p: Principal,
  workspaceId: string,
  name: string,
): Promise<{ apiKey: ApiKey; secret: string }> {
  await authorize(p, workspaceId, "admin");
  if (p.kind !== "user") throw forbidden();
  const secret = `kb_${randomToken(32)}`;
  const [row] = await db
    .insert(apiKeys)
    .values({
      workspaceId,
      name: name.trim(),
      prefix: secret.slice(0, API_KEY_PREFIX_LENGTH),
      keyHash: sha256(secret),
      createdBy: p.user.id,
    })
    .returning();
  return { apiKey: toApiKey(row!), secret };
}

export async function deleteApiKey(p: Principal, apiKeyId: string): Promise<void> {
  if (!isUuid(apiKeyId)) throw notFound("API key");
  const [key] = await db.select().from(apiKeys).where(eq(apiKeys.id, apiKeyId));
  if (!key) throw notFound("API key");
  await authorize(p, key.workspaceId, "admin");
  await db.delete(apiKeys).where(eq(apiKeys.id, apiKeyId));
  hub.kickApiKey(key.workspaceId, apiKeyId);
}

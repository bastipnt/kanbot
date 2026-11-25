import { sqlClient } from "./db/index.ts";

export const HEALTH_CHECK_TIMEOUT_MS = 2_000;

/** `select 1` with a timeout: a hung database must not hang the health endpoint. */
export async function checkDatabase(timeoutMs = HEALTH_CHECK_TIMEOUT_MS): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    await Promise.race([sqlClient.unsafe("select 1"), timeout]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

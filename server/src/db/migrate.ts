import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { env } from "../env.ts";

export async function runMigrations(url = env.databaseUrl): Promise<void> {
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(client), { migrationsFolder: join(import.meta.dir, "../../drizzle") });
  } finally {
    await client.end();
  }
}

if (import.meta.main) {
  await runMigrations();
  console.log("migrations applied");
}

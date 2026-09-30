/**
 * Preloaded by `bun test` (see bunfig.toml): migrates the database from DATABASE_URL and wipes it.
 * Tests run against a real Postgres, e.g. `docker compose up -d db`.
 */
import { sqlClient } from "../src/db/index.ts";
import { runMigrations } from "../src/db/migrate.ts";

await runMigrations();
await sqlClient.unsafe(
  "TRUNCATE users, refresh_tokens, workspaces, workspace_members, invites, boards, columns, tasks, comments, api_keys, events CASCADE",
);

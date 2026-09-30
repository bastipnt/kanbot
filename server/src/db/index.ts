import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../env.ts";
import * as schema from "./schema.ts";

export const sqlClient = postgres(env.databaseUrl, { max: 10, onnotice: () => {} });
export const db = drizzle(sqlClient, { schema });

export type DB = typeof db;
export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];
/** Either the root db handle or an open transaction. */
export type Executor = DB | Tx;

import { env } from "./env.ts";
import { startServer } from "./server.ts";

const server = startServer(env.port);
console.log(`kanbot server listening on ${server.url}`);

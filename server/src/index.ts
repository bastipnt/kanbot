import { env } from "./env.ts";
import { startMetricsServer } from "./metricsServer.ts";
import { startServer } from "./server.ts";

const server = startServer(env.port);
const metrics = startMetricsServer(env.metricsPort);
console.log(`kanbot server listening on ${server.url}`);
console.log(`kanbot metrics listening on ${metrics.url}`);

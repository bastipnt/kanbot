import { metricsRegistry } from "./metrics.ts";

/**
 * Prometheus endpoint on its own listener: the public proxy only forwards PORT,
 * so `/metrics` is reachable from the metrics network alone (docs/ops/monitoring.md).
 */
export function startMetricsServer(port: number) {
  return Bun.serve({
    port,
    async fetch(req) {
      if (new URL(req.url).pathname !== "/metrics") return new Response("Not found", { status: 404 });
      return new Response(await metricsRegistry.metrics(), {
        headers: { "content-type": metricsRegistry.contentType, "cache-control": "no-store" },
      });
    },
  });
}

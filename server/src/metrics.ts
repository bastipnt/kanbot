/**
 * Prometheus registry for the host's monitoring stack (docs/ops/monitoring.md).
 * Labels are matched routes and fixed strings from the code — never a user id,
 * email, board or task id.
 */
import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from "@prometheus-io/client";
import { sqlClient } from "./db/index.ts";
import { env } from "./env.ts";
import { checkDatabase } from "./health.ts";

export const metricsRegistry = new Registry();

collectDefaultMetrics({ register: metricsRegistry, prefix: "kanbot_" });

new Gauge({
  name: "kanbot_build_info",
  help: "Always 1; the version label is the deployed image tag",
  labelNames: ["version"] as const,
  registers: [metricsRegistry],
}).set({ version: env.version }, 1);

const httpRequests = new Counter({
  name: "kanbot_http_requests_total",
  help: "HTTP requests by method, matched route and status",
  labelNames: ["method", "route", "status"] as const,
  registers: [metricsRegistry],
});

const httpDuration = new Histogram({
  name: "kanbot_http_request_duration_seconds",
  help: "HTTP request duration by method and matched route",
  labelNames: ["method", "route"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});

export function recordHttpRequest(method: string, route: string, status: number, durationMs: number) {
  const matched = route || "unmatched";
  httpRequests.inc({ method, route: matched, status: String(status) });
  httpDuration.observe({ method, route: matched }, durationMs / 1000);
}

export type AuthFailureReason =
  | "invalid_credentials"
  | "invalid_refresh_token"
  | "registration_disabled"
  | "invite_invalid"
  | "email_taken";

const authFailures = new Counter({
  name: "kanbot_auth_failures_total",
  help: "Rejected login, refresh and registration attempts by reason",
  labelNames: ["reason"] as const,
  registers: [metricsRegistry],
});

export function recordAuthFailure(reason: AuthFailureReason) {
  authFailures.inc({ reason });
}

const wsConnections = new Gauge({
  name: "kanbot_ws_connections",
  help: "Open realtime WebSocket subscriptions",
  registers: [metricsRegistry],
});

export const wsConnectionOpened = () => wsConnections.inc();
export const wsConnectionClosed = () => wsConnections.dec();

const eventsPublished = new Counter({
  name: "kanbot_events_published_total",
  help: "Committed domain events fanned out to realtime subscribers, by type and actor kind",
  labelNames: ["type", "actor"] as const,
  registers: [metricsRegistry],
});

export function recordEventPublished(type: string, actor: "user" | "agent") {
  eventsPublished.inc({ type, actor });
}

const mcpCalls = new Counter({
  name: "kanbot_mcp_calls_total",
  help: "MCP tool calls by tool and result",
  labelNames: ["tool", "result"] as const,
  registers: [metricsRegistry],
});

const mcpDuration = new Histogram({
  name: "kanbot_mcp_call_duration_seconds",
  help: "MCP tool call duration by tool",
  labelNames: ["tool"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});

export function recordMcpCall(tool: string, result: "ok" | "error" | "internal", durationMs: number) {
  mcpCalls.inc({ tool, result });
  mcpDuration.observe({ tool }, durationMs / 1000);
}

new Gauge({
  name: "kanbot_dependency_up",
  help: "1 when the dependency answered its health check at scrape time",
  labelNames: ["dependency"] as const,
  registers: [metricsRegistry],
  async collect() {
    this.set({ dependency: "db" }, (await checkDatabase()) ? 1 : 0);
  },
});

new Gauge({
  name: "kanbot_db_connections",
  help: "Connections to this database by pg_stat_activity state",
  labelNames: ["state"] as const,
  registers: [metricsRegistry],
  async collect() {
    try {
      const rows = await sqlClient<{ state: string; count: number }[]>`
        select coalesce(state, 'unknown') as state, count(*)::int as count
        from pg_stat_activity where datname = current_database() group by 1
      `;
      this.reset();
      for (const row of rows) this.set({ state: row.state }, row.count);
    } catch {
      // A scrape during a database outage keeps the last values; kanbot_dependency_up reports the outage.
    }
  },
});

new Gauge({
  name: "kanbot_db_size_bytes",
  help: "Size of the kanbot database on disk",
  registers: [metricsRegistry],
  async collect() {
    try {
      const [row] = await sqlClient<{ size: string }[]>`select pg_database_size(current_database())::text as size`;
      if (row) this.set(Number(row.size));
    } catch {}
  },
});

new Gauge({
  name: "kanbot_entities",
  help: "Rows per core table",
  labelNames: ["entity"] as const,
  registers: [metricsRegistry],
  async collect() {
    try {
      const [row] = await sqlClient<Record<string, number>[]>`
        select
          (select count(*) from users)::int as users,
          (select count(*) from workspaces)::int as workspaces,
          (select count(*) from boards)::int as boards,
          (select count(*) from columns)::int as columns,
          (select count(*) from tasks)::int as tasks,
          (select count(*) from comments)::int as comments,
          (select count(*) from api_keys)::int as api_keys,
          (select count(*) from events)::int as events
      `;
      if (!row) return;
      for (const [entity, count] of Object.entries(row)) this.set({ entity }, count);
    } catch {}
  },
});

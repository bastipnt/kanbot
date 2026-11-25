import { expect, test } from "bun:test";
import { startMetricsServer } from "../src/metricsServer.ts";
import { api } from "./helpers.ts";

test("GET /health reports the database", async () => {
  const res = await api("GET", "/health");
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ ok: true, checks: { db: "ok" } });
});

test("GET /metrics exposes request, auth, dependency and entity series", async () => {
  await api("POST", "/auth/login", { body: { email: "nobody@example.com", password: "not the password" } });

  const server = startMetricsServer(0);
  try {
    const res = await fetch(`${server.url}metrics`);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const text = await res.text();
    expect(text).toContain('kanbot_http_requests_total{method="GET",route="/health",status="200"}');
    expect(text).toContain('kanbot_http_requests_total{method="POST",route="/auth/login",status="401"}');
    expect(text).toContain('kanbot_auth_failures_total{reason="invalid_credentials"}');
    expect(text).toContain('kanbot_dependency_up{dependency="db"} 1');
    expect(text).toContain('kanbot_db_connections{state="');
    expect(text).toContain('kanbot_entities{entity="users"}');
    expect(text).toContain("kanbot_ws_connections");
    expect(text).toContain('kanbot_build_info{version="dev"} 1');

    expect((await fetch(`${server.url}health`)).status).toBe(404);
  } finally {
    server.stop(true);
  }
});

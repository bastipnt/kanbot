# Monitoring

kanbot plugs into the host's monitoring stack (Prometheus, Loki + Alloy, Grafana, Gatus, cAdvisor, node-exporter),
which lives in its own repository (`server/monitoring` on the host, README there). This repo only exposes what it
needs.

## Networks

`kanbot_server` joins the external `kanbot_metrics_network` (alias `kanbot-server`) next to `caddy_network` and
`kanbot_network`. Create it once on the host before the first deploy that needs it:

```sh
docker network create kanbot_metrics_network   # Prometheus + Gatus → /metrics and /health
```

Only Prometheus and Gatus may join that network. `kanbot_network` stays internal to the compose project
(server ↔ `kanbot_db`), and Caddy reaches the server over `caddy_network` on the public port only.

## Endpoints

| Route      | Listener              | Purpose                                                              |
| ---------- | --------------------- | -------------------------------------------------------------------- |
| `/health`  | `PORT` (8787)         | `select 1` against Postgres, 200 / 503; the compose healthcheck and Gatus use it |
| `/metrics` | `METRICS_PORT` (8788) | Prometheus text format; not reachable through Caddy                  |

Caddy's upstream is `{{upstreams 8787}}`, so `/metrics` is only reachable from the metrics network. Check after a
deploy: `curl -i https://<PUBLIC_HOSTNAME>/metrics` must not return Prometheus text.

## Metrics

`server/src/metrics.ts`, all prefixed `kanbot_`:

| Metric                              | Labels                  | Counts                                                       |
| ----------------------------------- | ----------------------- | ------------------------------------------------------------ |
| default process / runtime metrics   |                         | memory, CPU, event loop lag, handles                         |
| `build_info`                        | `version`               | always 1; the deployed image tag (`APP_VERSION`)             |
| `http_requests_total`               | `method`, `route`, `status` | every HTTP request; `route` is the matched pattern (`/boards/:id`), `unmatched` for none |
| `http_request_duration_seconds`     | `method`, `route`       | request duration histogram                                   |
| `dependency_up`                     | `dependency` (`db`)     | health check at scrape time                                  |
| `db_connections`                    | `state`                 | `pg_stat_activity` rows of this database by state            |
| `db_size_bytes`                     |                         | `pg_database_size(current_database())`                       |
| `entities`                          | `entity`                | row counts: users, workspaces, boards, columns, tasks, comments, api_keys, events |
| `auth_failures_total`               | `reason`                | rejected login, refresh and registration attempts            |
| `ws_connections`                    |                         | open realtime WebSocket subscriptions                        |
| `events_published_total`            | `type`, `actor`         | committed events fanned out to subscribers (`user` / `agent`) |
| `mcp_calls_total`                   | `tool`, `result`        | MCP tool calls (`ok` / `error` / `internal`)                 |
| `mcp_call_duration_seconds`         | `tool`                  | MCP tool call duration histogram                             |

Labels are matched routes and fixed strings from the code. Never add a user id, email, board or task id as a label.

## Logs

Every request logs one JSON line to stdout: `{"level":"info","msg":"request","method":"GET","route":"/boards/:id",
"status":200,"durationMs":7}`. The route pattern carries no ids; query strings, bodies and headers are never logged.
Unexpected errors reach `console.error` (the `onError` handler) and may include a stack.

Alloy ships every container's stdout to Loki, labelled `container`, `compose_project`, `compose_service`. For the
`kanbot` compose project it censors emails, tokens and secrets, so what slips out of an error log does not land in
Loki.

## Dashboards and alerts

Provisioned from files in the monitoring repo (`grafana/provisioning`, `grafana/dashboards/kanbot/kanbot.json`):
the `kanbot` dashboard plus Grafana alert rules mailed to `ALERT_EMAIL`: metrics target down, database down, more
than 5 server errors in 5 minutes, and the shared Gatus uptime rule for the public URL and `/health`.

# Kanbot

Kanban project management (Trello/Jira-like) with native macOS + iOS apps and first-class AI agent integration via MCP.

## Layout
- `docs/api.md` — **API contract**. Server and Swift client both implement it. Change contract first, in same PR as code.
- `server/` — Bun + Hono + Drizzle ORM + Postgres. REST, WebSocket realtime, MCP endpoint (`/mcp`).
- `apps/` — SwiftUI multiplatform (macOS 15+, iOS 18+). `KanbotKit` Swift package = models, API client, sync. Built on macOS only (Xcode).
- `docker-compose.yml` — Postgres + server for local dev.

## Rules
- All mutations go through `server/src/services/*`: write row + `events` row in one transaction, then broadcast. REST routes and MCP tools are thin wrappers — never duplicate domain logic.
- Every mutation records an `Actor` (user or agent) so the apps can show who/what changed things.
- Permission checks: workspace membership for users; API keys limited to their workspace.

## Commands
- `docker compose up -d db` then `cd server && bun install && bun run db:migrate && bun run dev`
- `cd server && bun test`
- `xcodebuild -project apps/Kanbot.xcodeproj -scheme Kanbot -destination 'platform=macOS' build`

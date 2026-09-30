# Kanbot API contract (v1)

Single source of truth between `server/` and `apps/KanbotKit`. Change this file first, then both sides.

## Conventions
- Base URL: `http://localhost:8787` in dev. All JSON, `camelCase` keys.
- IDs: UUID v7 strings. Timestamps: ISO-8601 UTC strings (`2026-09-30T12:00:00.000Z`).
- Auth header: `Authorization: Bearer <accessToken>` (users) or `Bearer kb_<apiKey>` (agents; MCP + REST).
- Errors: HTTP status + `{ "error": { "code": "not_found", "message": "..." } }`.
  Codes: `bad_request`, `unauthorized`, `forbidden`, `not_found`, `conflict`.
- `position`: fractional-index string (lexicographic sort). Client may send `beforeId`/`afterId` instead; server computes position.

## Models
```jsonc
User          { id, email, name, createdAt }
Workspace     { id, name, role /* owner|admin|member, of current user */, createdAt }
Member        { userId, name, email, role, joinedAt }
Board         { id, workspaceId, name, createdAt, updatedAt }
Column        { id, boardId, name, position, wipLimit /* int|null */ }
Task          { id, boardId, columnId, title, description /* markdown */, position,
                assigneeId /* uuid|null */, labels /* string[] */, dueAt /* string|null */,
                createdBy: Actor, createdAt, updatedAt }
Comment       { id, taskId, body, actor: Actor, createdAt }
Actor         { type: "user"|"agent", id, name }
ApiKey        { id, workspaceId, name, prefix /* first 8 chars */, createdAt, lastUsedAt }
Event         { seq /* int, per workspace, strictly increasing */, workspaceId, actor: Actor,
                type, entityId, payload /* full entity after change, or {id} on delete */, createdAt }
```
Event types: `board.created|updated|deleted`, `column.created|updated|deleted`,
`task.created|updated|moved|deleted`, `comment.created`, `member.added|removed`.

## Auth
| Method | Path | Body | Response |
|---|---|---|---|
| POST | /auth/register | {email,password,name} | {user, accessToken, refreshToken} |
| POST | /auth/login | {email,password} | {user, accessToken, refreshToken} |
| POST | /auth/refresh | {refreshToken} | {accessToken, refreshToken} |
| GET | /me | – | User |

Access token: JWT, 15 min. Refresh token: opaque, 30 days, rotated on use.

## Workspaces & members
| Method | Path | Body | Response |
|---|---|---|---|
| GET | /workspaces | – | Workspace[] |
| POST | /workspaces | {name} | Workspace (creator = owner; seeds nothing) |
| GET | /workspaces/:id/members | – | Member[] |
| POST | /workspaces/:id/invites | {role} | {token, url} (admin+) |
| POST | /invites/:token/accept | – | Workspace |
| DELETE | /workspaces/:id/members/:userId | – | 204 (admin+) |

## Boards, columns, tasks, comments
| Method | Path | Body | Response |
|---|---|---|---|
| GET | /workspaces/:id/boards | – | Board[] |
| POST | /workspaces/:id/boards | {name} | Board (seeds columns: Backlog, Ready for Dev, In Progress, Review, Done) |
| GET | /boards/:id | – | {board, columns: Column[], tasks: Task[]} |
| PATCH | /boards/:id | {name} | Board |
| DELETE | /boards/:id | – | 204 (admin+) |
| POST | /boards/:id/columns | {name, afterId?, wipLimit?} | Column |
| PATCH | /columns/:id | {name?, wipLimit?, beforeId?, afterId?} | Column |
| DELETE | /columns/:id | – | 204 (409 if not empty) |
| POST | /boards/:id/tasks | {title, columnId, description?, assigneeId?, labels?, dueAt?} | Task (appended at end of column) |
| GET | /tasks/:id | – | {task, comments: Comment[]} |
| PATCH | /tasks/:id | any of {title, description, assigneeId, labels, dueAt} | Task |
| POST | /tasks/:id/move | {columnId, beforeId?, afterId?} | Task |
| DELETE | /tasks/:id | – | 204 |
| POST | /tasks/:id/comments | {body} | Comment |
| GET | /workspaces/:id/tasks/search?q= | – | Task[] |

## Agent API keys (admin+)
| Method | Path | Body | Response |
|---|---|---|---|
| GET | /workspaces/:id/api-keys | – | ApiKey[] |
| POST | /workspaces/:id/api-keys | {name} | {apiKey: ApiKey, secret: "kb_..."} (secret shown once) |
| DELETE | /api-keys/:id | – | 204 |

An API key acts as `Actor{type:"agent", name: apiKey.name}` in its workspace only.

## Sync
- `GET /workspaces/:id/events?since=<seq>&limit=500` → `{events: Event[], latestSeq}`.
- WebSocket `GET /ws?token=<accessToken>&workspaceId=<id>` → server pushes
  `{"kind":"event","event":Event}`; sends `{"kind":"hello","latestSeq":N}` on connect.
  Client pings `{"kind":"ping"}` every 25s, server replies `{"kind":"pong"}`.
- Client algorithm: load snapshot (`GET /boards/:id`), remember `latestSeq`, apply WS events with
  `seq > latestSeq`; on gap or reconnect call `/events?since=`.
- Conflicts: last write wins per field.

## MCP
`POST /mcp` Streamable HTTP, auth with agent API key. Tools (thin wrappers over same services):
`list_boards`, `get_board`, `search_tasks`, `get_task`, `create_task`, `update_task`,
`move_task` (`column` = id or case-insensitive name, e.g. "Ready for Dev"), `assign_task`
(by member email or name), `add_comment`, `create_column`, `reorder_columns`, `list_members`.

## Clarifications (server v1)
Non-breaking notes on behaviour the tables above leave open. Nothing here changes an existing shape.
- **Status codes**: successful requests return `200` with the documented body (including creates); deletes return `204`.
  A resource that exists but is outside your workspaces → `403 forbidden`; unknown/malformed id → `404 not_found`.
  Unexpected server errors → `500` with code `internal`.
- **Placement** (`beforeId`/`afterId`, tasks and columns): `afterId` = place immediately after that sibling,
  `beforeId` = immediately before it; both = between them (`afterId` must precede `beforeId`). Ids must be siblings in the
  target list (target column for tasks, same board for columns), else `400`. With neither, a task move / new column
  goes to the end; `PATCH /columns/:id` without them keeps the current position.
- **Column references**: `columnId` in `POST /boards/:id/tasks` and `POST /tasks/:id/move` also accepts a
  case-insensitive column name (same resolution as MCP `move_task`). Moving to a column of another board → `404`.
- **Search**: `GET /workspaces/:id/tasks/search?q=&boardId=&limit=` — `boardId` and `limit` (default 100, max 500) are
  optional. Matches title/description (case-insensitive substring) or an exact label; most recently updated first.
- **Events**: `limit` defaults to 500 (max 1000). If a page has `limit` events, page again with `since` = last seq.
  Creating a workspace records `member.added` for the owner (seq 1). `member.added` payload is a `Member`;
  `member.removed` payload is `{id: userId}`; for member events `entityId` = userId. Deleting a board emits only
  `board.deleted` (its columns/tasks/comments go with it). Creating a board emits `board.created` followed by one
  `column.created` per seeded column. `comment.created` payload is a `Comment`.
- **Invites**: `role` is `admin` or `member` (default `member`). Tokens are single use and expire after 7 days;
  accepting while already a member returns the workspace without consuming the invite. `url` = `PUBLIC_URL/invites/<token>`.
- **Deleting**: deleting a board (with all its columns, tasks and comments) requires the `admin` role (or owner).
  Members may delete columns and tasks. Agents (API keys) cannot delete boards, columns or tasks → `403 forbidden`.
- **Members**: admins may remove members; only the owner may remove admins; the owner cannot be removed.
  Any non-owner may remove themselves (leave). Removed users' WebSockets are closed with code `4403`.
- **API keys**: act with `member` rights in their workspace only — admin-only endpoints (invites, api-keys,
  member removal, board delete), `DELETE /columns/:id`, `DELETE /tasks/:id`, `POST /workspaces` and `/me` return
  `403` for agents. `GET /workspaces` returns just the key's
  workspace (role `member`). `secret` = `kb_` + 43 base64url chars; `prefix` = its first 8 characters.
- **WebSocket**: `token` may also be an API key. Failed auth → HTTP `401`/`403` with the error JSON instead of an upgrade.
  Events committed while `hello` is being prepared are delivered after it (only those with `seq > latestSeq`).
- **MCP tools** accept a board id or case-insensitive board name (`board`, optional when the workspace has one board).
  `reorder_columns` takes the complete ordered list of column ids/names. Tool errors are returned as `isError` results
  whose text is the error JSON above.

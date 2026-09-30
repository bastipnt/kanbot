# Kanbot

Kanban boards for humans and AI agents. Native macOS + iOS apps (SwiftUI), a self-hostable sync server (Bun + Postgres), and an MCP endpoint so agents like Claude can organize boards and act on tasks — e.g. move a task to *Ready for Dev*.

- API contract: [docs/api.md](docs/api.md)
- Server: [server/](server/)
- Apps: [apps/](apps/)

## Server quickstart

`docker-compose.yml` requires `JWT_SECRET` (there is no default). Put a random one in a git-ignored `.env` next to
it once — Compose reads that file automatically, also for `docker compose up -d db`:

```sh
echo "JWT_SECRET=$(openssl rand -base64 48)" >> .env
```

(or pass it per command: `JWT_SECRET=$(openssl rand -base64 48) docker compose up -d --build`). In production the
server refuses secrets shorter than 32 characters or containing `insecure`/`change-me`.

Everything in Docker:

```sh
docker compose up -d --build      # Postgres 17 + server on http://localhost:8787 (runs migrations on start)
curl localhost:8787/health
```

Local development (Bun ≥ 1.2):

```sh
docker compose up -d db           # Postgres on 127.0.0.1:5432 (set DB_PORT=5433 to use another host port)
cd server
cp .env.example .env              # DATABASE_URL, JWT_SECRET, PUBLIC_URL
bun install
bun run db:migrate
bun run dev                       # http://localhost:8787, reloads on change
bun test                          # integration tests against the DATABASE_URL database (it is wiped!)
```

After changing `server/src/db/schema.ts`, run `bun run db:generate` to create a new migration in `server/drizzle/`.

### Try it

```sh
# Register (returns accessToken + refreshToken), create a workspace and a board
TOKEN=$(curl -s localhost:8787/auth/register -H 'content-type: application/json' \
  -d '{"email":"me@example.com","password":"change-me-please","name":"Me"}' | jq -r .accessToken)
WS=$(curl -s localhost:8787/workspaces -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"Acme"}' | jq -r .id)
curl -s localhost:8787/workspaces/$WS/boards -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"Roadmap"}'

# Create an agent API key (the secret is shown once)
curl -s localhost:8787/workspaces/$WS/api-keys -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"Claude"}' | jq -r .secret
```

## Deploy (Docker host with caddy-docker-proxy)

Pushes to `main` that touch the server run `.github/workflows/deploy.yml`: server tests → build
`ghcr.io/<owner>/kanbot-server:<sha>` → SSH to the host → `infra/deploy/remote-deploy.sh`, which backs up Postgres,
runs `docker compose -f docker-compose.prod.yml up --wait` and rolls back to the previous image if the server doesn't
become healthy. Migrations run when the server starts. It can also be started manually (*Run workflow*).

The host needs Docker, a caddy-docker-proxy on the external `caddy_network`, and a DNS record for the hostname. One-time
setup on the host:

```sh
mkdir -p ~/kanbot && cd ~/kanbot
# copy .env.production.example from this repo to .env.production and fill it in
chmod 600 .env.production
```

GitHub → Settings → Environments → `production`, secrets:

| Secret | Value |
|---|---|
| `DEPLOY_HOST` | server hostname or IP |
| `DEPLOY_PORT` | SSH port (optional, default 22) |
| `DEPLOY_USER` | SSH user, must be allowed to run `docker` |
| `DEPLOY_SSH_KEY` | private key of a deploy-only key pair (public key in the user's `authorized_keys`) |
| `DEPLOY_KNOWN_HOSTS` | output of `ssh-keyscan -p <port> <host>` |
| `DEPLOY_PATH` | directory holding `.env.production`, e.g. `/home/deploy/kanbot` |

### Invite users

Production defaults to `REGISTRATION_DISABLED=true`: only people with a signup invite can create an account. On the
host, create one (single use, 7 days by default; `--email` restricts it to that address):

```sh
cd ~/kanbot
docker compose -f docker-compose.prod.yml --env-file .env.production exec server \
  bun run invite:create --email friend@example.com
```

They enter the printed code as *Invite code* when creating their account in the app, then join a workspace with a
normal workspace invite link. Locally: `cd server && bun run invite:create`.

If the `kanbot-server` package on GHCR is private, run `docker login ghcr.io` on the host once with a token that can
read packages, or make the package public. Backups of the last 10 deploys are kept in `$DEPLOY_PATH/backups/`.

## Connect Claude Code (MCP)

Kanbot exposes an MCP server at `POST /mcp` (Streamable HTTP). Authenticate with an agent API key of the workspace
the agent should work in:

```sh
claude mcp add --transport http kanbot http://localhost:8787/mcp --header "Authorization: Bearer kb_..."
```

Then ask Claude things like *"Move the login task to Ready for Dev and leave a comment"*. Available tools:
`list_boards`, `get_board`, `search_tasks`, `get_task`, `create_task`, `update_task`, `move_task`, `assign_task`,
`add_comment`, `create_column`, `reorder_columns`, `list_members`. Every change made by an agent is recorded with
`Actor{type:"agent"}` and streamed live to the apps.

## Status
Early development.

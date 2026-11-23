# Relay

A personal card-and-column tracker for everything you do, built so that you, your apps and your AI agents all work on the same board.

- **Simple board.** Boards hold columns, and columns hold cards. Drag and drop, labels, priority, due dates, assignee, Markdown descriptions with checklists, and comments.
- **Complete history.** Every change records who made it, from where, when, why, and full before/after snapshots. Nothing is hard-deleted.
- **Agent sign-off.** Changes made with an *agent* token go live right away and also land in a sign-off queue. You can approve them, or reject them, which reverts them. They're grouped by agent and session, so you can review an agent's whole run at once.
- **API parity.** The built-in web UI uses only the public REST API, and every REST operation is also an MCP tool with the same name and input. Both come from one operation registry, so they can't drift apart.
- **Runs on Cloudflare Workers + D1.** One click to deploy, no servers, and it fits in the free tier for personal use.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/alechash/relay)

## Deploy

### One click

1. Click **Deploy to Cloudflare** above. The repository has to be public for the button to work. For a private repo, use the manual steps below.
2. When it asks for **ADMIN_TOKEN**, paste a long random string (`openssl rand -hex 32`). This is your master password.
3. Cloudflare copies the repo to your GitHub account, creates the D1 database and deploys the Worker. From then on, every push to that repo redeploys automatically.
4. Open the Worker URL and sign in with your `ADMIN_TOKEN`.

There is no migration step. The Worker sets up its database schema on the first request.

**Alternative to the secret:** Relay also accepts an admin token whose SHA-256 hash is stored in its own database. This is handy if you can reach D1 but not the Worker's secrets:

```sh
TOKEN=$(openssl rand -hex 32); echo "$TOKEN"   # keep this, it's your admin token
HASH=$(printf %s "$TOKEN" | sha256sum | cut -d' ' -f1)
npx wrangler d1 execute DB --remote --command \
  "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('admin_token_sha256', '$HASH', datetime('now'))"
```

Either credential works, and `/healthz` reports which one is in use (`"admin_token": "env" | "database" | "missing"`). To rotate a database-stored token, run the same command with a new token. Note that if the secret isn't set, existing web sessions sign out on rotation.

### Manually

```sh
npm install
npx wrangler login
npx wrangler deploy                    # creates the D1 database on first deploy
npx wrangler secret put ADMIN_TOKEN    # paste a long random string
```

## Connect agents and apps

In the web UI, open **Settings → API & agent tokens** and create one token per agent or app. Every change is attributed to the token's name.

| Token kind | Sign-off | Can review / manage tokens | Use for |
| --- | --- | --- | --- |
| `agent` | required (configurable) | no | Claude Code, Cursor, automations |
| `human` | not required | yes | your own scripts, a mobile app, CLI |
| `ADMIN_TOKEN` | not required | yes | you (web UI login, emergency access) |

Any token can be made read-only.

**Claude Code (MCP):**

```sh
claude mcp add --transport http relay https://<your-worker>/mcp \
  --header "Authorization: Bearer rly_…"
```

**Other MCP clients** (Streamable HTTP):

```json
{ "mcpServers": { "relay": { "type": "http", "url": "https://<your-worker>/mcp",
  "headers": { "Authorization": "Bearer rly_…" } } } }
```

Each MCP connection gets its own session, so one agent run shows up as one batch in the sign-off queue. The client name (for example `claude-code/2.1`) is recorded on every change.

**REST:**

```sh
curl -H "Authorization: Bearer rly_…" https://<your-worker>/api/v1/boards

curl -X POST https://<your-worker>/api/v1/cards \
  -H "Authorization: Bearer rly_…" -H "Content-Type: application/json" \
  -d '{"board_id":"brd_…","column":"To do","title":"Renew passport","reason":"From my inbox"}'
```

Optional headers: `X-Relay-Session` groups related changes for review, and `X-Relay-Client` names the client in the history.

## API

- Human-readable reference: `https://<your-worker>/docs`
- OpenAPI 3.1: `https://<your-worker>/api/v1/openapi.json`

| Area | Operations (REST path ⇄ MCP tool) |
| --- | --- |
| Meta | `GET /me` get_me · `GET /export` export_data |
| Boards | `GET/POST /boards` · `GET/PATCH /boards/{id}` |
| Columns | `POST /boards/{id}/columns` · `PATCH /columns/{id}` |
| Cards | `GET/POST /cards` · `GET/PATCH /cards/{id}` · `POST /cards/{id}/move` · `GET /cards/{id}/history` |
| Comments | `GET/POST /cards/{id}/comments` · `DELETE /comments/{id}` |
| History | `GET /events` · `GET /events/{id}` · `POST /events/{id}/revert` |
| Sign-off | `GET /reviews` · `POST /reviews/approve` · `POST /reviews/reject` |
| Tokens | `GET/POST /tokens` · `PATCH/DELETE /tokens/{id}` |

Conventions:

- `card_id` accepts `crd_…`, `42` or `#42`.
- Positions are 0-based indexes.
- Archive instead of delete (`archived: true`).
- Pass `expected_version` to get a 409 instead of overwriting someone else's change.
- Every write accepts a `reason`, which is shown during sign-off.
- To follow new activity, poll `GET /events?after_seq=N`.

## How it fits together

```
src/ops/index.ts     one registry of operations (zod input schema + handler + access rule)
   ├── src/rest.ts       → REST routes under /api/v1
   ├── src/mcp.ts        → MCP tools at /mcp (stateless Streamable HTTP)
   ├── src/openapi.ts    → /api/v1/openapi.json
   └── src/docs.ts       → /docs
src/core/*           boards, columns, cards, comments, history/sign-off/revert, tokens
src/db.ts            schema + self-applying migrations
public/              the web UI (plain HTML/CSS/JS, uses /api/v1 like any other client)
```

Each change and its history event are written in one D1 batch (a transaction), so the history can't miss a change. Reverts restore the event's before-snapshot. They refuse with a 409 if the item changed afterwards, unless you force them, and the revert is itself recorded as an event.

## Develop

```sh
npm install
cp .dev.vars.example .dev.vars   # set ADMIN_TOKEN
npm run dev                      # http://localhost:8787
npm test                         # end-to-end tests against a local Worker + D1
npm run typecheck
```

To add a feature, add an operation in `src/ops/index.ts`. It shows up in REST, MCP, OpenAPI and the docs automatically. Schema changes go in `src/db.ts` as a new migration entry.

## Notes and limits

- Single owner. Additional "people" are just human tokens.
- Remote MCP clients that require OAuth (for example claude.ai custom connectors) aren't supported yet. Use clients that can send an `Authorization` header (Claude Code, Cursor, and most others), or put a bridge such as `mcp-remote` in front.
- Real-time updates are polling-based (the UI checks for new activity every 10 seconds).

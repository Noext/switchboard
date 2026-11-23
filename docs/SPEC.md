# Switchboard — design document

Switchboard is an **MCP gateway**: one endpoint that every agent connects to, which itself connects
to all of an operator's upstream MCP servers (remote HTTP, local stdio, with API keys or OAuth) and
exposes them aggregated, with per-key and per-tool access control.

The problem it solves is configuration drift. Every MCP client — Claude Code, Codex, each sandbox,
each CI agent — keeps its own server list. Adding one upstream means editing every config file, and
granting a new agent a narrow slice of a server means either over-sharing credentials or inventing a
bespoke setup. Switchboard moves that configuration server-side: an upstream is added once, every
agent points at one URL with its own key, and what that key may see and call is decided per request
from the database.

---

## 1. Overview

1. Each agent (Claude Code, Codex, …) has **one MCP configured**: `https://switchboard.example.com/mcp`
   with **its own API key** (`sk-sw-…`, one per agent), created in the admin UI.
2. The operator adds **upstream** MCP servers in the UI: remote HTTP (streamable HTTP or SSE), stdio
   (an `npx`/`uvx`/`docker run` command spawned by the gateway), authenticated with headers, a bearer
   token, or **OAuth 2.1**.
3. The gateway aggregates their **tools, prompts and resources**, prefixed by the upstream's short
   name (`github__create_issue`).
4. When an upstream is added, removed or changed, the gateway sends
   `notifications/tools/list_changed` to open sessions: agents **already running** see the new tools
   without a restart (if the client honours it — otherwise at the next session, still with no config
   change).
5. Upstream secrets (tokens, keys, OAuth refresh tokens) stay **encrypted in the gateway**. Agents
   never see them.
6. **Fine-grained rights per key**: which MCPs a key may use and, within each MCP, **which tools**.
   Reusable **roles** apply to several keys, with per-key adjustments. What is not granted is
   **neither listed nor callable**. See §7.
7. Two exposure modes per key: **direct** (all granted tools listed) or **discovery** (four meta-tools,
   so hundreds of tool definitions do not flood the context).
8. **Feedback loop**: a global `report_feedback` tool, always available to every agent key, lets an
   agent report a broken tool, a missing grant or a misleading description. Reports appear in a
   **Feedback** page where an operator can act on them directly.
9. Import an existing `.mcp.json` / `~/.claude.json` / `claude_desktop_config.json` / Codex TOML by
   pasting it.
10. **One Next.js project** (UI + admin API + MCP endpoint + stdio process manager), one process,
    deployed with `docker compose` behind any TLS-terminating reverse proxy.

### Why build it rather than use an existing gateway

Existing open-source gateways cover part of the problem — MetaMCP (namespaces, Docker Compose, MIT),
IBM ContextForge (MCP/A2A/REST federation, heavier), Docker MCP Gateway (one container per server).
What none of them combined at the time: **per-key and per-tool access control with reusable roles**,
an upstream OAuth flow that survives restarts, and a discovery mode designed to remain enumerable.
Those three are the core of this design.

---

## 2. Architecture

```
 Agent A (Claude Code) ─┐                    ┌──────────── Switchboard (one process) ──────────┐
 Agent B (Codex)       ─┼── HTTPS /mcp ─────►│ server.ts (Node)                                 │
 Sandbox / CI agent    ─┘  Bearer sk-sw-…    │  ├─ /mcp     → Gateway (MCP Server, sessions)    │
                                             │  │            ├─ AccessControl (key → tools)    │
 Operator ── browser ───────────────────────►│  ├─ /*       → Next.js (UI, /api/v1, OAuth)      │
                                             │  ├─ UpstreamManager                              │
                                             │  │   ├─ HttpUpstream (streamable HTTP / SSE) ──►│──► remote MCPs
                                             │  │   ├─ StdioUpstream (child process) ─────────►│──► npx / uvx / docker
                                             │  │   └─ OAuthManager (encrypted tokens, refresh)│
                                             │  └─ data/ : switchboard.db (SQLite), master key │
                                             └──────────────────────────────────────────────────┘
```

### Components

- **UpstreamManager** — one SDK `Client` per enabled upstream. Handles connect, `initialize`,
  caching of `tools/list`, `prompts/list`, `resources/list` and `resources/templates/list`, listening
  for the upstream's own `list_changed`, reconnection with exponential backoff (1 s → 60 s), timeouts
  and health.
- **Catalog** — an aggregated view (tools/prompts/resources from every healthy upstream) with
  prefixed public names, per-item overrides (enabled, alias, description), and a version number
  incremented on every change.
- **Gateway** — implements the server side of MCP. Per client session: key → effective access (§7.3)
  → filtered catalog → answers `tools/list`, `tools/call`, `prompts/*`, `resources/*`. Subscribes to
  catalog changes and pushes `notifications/{tools,prompts,resources}/list_changed` to the sessions
  whose view actually changed.
- **OAuthManager** — OAuth 2.1 client for each upstream that needs it.
- **ProcessManager** — stdio process lifecycle (start, stop, restart on crash, stderr ring buffer).
- **Next.js** — admin UI, REST admin API, `/oauth/callback`.

### Stack

| Need | Choice |
|---|---|
| Framework | Next.js (App Router), TypeScript strict. Admin UI, admin API route handlers, OAuth callback and server actions are standard Next.js. |
| MCP endpoint | Mounted in the **same process** by a custom Node server (`server.ts`: `next({ dev })` + `app.getRequestHandler()`), which intercepts `/mcp` and hands it to the SDK's `StreamableHTTPServerTransport` (stateful sessions, SSE). Everything else is delegated to Next. `npm run dev` runs this same `server.ts`. No second service, no second repo. |
| MCP | `@modelcontextprotocol/sdk`: `Server` on the client-facing side; `Client` + streamable HTTP / SSE / stdio transports on the upstream side; `OAuthClientProvider` for OAuth. |
| UI | Tailwind CSS + hand-rolled components, server components by default. |
| DB | SQLite (`better-sqlite3`), migrations applied at startup. |
| Validation | zod, shared between UI, API and MCP. |
| Search (discovery mode) | SQLite FTS5 (with a LIKE fallback). |
| Logs | pino (JSON). |
| Tests | vitest; the gateway is driven through the SDK's in-memory transports. |

`output: "standalone"` generates its own `server.js` and does not fit a custom server, so the Docker
image ships `.next/`, production `node_modules` and `dist/server.js`, and starts with
`node dist/server.js`.

### One process, two module graphs

The custom server (`dist/server.js`) and Next's own bundle both import the same `lib/` files but get
**separate module instances**. Every piece of shared state therefore lives on `globalThis` through
`lib/runtime/global.ts`: the SQLite handle, the upstream manager, the catalog store, the redactor,
the UI event bus, the settings cache. Without this, an upstream created through the admin API writes
to SQLite but never reaches the manager serving `/mcp` — it stays `connecting` forever. This is the
single most important implementation detail in the codebase.

---

## 3. Data model (SQLite)

```ts
upstreams {
  id, slug (unique, [a-z0-9]{1,12}),      // public prefix, e.g. "gh", "jira"
  name, description,
  transport ("http" | "sse" | "stdio"),
  url,                                   // http/sse
  command, args, cwd,                    // stdio
  envEnc, headersEnc,                    // encrypted (JSON)
  authType ("none" | "headers" | "bearer" | "oauth"),
  oauthEnc,                              // {clientId, clientSecret?, tokens, metadata}
  enabled, startMode ("always" | "lazy"), idleStopMinutes,
  callTimeoutSeconds,
  status ("connecting" | "ready" | "degraded" | "auth_required" | "error" | "disabled"),
  lastError, lastReadyAt, capabilities, serverInfo,
  createdAt, updatedAt
}
upstream_items { upstreamId, kind ("tool"|"prompt"|"resource"|"resource_template"), name, definition, fetchedAt }
item_overrides { upstreamId, kind, name, enabled, alias, descriptionOverride }
api_keys {
  id, name (unique), prefix, hash (sha256),
  scope ("agent" | "admin"), exposureMode ("direct" | "discovery"),
  expiresAt, createdAt, lastUsedAt, revokedAt, rotatedAt,
  prevHash, prevHashExpiresAt            // rotation grace window
}
roles { id, name (unique), description }
key_roles { keyId, roleId }
grants {                                 // a subject (role OR key) → an upstream
  id, subjectType ("role" | "key"), subjectId, upstreamId,
  toolMode ("all" | "selected"), prompts, resources
}
grant_tools { grantId, toolName }        // used when toolMode = "selected"
key_denies { keyId, upstreamId, toolName }   // toolName null = whole upstream
tool_discoveries { upstreamId, toolName, firstSeenAt, acknowledgedAt }
feedback { id, keyId, sessionId, clientInfo, category, severity, title, description,
           upstreamSlug, toolName, attemptedAction, errorMessage, relatedCallId,
           occurrences, lastOccurrenceAt, status, adminNote }
call_logs { id, at, keyId, sessionId, upstreamId, kind, name, argsPreview, resultPreview,
            ok, errorCode, denied, durationMs }
events { id, at, actor, type, upstreamId, message, data }
settings { key, value }
```

- **Encryption**: AES-256-GCM. Master key from `SWITCHBOARD_MASTER_KEY` (32 bytes base64) or generated
  into `data/master.key` on first run.
- **`call_logs` retention**: 30 days or 100 000 rows, whichever is hit first.

---

## 4. Upstreams

### 4.1 Transports

| Transport | Connection | Notes |
|---|---|---|
| `http` (streamable HTTP) | `StreamableHTTPClientTransport` | Default for remote MCPs. |
| `sse` (legacy) | `SSEClientTransport` | Compatibility; automatic fallback if `http` fails `initialize` with 4xx/405. |
| `stdio` | `StdioClientTransport` | `command` + `args` + encrypted `env`; stderr kept in a 500-line ring buffer visible in the UI. |

### 4.2 Upstream authentication

- `none`.
- `headers`: arbitrary headers (e.g. `X-API-Key`), encrypted.
- `bearer`: `Authorization: Bearer <token>`, encrypted.
- `oauth`: the standard MCP flow, handled by the gateway:
  1. First request → `401` + `WWW-Authenticate` → discovery of protected-resource metadata
     (RFC 9728), then of the authorization server (RFC 8414 / OIDC discovery).
  2. Client registration: **Client ID Metadata Document** if supported, else **dynamic registration**
     (RFC 7591), else manual `client_id`/`client_secret` entry in the UI.
  3. "Connect" button in the UI → browser redirect with PKCE (S256), signed `state`, `resource`
     parameter (RFC 8707) → `/oauth/callback` → code exchange → encrypted tokens.
  4. Automatic refresh before expiry; if refresh fails → status `auth_required`, an event, and a
     banner in the UI. That upstream's tools disappear from the catalog (and `list_changed` is sent)
     until reconnected.

### 4.3 Lifecycle and health

- At startup: connect every `enabled` upstream with `startMode=always`, in parallel (limit 5).
- A `ready` upstream that loses its connection → `degraded` → reconnect with backoff; after 5
  failures → `error` (retry every 5 minutes).
- MCP `ping` every 60 s on HTTP/SSE upstreams.
- **Lazy stdio**: the listing is cached from the last start, so tools stay visible while the process is
  stopped; a call starts the process (waiting for `initialize`, ≤ 30 s); it stops after
  `idleStopMinutes`.
- Listening for the upstream's `list_changed` → re-list → catalog update.
- Any config change on an upstream → reconnect that upstream only.

---

## 5. Catalog and naming

- A tool's public name is `<slug>__<name>` (e.g. `gh__create_issue`). Same for prompts. Resources keep
  their URI, with a URI → upstream routing table; on a URI collision the resource is rewritten to
  `switchboard://<slug>/<encoded uri>`.
- Constraints: characters `[a-zA-Z0-9_-]`, **≤ 64 characters** total. Clients often add their own
  prefix (Claude Code: `mcp__switchboard__`, 18 characters), so the **target is ≤ 46 characters**;
  beyond that the name is truncated and suffixed with 4 hash characters, and the UI shows a warning
  and offers an alias.
- Per-item overrides: disable, alias, rewrite the description.
- `annotations` (readOnlyHint, destructiveHint, …), `inputSchema` and `outputSchema` are **passed
  through untouched**.
- The catalog has a version. Every change (upstream ready/lost, listing changed, override, rights or
  roles changed, key revoked) → recompute effective views (§7.3) → diff per key → notify only the
  sessions whose view changed (debounced 500 ms).
- `report_feedback` is a **reserved name**. An upstream tool can never collide with it because every
  upstream tool is prefixed.

---

## 6. The gateway as an MCP server

### 6.1 Endpoint

- `POST/GET/DELETE /mcp`, streamable HTTP **with sessions** (`Mcp-Session-Id`), server→client SSE
  stream on `GET` for notifications. Advertised capabilities: `tools.listChanged`,
  `prompts.listChanged`, `resources.listChanged` + `subscribe`, `logging`.
- Auth: `Authorization: Bearer sk-sw-…` → key → effective view (§7.3). Missing, unknown, revoked or
  expired → `401`. A `scope=admin` key is accepted, but receives the admin tool surface instead
  of upstream tools (§6.6). Revoking a key closes its open sessions
  immediately.
- Idle sessions (24 h) are closed. After a gateway restart, clients re-initialize (an unknown session
  id yields `404`, which conformant clients handle by creating a new session).
- Server `instructions`: a short generated text listing the upstreams the key can see, what each is
  for, the total tool count, a few real tool names to start from, and — in discovery mode — how the
  meta-tools work.

### 6.2 Calls

- `tools/call` → **access check on every call** (not just on listing: a client can call a name it
  cached). An unauthorised tool returns the **same** JSON-RPC error as a nonexistent tool, so
  existence is not revealed, and writes a `call_logs` row with `denied`. Then routing to the
  upstream with the original name restored, arguments passed through, the upstream's timeout,
  **cancellation** (`notifications/cancelled`) and **progress** (`notifications/progress`) relayed in
  both directions.
- An unavailable upstream → `isError: true` with an actionable message ("the jira server needs an
  OAuth reconnect in Switchboard").
- Every call → `call_logs` (previews truncated to 2 KB, known secrets masked).

### 6.3 Discovery mode

When a key has more than `discoveryThreshold` tools (default 60), `discovery` mode replaces the tool
list with four meta-tools:

| Tool | Role |
|---|---|
| `list_servers({})` | Upstream inventory: which servers this key may use, with tool counts and descriptions. Also reports how many upstreams exist but are not granted (names withheld). |
| `search_tools({query?, limit=10})` | Full-text search over the **authorised** tools only (name + description + parameter names, FTS5). With **no query** (or `"*"`), lists **every** authorised tool grouped by upstream. |
| `describe_tool({name})` | Full input schema and annotations. Works for the gateway's own meta-tools too. |
| `call_tool({name, arguments})` | Execution, same rules as `tools/call`. |

Prompts stay listed normally. `report_feedback` is always appended.

**Why the enumeration path matters.** The first version required a non-empty `query`, so an agent
facing 80 tools had no way to ask "what do I have?". A real agent burned roughly 50 keyword guesses
before discovering which upstreams were reachable, and could not distinguish "no tool matches" from
"you have no access to that server". A discovery mode that saves context but hides the surface is a
net loss: the agent concludes the key is nearly empty. Hence the optional query, `list_servers`, the
inventory in `instructions`, and a failed search that names the servers which *are* reachable.

### 6.4 Client configuration

```bash
claude mcp add --scope user --transport http switchboard https://switchboard.example.com/mcp \
  --header "Authorization: Bearer sk-sw-xxxxxxxx"
```

```toml
# ~/.codex/config.toml
[mcp_servers.switchboard]
url = "https://switchboard.example.com/mcp"
bearer_token_env_var = "SWITCHBOARD_KEY"
```

```json
{ "mcpServers": { "switchboard": {
    "type": "http", "url": "https://switchboard.example.com/mcp",
    "headers": { "Authorization": "Bearer sk-sw-xxxxxxxx" } } } }
```

A ready-to-run `INSTALL-<key-name>.md` is downloadable from each key's page: URL, snippets for each
client, and the list of MCPs and tools the key has access to.

### 6.5 The global `report_feedback` tool

The gateway's own tool, **added to every agent key's list** regardless of its rights (it depends on no
upstream). It lets an agent report a problem with the gateway, an MCP or a tool — the gateway has no
other channel to learn what is broken on the agent side.

- **Name**: `report_feedback`, unprefixed. Upstream tools always look like `<slug>__<tool>`, so no
  collision is possible. The name is reserved in code.
- **Always visible**, including in discovery mode. A global switch in Settings can disable it.
- **Inputs** (zod): `category` (`tool_error` · `missing_tool` · `access_needed` · `bad_description` ·
  `slow` · `bug` · `other`, required), `severity` (`low` · `medium` · `high` · `blocking`, default
  `medium`), `title` (≤ 120), `description` (≤ 4 000), and optional `tool`, `attempted_action`,
  `error_message`.
- **Filled by the gateway, not the agent**: `keyId`, `sessionId`, `clientInfo`, timestamps. If `tool`
  is given, the gateway links the last failed call of that session on that tool and derives the
  upstream.
- **Unknown or unauthorised tool names are accepted** (that is exactly the `missing_tool` and
  `access_needed` case), stored as-is, without revealing whether the tool exists.
- **Deduplication**: same key + same tool + same category + normalised title within 24 h →
  `occurrences` is incremented instead of a new row. A `resolved` report returns to `new`.
- **Limits**: 20 reports per hour per key. Text is scrubbed: known secrets are masked, as in
  `call_logs`.
- **Response**: `{ id, status: "recorded" | "merged", message: "…" }`.
- `high` and `blocking` reports can trigger an **Apprise** notification if a URL is configured.

### 6.6 Admin tools (automation over MCP)

A `scope=admin` key is accepted on `/mcp` but gets a small, fixed tool surface instead of upstream
tools. Refusing it there would leave the most common automation — *an agent adds an MCP server for
me* — with no path through the gateway: it would have to speak the REST API, which an MCP client
cannot discover.

- **Surface** (closed set, `lib/gateway/adminTools.ts`): `upstream_list`, `upstream_get`,
  `upstream_create`, `upstream_update`.
- **Isolation**: an admin key never sees an upstream tool. Its effective access is empty by
  construction, so gaining management power never widens access to somebody else's server.
- **No destructive actions**: delete, restart and connection-test are deliberately absent. They are
  one-way or disruptive, and an agent that can silently delete an upstream can take the gateway down;
  they stay on the REST API and in the UI, behind a human.
- **Secrets never leave**: `upstream_get` reduces `env` and `headers` to their key *names*
  (`envKeys`, `headerKeys`). Supplying `env`/`headers` on update replaces the whole map; omitting them
  keeps it.
- **Input errors are tool errors**: a missing `url`/`command` or an unknown `id` returns an
  `isError` result naming the field, not a JSON-RPC fault — an agent can read it and correct itself.
- **Re-checked per call**: the key scope is read from the DB on every call, like any access decision,
  so a key demoted from admin loses the tools mid-session.
- `upstream_create` returns immediately; the connection happens in the background, so the status is
  normally `connecting` and is confirmed with `upstream_get`.

---
## 7. Keys, roles and access control

Everything is denied by default: a key only sees and calls what it has been granted.

### 7.1 API keys

- Created in the UI: unique name, description, roles, exposure mode, optional expiry, and **initial
  rights** (pick roles, or "copy the rights of key …").
- Format: `sk-sw-` + 32 random base62 characters. Stored as SHA-256; **shown once** at creation,
  together with install snippets and the `INSTALL-<name>.md` file.
- Actions: **revoke** (immediate, sessions closed), **rotate the secret** (new value, same rights, the
  old one invalid after a grace period of 0 / 1 h / 24 h), **duplicate** (new key with the same roles
  and grants), edit name/description/expiry/mode.
- Per-key tracking: last use, open sessions (client, version, IP, since), calls over 24 h / 7 d,
  denials over 24 h.
- `scope=admin` keys are for the admin API (automation) and, over MCP, for the admin tools of
  §6.6. They never see an upstream's tools.

### 7.2 Roles

A role is a reusable set of rights (e.g. `dev` = GitHub fully + Jira read-only). A key can have
several roles. Editing a role updates all its keys immediately (`list_changed`).

### 7.3 Effective access

A **grant** links a subject (role or key) to an MCP:

- `toolMode = "all"`: every tool of that MCP, **including tools that appear later**;
- `toolMode = "selected"`: only the checked tools; a new tool of that MCP stays **blocked** until it is
  checked;
- `prompts`, `resources`: yes/no for the whole MCP (v1).

A key can additionally have **removals** (`key_denies`): one tool, or a whole MCP, removed from that key
even if a role grants it.

The algorithm (`computeEffectiveAccess`, a pure function, exhaustively unit-tested):

```
for each MCP U:
  sources = grants on U from the key's roles ∪ the key's own grant
  if no source          → no access to U
  tools   = if any source has toolMode="all" → all current tools of U
            else → union of the tools checked in the sources
  prompts/resources = logical OR of the sources
  remove the tools in key_denies(key, U)   ; a deny on the whole U → no access to U
  remove tools disabled globally (item_overrides.enabled = false)
  remove the tools of an MCP that is not "ready"
```

Rules:

- **A removal always beats an addition.**
- **A global disable beats everything.**
- The result is cached per key and invalidated on any change to rights, roles, overrides or the
  catalog.
- The check applies **at listing AND at every call** (§6.2), and to `search_tools`/`describe_tool`/
  `call_tool` in discovery mode, to prompts and to resource reads.

The motivating example — one upstream `toto` with tools A, B, C, D:

| Key | Rights | Effective access |
|---|---|---|
| `sk-aaa` | own grant on `toto`, `selected` = A, B, C | A, B, C (a later D stays blocked until checked) |
| `sk-bbb` | own grant on `toto`, `selected` = B | B |
| `sk-ccc` | role `dev` (`toto` in `all`) + removal of C | A, B, D (and every future tool) |

### 7.4 Adding an MCP and new tools

- The upstream creation form has an **Access** section: roles and keys to check ("check all"), each
  with mode `all tools` (default) or `selection` (the tool list becomes checkable after the connection
  test). Nothing checked = nobody has access (the MCP is still connected and testable).
- When an existing MCP publishes a **new tool**, it is recorded in `tool_discoveries`; keys/roles in
  `all` mode get it immediately, `selected` ones do not. The dashboard shows a "New tools detected"
  card with a quick "grant to…" action and an "ignore" action.
- When a tool **disappears** from the upstream, the `grant_tools` that cite it are kept but flagged
  "orphaned" (it may return after an upgrade), with a "clean up" button.

### 7.5 Audit

Every change to rights, roles or keys writes an `event` (before/after as JSON). A key's page has a
"Rights history" tab.

---

## 8. UI

| Page | Contents |
|---|---|
| **Dashboard** | MCPs by status, active keys and open sessions, calls/24 h, denials/24 h, recent errors, untreated feedback by severity, "OAuth reconnect required" and "new tools detected" banners with quick actions. |
| **Servers** | List: slug, name, transport, status, tool count, number of keys with access, p50 latency, last error. "Add" button. |
| **Add / edit a server** | Form per transport; "Test the connection" (initialize + listing without saving); secrets in masked fields (never re-displayed, only replaceable); **Access** section (§7.4). |
| **Server detail** | Server info; Tools / Prompts / Resources tabs (global enable, alias, description); **Access** tab (who has access, editable); test console; stderr (stdio); log; OAuth "Connect / Reconnect"; restart. |
| **API keys** | Table: name, prefix, roles, number of MCPs / tools accessible, last use, open sessions, status. Creation wizard in 3 steps (identity → rights → summary with the one-time secret, snippets and `INSTALL-<name>.md`). |
| **Key detail** | **Rights** tab: one accordion per MCP, with a `No access / All tools (including future) / Selection` selector; in selection mode, the tool list with search, "check all", and an origin badge per tool (`role dev`, `own`, `removed`); a tool granted by a role can be **removed** in one click for that key; prompts / resources yes/no. **Effective preview** tab: the exact tool list the agent sees + token estimate. Sessions, Log, Rights history tabs. Actions: revoke, rotate, duplicate, test a tool **as that key**. |
| **Roles** | List (number of keys, number of MCPs); role detail with the same rights editor + keys using the role. |
| **Access matrix** | Rows = keys (and roles), columns = MCPs; cell `●` all tools, `◐ 3/12` selection, `○` none, `⊘` removed; clicking a cell opens a side panel with the tool checkboxes. Filters + CSV export. |
| **Import** | Paste a JSON (`.mcp.json`, `~/.claude.json`, `claude_desktop_config.json`) or Codex TOML → preview of detected servers, secrets spotted in `env`/`headers` → selective import with the Access section; **export** of the config a given key sees. |
| **Log** | Filterable calls (key, server, tool, success / error / **denied**), detail of one call. |
| **Feedback** | List of `report_feedback`: badge with the `new` count in the navigation; filters by status / category / severity / key / MCP / tool. Detail: full text, context (client, session), linked call with arguments and error, other recent calls of the session, status change, admin note, and **quick actions** by category (`access_needed` → "grant this tool to this key"; `tool_error` / `slow` → open the server page; `bad_description` → edit the tool description). Multi-select for bulk status changes. |
| **Settings** | Public URL, retention, master key state, admin password, Apprise URL, feedback switch, discovery threshold. |

Refresh via SSE `/api/ui/stream`. UI auth: admin password + signed cookie.

---

## 9. Admin API `/api/v1` (UI session or `scope=admin` key)

- `upstreams`: CRUD, `POST /upstreams/test`, `POST /upstreams/{id}/restart`,
  `POST /upstreams/{id}/oauth/start`, `GET /upstreams/{id}/stderr`, `GET /upstreams/{id}/items`,
  `PUT /upstreams/{id}/items/{kind}/{name}` (global override), `GET /upstreams/{id}/access`.
- `keys`: CRUD, `POST /keys/{id}/revoke`, `POST /keys/{id}/rotate {graceSeconds}`,
  `POST /keys/{id}/duplicate {name}`, `GET /keys/{id}/effective`, `GET /keys/{id}/install.md`,
  `PUT /keys/{id}/denies`.
- `roles`: CRUD, `PUT /roles/{id}/keys`.
- `grants`: `PUT /grants` `{subjectType, subjectId, upstreamId, toolMode, tools[], prompts, resources}`
  (upsert), `DELETE /grants/{id}`; `GET /access-matrix`.
- `feedback`: `GET /feedback?…`, `GET /feedback/{id}`, `PATCH /feedback/{id}` `{status, adminNote}`,
  `POST /feedback/bulk`.
- `discoveries`: `GET /discoveries`, `POST /discoveries/grant`, `POST /discoveries/ack`.
- `POST /import`, `GET /export?key=`, `GET /logs`, `GET /status`, `GET/PATCH /settings`.

An agent holding an admin key can therefore add an MCP or manage rights by API.

---

## 10. Security

- Upstream secrets encrypted at rest; never returned by the API or UI; masked in `call_logs`,
  `events`, stderr and feedback text (known values replaced by `••••`).
- Client keys: SHA-256, shown once, constant-time comparison, expiry and revocation checked on every
  request (cache ≤ 5 s).
- Least privilege: a new key has **no** access until granted; an unauthorised tool is invisible and its
  call returns the same error as a nonexistent tool.
- OAuth `state` signed and bound to the upstream, 10-minute expiry; PKCE mandatory.
- stdio processes inherit **only** their declared `env` plus `PATH` and `HOME`, never the gateway's
  environment (otherwise `SWITCHBOARD_MASTER_KEY` would leak).
- stdio MCPs execute third-party code inside the container: the UI documents this risk; per-upstream
  container isolation is out of scope for v1.
- Rate limits: 50 concurrent calls per key, 300/minute; 20 feedback reports per hour per key.

---

## 11. Acceptance criteria

- [ ] Two agents configured **only** with Switchboard, each with its own key, see exactly the tools
      their rights give them.
- [ ] Motivating scenario: `sk-aaa` has A, B, C of `toto`; `sk-bbb` only B → `sk-bbb` lists only
      `toto__B`, and a direct call to `toto__A` is refused like an unknown tool (and logged `denied`).
- [ ] `toto` publishes a tool D → immediately visible to keys in "all" mode, absent for "selection"
      mode, "new tools" card on the dashboard.
- [ ] Editing a role updates all its keys in < 5 s (open sessions included).
- [ ] Revoking a key closes its open sessions immediately; a rotation with a grace period keeps the old
      value valid for exactly that period.
- [ ] Adding an MCP in the UI → within 5 s, an already-open agent session sees its tools (if the client
      honours `list_changed`; otherwise at the next session, with no config change).
- [ ] Disabling a tool globally makes it disappear for every key.
- [ ] `report_feedback` is listed for every agent key, even with no rights and in discovery mode; a
      report sent by an agent appears in the Feedback page with the key, the session and the linked
      failed call; sending it twice increments `occurrences`; the "grant this tool" action on an
      `access_needed` report grants the access and the agent sees it in < 5 s.
- [ ] A key in discovery mode can enumerate its whole surface in one call (`search_tools({})` or
      `list_servers({})`), and a failed search distinguishes "no match" from "no access".
- [ ] An OAuth MCP connects through the UI, survives token refresh and a gateway restart.
- [ ] An `npx` stdio MCP in `lazy` mode starts on first call (< 10 s with a warm npm cache) and stops
      after inactivity.
- [ ] Importing the current `~/.claude.json` recreates every server, with secrets encrypted.
- [ ] A broken upstream does not prevent the others from working; its state is visible.
- [ ] No upstream secret in any response, log, event, or in another upstream's stdio environment.
- [ ] All public tool names are ≤ 46 characters and match `[a-zA-Z0-9_-]`.

---

## 12. Out of scope (v1)

Relaying `sampling/createMessage`, `elicitation/create` and `roots/list` from an upstream to the
client (announced to upstreams as unsupported); OAuth on the client side (a custom claude.ai connector,
public exposure through a funnel); multi-user; isolating each stdio MCP in its own container; high
availability; caching tool results.

## 13. Risks

| Risk | Mitigation |
|---|---|
| A client does not honour `list_changed` | New tools arrive at the next session, with no config change: the core promise holds anyway. |
| Too many tools → context saturation, degraded tool choice | Per-key rights, fine-grained disabling, discovery mode (which stays enumerable), token estimate per key. |
| Awkward upstream OAuth (no DCR, refused redirect URIs) | CIMD → DCR → manual entry; real HTTPS certificate with a real certificate authority; tested early. |
| The gateway goes down → every agent loses every MCP | Simple process, `restart: unless-stopped`, healthcheck, state rebuilt at startup, `/healthz` for external monitoring. |
| Losing the master key means losing all secrets | UI warning + documented backup of the data directory. |
| Third-party code via stdio inside the container | Isolated env, non-root user, container isolation in v2. |

# Architecture notes (as built)

Spec: [SPEC.md](./SPEC.md). This file records the decisions that matter when changing the code.

## One process, two module graphs — the most important detail

```
node dist/server.js            ← esbuild bundle: /mcp, /healthz, upstream manager, SSE push
  └─ next({dev}).getRequestHandler()
       └─ .next/server/**       ← Next's own bundle: app/** pages + app/api/v1/** routes
```

Both graphs `import` the same files under `lib/`, but each gets **its own module instances**.
Anything shared across the boundary must live on `globalThis`:

| Shared state | Where | Accessor |
|---|---|---|
| SQLite handle | `lib/db/index.ts` | `getDb()` |
| Upstream manager | `lib/upstreams/types.ts` | `setUpstreamManager()`, `getUpstreamManager()`, `hasUpstreamManager()` |
| Catalog snapshot | `lib/catalog/catalog.ts` | `getCatalog()`, `getCatalogSnapshot()` |
| Secret redactor | `lib/redact.ts` | `getRedactor()` |
| UI event bus (SSE) | `lib/events.ts` | `getUiBus()`, `emitUiEvent()` |
| Settings cache | `lib/settings.ts` | `getSettings()` |

All of them go through `lib/runtime/global.ts` (`globalSingleton`, `peekGlobalSingleton`, …).

**Symptom if you forget this:** an upstream created through `POST /api/v1/upstreams` is written to
SQLite but never connected, so it stays `connecting` forever while `/healthz` reports zero
upstreams. This was a real bug during the build; do not reintroduce a module-level singleton for
anything crossing the bundle boundary.

Tests: `tests/helpers/reset.ts` wipes the runtime bag between test cases. A suite that builds state
once in `beforeAll` (e.g. the live HTTP one) calls `keepRuntimeStateForFile()` at module scope.

## Request paths

### MCP client → upstream tool

1. `POST /mcp` with `Authorization: Bearer sk-sw-…`
2. `authenticateSecret()` (sha256 + constant time, ≤5 s cache) → `KeyRecord`; missing/unknown/
   revoked/expired → 401, `scope=admin` → 403.
3. A `StreamableHTTPServerTransport` (stateful, `Mcp-Session-Id`, `keepAliveMs: 25 000`) is looked
   up or created; an unknown session id yields 404 so the client re-initializes.
4. The per-session SDK `Server` (`lib/gateway/server.ts`) handles the request. Its handlers never
   trust a cached view: `tools/call` re-reads `effectiveAccessForKey()` from SQLite.
5. `lib/gateway/router.ts` resolves the public name through the catalog, re-checks access, calls
   `getUpstreamManager().callTool()` with timeout/cancellation/progress, logs the call.
6. An unauthorized call returns the **same** `McpError(-32602)` as an unknown tool and writes a
   `call_logs` row with `denied = 1`.

### Admin UI

Server components call `lib/` functions directly (no auth hop, no HTTP). Client components POST to
`/api/v1/**` with the session cookie. `requireAdmin()` accepts the cookie or an admin-scope key.

### Catalog updates

Upstream listing change → `invalidateCatalog()` → debounced (500 ms) rebuild → a per-key diff in
`lib/gateway/push.ts` → `notifications/{tools,prompts,resources}/list_changed` **only to the
sessions whose visible set actually changed** (spec §5).

## Discovery mode must stay discoverable

A key that sees more tools than `discoveryThreshold` (default 60) — or that is explicitly in
`exposureMode: "discovery"` — gets meta-tools instead of the tool list. That trade saves context but
creates a discoverability cliff: an agent that cannot enumerate its surface will guess keywords,
fail, and conclude the key is empty.

Learned the hard way from a real agent (80 tools across two upstreams, ~50 wasted `search_tools`
calls). The rules now:

- `search_tools` has an **optional** `query`. Absent, empty, `"*"`, `"all"` → lists every authorised
  tool grouped by server (default limit 200, max 500). Keyword search stays available.
- `list_servers` returns the accessible servers, their tool counts and descriptions, plus how many
  servers exist on the gateway but are **not** granted (names withheld — no existence leak).
- The server `instructions` built at `initialize` carry the inventory, the total tool count, a few
  real tool names as seeds, and the "list everything" call. No extra round trip to orient.
- A failed search distinguishes *"no tool matches this keyword"* from *"that server is not
  accessible with this key"* and names the reachable servers.
- `describe_tool` works on the gateway's own meta-tools (they are always listed, so they are not a
  secret), while an unauthorised upstream tool still answers identically to an unknown one.

`tests/discoverability.test.ts` pins one case per point.

## MCP Events relay (SEP-3415)

Switchboard relays the Events extension rather than implementing it: `events/list`,
`events/subscribe`, `events/unsubscribe` and `events/poll` are forwarded to the upstreams that
speak the extension and their answers are merged.

### Why a raw HTTP path instead of the SDK client

Revision **2026-07-28** is a *per-request envelope* protocol: there is no `initialize` handshake
(an `initialize` sent with that header is rejected as a legacy handshake), and every request must
carry:

- `MCP-Protocol-Version: 2026-07-28`
- `Mcp-Method: <method>` (and `Mcp-Name: <params.name>` when there is one)
- `params._meta` with `io.modelcontextprotocol/protocolVersion` and
  `io.modelcontextprotocol/clientCapabilities.extensions`

The SDK `Client` (both `1.32.2` and the published `2.4.0`) insists on the legacy handshake: its
default negotiation mode is `"legacy"`, and against Harbor it reports `2025-11-25` with
`{tools}` only. Pinning `versionNegotiation` had no effect in testing. The published `2.4.0`
packages do not export `ext/events` at all (`ext/skills` only).

Harbor solved this by vendoring three packages built from the extension's branch. This project
deliberately did **not** copy that: vendoring a pre-release fork of three packages is a large,
invisible liability, while the envelope is small, documented in `lib/gateway/events-protocol.ts`,
and a raw `fetch` is free to set headers the SDK does not model.

So: legacy traffic keeps using the SDK `Client` unchanged; `events/*` goes through
`Manager.rawRequest()` in `lib/upstreams/manager.ts`, which reuses the same timeout, abort and
`handleConnectionLoss` semantics as `callTool`.

### Access control

Identical to `tools/call`: the effective access is re-read from the database, and an upstream the
key may not use yields `notFoundError` — the same answer as an unknown tool. The relay never
reveals that a server exists but is not granted. `capabilities.extensions` is derived from the
upstreams the key can actually reach, so a key with no events-capable upstream gets no block.

### Discovery mode

Events are extension methods, not tools, so they never appear in `tools/list` or in
`search_tools` — `search_tools` must not pretend otherwise. A client in discovery mode learns
about them from two places: the `capabilities.extensions` block at `initialize`, and the server
`instructions`, which name the events-capable upstreams and list the four methods when any exist.
To discover *which* event types exist, the client calls `events/list`; that is the extension's own
mechanism and no gateway-side meta-tool is needed.

### Webhook specifics learned against Harbor

- `delivery` is an **object**: `{ mode: "webhook", url, secret }` (or `{ mode: "poll" }`), not the
  string `"webhook"`.
- `secret` must be `whsec_` followed by base64 of 24–64 bytes.
- A webhook receiver on a private address must be listed in the upstream's own allowlist
  (Harbor: `HARBOR_EVENTS_WEBHOOK_ORIGINS`).
- Delivered events carry `webhook-id`, `webhook-timestamp` and `webhook-signature`
  (`v1,<base64>`).
- Harbor de-duplicates subscriptions per (key, type, url): re-subscribing reuses the existing one,
  so the verification POST is only sent once.

## Access model

`computeEffectiveAccess()` in `lib/auth/access.ts` is a **pure function** (no I/O) and is the only
place the rules live. Precedence, exactly as spec §7.3:

1. Key must be active (not revoked, not expired).
2. A grant comes from a role the key has, or from the key itself. No grant → no access.
3. `toolMode = "all"` → every current tool (and every future one). `"selected"` → only the listed
   ones; later tools stay locked until checked.
4. `prompts` / `resources` are OR-ed across sources.
5. A `key_denies` row removes one tool, or the whole upstream.
6. A globally disabled tool (`item_overrides.enabled = false`) is removed from everyone.
7. An upstream that is not `ready` contributes no tools (the grants are kept for the UI).

Tests in `tests/access.test.ts` cover each rule, including the spec's three worked examples.

## Naming

`<slug>__<tool>`, sanitized to `[a-zA-Z0-9_-]`, soft limit 46 chars (clients add their own prefix),
hard limit 64. Over the limit the name is truncated and suffixed with a 4-char hash; collisions get
a further suffix. Resource URIs are forwarded verbatim unless two upstreams expose the same URI, in
which case they are rewritten to `switchboard://<slug>/<urlencoded-uri>`.
The name `report_feedback` is reserved and can never be produced by an upstream, because every
upstream tool is prefixed.

## Failure isolation

An upstream that is down only affects its own tools: the manager marks it `degraded` → `error`
(backoff 1 s → 60 s, 5 failures, then a 5-minute retry), the catalog drops its items, and a
`list_changed` is pushed. Calls to it return an actionable French message
("le serveur « jira » demande une reconnexion OAuth dans Switchboard…") with `isError: true`.

## Data

SQLite in `SWITCHBOARD_DATA_DIR` (`/data` in Docker), WAL mode, migrations applied at boot from
`lib/db/migrate.ts` (hand-rolled, idempotent). Secrets are AES-256-GCM blobs in
`env_enc`/`headers_enc`/`oauth_enc`; the master key is `SWITCHBOARD_MASTER_KEY` or `master.key`.
Call logs are pruned to 30 days or 100 000 rows, whichever hits first.
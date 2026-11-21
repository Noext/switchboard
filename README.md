# Switchboard

**One MCP endpoint for every agent.** Switchboard aggregates your upstream MCP servers behind a
single URL and enforces per-key, per-tool access control on every call.

Every MCP client keeps its own server list. Claude Code has one, Codex has another, each sandbox
and CI agent has its own — so adding one upstream means editing every config, and giving a new
agent a narrow slice of a server means either over-sharing or inventing a bespoke setup.
Switchboard moves that config server-side: connect an upstream once, and every agent points at
`https://switchboard.example.com/mcp` with its own key. What that key may see and call is decided
per request, from the database, not from a file you can forget to update.

```
Claude Code ─┐
Codex       ─┼── HTTPS /mcp (Bearer sk-sw-…) ──► Switchboard ──► upstream MCP servers
CI agent    ─┘                                  (one process)      http / sse / stdio
```

## Features

| Capability | What it does |
|---|---|
| **Aggregation** | Tools, prompts and resources from every upstream are exposed under one endpoint and namespaced `<slug>__<tool>`. |
| **Transports** | Streamable HTTP (SSE fallback), legacy SSE, and stdio (`npx`, `uvx`, `docker run`). |
| **Upstream auth** | None, custom headers, bearer token, or full OAuth 2.1 (PKCE, RFC 9728/8414 discovery, dynamic client registration, encrypted refresh tokens). |
| **Access control** | API keys, reusable roles, per-upstream grants in `all` or `selected` mode, per-key removals. Deny by default: what a key is not granted is neither listed nor callable. |
| **Discovery mode** | Per key: `list_servers` / `search_tools` / `describe_tool` / `call_tool` instead of hundreds of tool definitions in context — and it stays enumerable, so an agent never has to guess its surface. |
| **Live updates** | Adding or removing an upstream pushes `notifications/tools/list_changed` to open sessions whose view actually changed. No client restart, no config edit. |
| **Call log** | Every call is recorded with key, session, upstream, duration and outcome; denied attempts are logged as denials. Previews are truncated and redacted. |
| **Feedback loop** | Every agent key gets `report_feedback`, so an agent can report a broken tool or a missing grant without leaving its run. Admins triage it in the UI and can grant the missing tool in one click. |
| **Importers** | Paste an existing Claude Code, Claude Desktop or Codex config and Switchboard imports the servers it contains. Export goes the other way: ready-to-paste snippets per key. |

An admin UI (dashboard, servers, keys, roles, access matrix, logs, feedback, import, settings)
ships with the gateway.

## Quick start

Requires Docker with Compose v2 (or Node 20+ to run from source). Five commands:

```bash
git clone https://github.com/Noext/switchboard.git && cd switchboard
cp .env.example .env     # then edit the three required values (table below)
sudo mkdir -p /srv/switchboard && sudo chown 1001:1001 /srv/switchboard
docker compose up -d --build
curl -fsS http://127.0.0.1:3020/healthz
```

Then open `http://127.0.0.1:3020`, log in with `SWITCHBOARD_ADMIN_PASSWORD`, add an upstream
(**Serveurs → Ajouter**) and create a key (**Clés API**).

| Variable | Purpose |
|---|---|
| `SWITCHBOARD_PUBLIC_URL` | Public URL agents will use, e.g. `https://switchboard.example.com`. Used for OAuth callbacks and install snippets. |
| `SWITCHBOARD_ADMIN_PASSWORD` | Admin UI password. |
| `SWITCHBOARD_SECRET` | Cookie signing secret, 32+ random characters. |
| `SWITCHBOARD_MASTER_KEY` | Optional: base64 of 32 random bytes. If unset, `data/master.key` is generated on first run. |

Prefer to run it from source? `npm install`, fill `.env`, `npm run dev` — see
[CONTRIBUTING.md](CONTRIBUTING.md).

**Dev vs prod.** That compose file is the same for both; only what sits in front changes. For a
local trial, plain HTTP on `127.0.0.1` is enough. For anything exposed to a network, put a
TLS-terminating reverse proxy (Traefik, nginx, Caddy) in front and set
`SWITCHBOARD_PUBLIC_URL` to the `https://` address: several upstream authorization servers reject
`http://` redirect URIs, and MCP clients increasingly require TLS. On a LAN, `http://<host>:3020`
works, but browsers and some clients will treat the admin session as insecure — see
[docs/deploy.md](docs/deploy.md) for the proxy configuration, including the SSE settings that
`GET /mcp` needs.

## Docker Hub rate limits

`docker compose build` pulls `node:26-bookworm-slim`, and Docker Hub throttles **anonymous** pulls
hard (`429 Too Many Requests`). On a shared IP you *will* hit this — a rebuild then fails in the
middle of a deploy, before any of your code is even compiled.

Pick one, once:

**Recommended — log in (raises the limit substantially):**

```bash
docker login                      # a free Docker Hub account is enough
```

**Or pull the base image from the AWS mirror and tag it locally.** A locally tagged image is never
re-pulled, so the build works offline from Docker Hub:

```bash
docker pull public.ecr.aws/docker/library/node:26-bookworm-slim
docker tag public.ecr.aws/docker/library/node:26-bookworm-slim node:26-bookworm-slim
docker compose build
```

Notes:

- `docker.mirror.gcr.io` is **not** a usable fallback: its TLS certificate does not match that
  hostname.
- `public.ecr.aws/docker/library/*` mirrors the official images and is not rate-limited the same way.
- If you deploy to a remote host, do this on that host (or in your registry cache), not only
  locally: the build runs where `docker compose build` runs.

## Configure an agent

Create a key in the UI first. The secret (`sk-sw-…`) is shown **once** at creation; copy it then.
Every key also has a downloadable `INSTALL-<key>.md` with its exact tool list.

**Claude Code**

```bash
claude mcp add --scope user --transport http switchboard https://switchboard.example.com/mcp \
  --header "Authorization: Bearer sk-sw-xxxxxxxx"
```

**Codex** — `~/.codex/config.toml`, token in an environment variable:

```toml
[mcp_servers.switchboard]
url = "https://switchboard.example.com/mcp"
bearer_token_env_var = "SWITCHBOARD_KEY"
```

```bash
export SWITCHBOARD_KEY="sk-sw-xxxxxxxx"
```

**Generic JSON** (`.mcp.json`, and most clients that read an `mcpServers` map):

```json
{
  "mcpServers": {
    "switchboard": {
      "type": "http",
      "url": "https://switchboard.example.com/mcp",
      "headers": { "Authorization": "Bearer sk-sw-xxxxxxxx" }
    }
  }
}
```

Tool names arrive prefixed by upstream slug (`github__create_issue`), so a client configured
against Switchboard never needs a second entry or a second key.

## How access control works

A key gets access only through a grant, and a grant always targets one upstream. Grants come from
a role attached to the key or from the key itself; a key-level deny removes a single tool or the
whole upstream; a globally disabled tool is removed for everyone.

| Grant mode | What the key gets | Tools added later |
|---|---|---|
| `all` | Every tool the upstream currently exposes (plus prompts/resources if enabled). | Included automatically. |
| `selected` | Only the tools checked in the grant. | Stay locked until explicitly checked. |

**Deny by default.** A new key sees nothing until something is granted — `tools/list` is empty,
not partial. Access is recomputed from the database on every call, not only when listing. An
unauthorised call returns the same JSON-RPC error as a tool that does not exist, and is recorded
as a denial: existence is never disclosed. An upstream that is not `ready` contributes no tools.

A key that would see more than `discoveryThreshold` tools (default 60) switches to discovery
mode automatically, trading tool definitions for meta-tools. That mode is explicitly enumerable:
`search_tools` with no query lists everything the key may call, `list_servers` reports the
inventory, and the `initialize` instructions already name the reachable servers.

## Docs

| Document | Contents |
|---|---|
| [docs/architecture.md](docs/architecture.md) | How the process, the two module graphs, the catalog and the request paths fit together. |
| [docs/deploy.md](docs/deploy.md) | Compose, environment, reverse proxy, health checks, backups, updates. |
| [docs/security.md](docs/security.md) | Threat model, encryption, key handling, least privilege, known gaps. |
| [docs/e2e.md](docs/e2e.md) | Manual end-to-end test with two real clients and two keys. |
| [docs/SPEC.md](docs/SPEC.md) | The original functional specification (French). |

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for local setup,
the checks that must pass, and the conventions. Report vulnerabilities privately, per
[SECURITY.md](SECURITY.md).

## License

MIT — see [LICENSE](LICENSE).
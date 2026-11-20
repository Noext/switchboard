# Deployment

Switchboard is a single Node process (Next.js + the MCP gateway) behind SQLite. It ships as a
Docker image and needs a TLS-terminating reverse proxy in front of it — a real certificate matters
because OAuth callbacks and several upstream authorization servers reject `http://` redirect URIs
outside `localhost`.

## Quick start (Docker Compose)

```yaml
# docker-compose.yml
services:
  switchboard:
    build: .
    container_name: switchboard
    restart: unless-stopped
    env_file: .env
    ports:
      - "${SWITCHBOARD_PORT:-3020}:3000"
    volumes:
      - ./data:/data          # SQLite DB + master key
    environment:
      - SWITCHBOARD_DATA_DIR=/data
      - SWITCHBOARD_PORT=3000
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }
```

```bash
cp .env.example .env
# edit .env: set SWITCHBOARD_PUBLIC_URL, SWITCHBOARD_ADMIN_PASSWORD, SWITCHBOARD_SECRET
docker compose up -d --build
curl -fsS http://127.0.0.1:3020/healthz
```

The container listens on port 3000; map it wherever you like. It runs as **uid/gid 1001**, so a
bind-mounted data directory must be owned by that user:

```bash
sudo mkdir -p ./data && sudo chown -R 1001:1001 ./data
```

> Skipping that `chown` is the most common first-run failure: SQLite cannot create the database
> file, and the container crash-loops with `SqliteError: unable to open database file`.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `SWITCHBOARD_PUBLIC_URL` | `http://localhost:3000` | Public URL, used for OAuth redirects and install snippets |
| `SWITCHBOARD_ADMIN_PASSWORD` | `changeme` | Admin UI password |
| `SWITCHBOARD_SECRET` | dev fallback | Cookie signing secret (≥ 32 chars) |
| `SWITCHBOARD_MASTER_KEY` | generated | base64 of 32 bytes; if unset, `data/master.key` is generated |
| `SWITCHBOARD_DATA_DIR` | `./data` | SQLite database + master key location |
| `SWITCHBOARD_PORT` | `3000` | Listen port |
| `SWITCHBOARD_LOG_LEVEL` | `info` | pino log level |

Setting `SWITCHBOARD_MASTER_KEY` explicitly (rather than letting the app write
`/data/master.key`) is usually better on a server: the key then survives losing the data volume,
as long as your secret store does.

## Reverse proxy

Any TLS-terminating proxy works. The only requirements are:

- forward `Host` and `X-Forwarded-Proto` (the session cookie's `Secure` flag follows the real
  scheme — see `lib/auth/session.ts`);
- do **not** buffer or time out server-sent events on `GET /mcp`. Streamable HTTP keeps a long-lived
  SSE stream open for server→client notifications; the gateway sends keep-alive frames every 25 s.

Traefik example:

```yaml
http:
  routers:
    switchboard:
      rule: Host(`switchboard.example.com`)
      service: switchboard
      tls: { certResolver: letsencrypt }
  services:
    switchboard:
      loadBalancer:
        servers:
          - url: "http://127.0.0.1:3020"
```

nginx example:

```nginx
location / {
    proxy_pass http://127.0.0.1:3020;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_buffering off;          # required for the SSE stream on GET /mcp
    proxy_read_timeout 3600s;
}
```

> Traefik gotcha, if you use a file provider: services must live inside the `services:` block. A
> service appended after a later top-level key (for example `serversTransports:`) is silently
> parsed as part of that block, and Traefik logs `field not found, node: loadBalancer`.

## Health check

`GET /healthz` is unauthenticated and returns JSON — useful for a container healthcheck, Uptime
Kuma, or any other prober:

```json
{"status":"ok","version":"0.1.0","uptimeSeconds":42,
 "upstreams":{"github":{"slug":"github","status":"ready","tools":23}},
 "catalog":{"version":7,"tools":23}}
```

It reports per-upstream status, so one dead upstream is visible without logging in.

## Backups

Back up two things:

1. **The data directory** (or at least `switchboard.db`): upstreams, keys, grants, logs, feedback.
2. **The master key** (`data/master.key`, or `SWITCHBOARD_MASTER_KEY`).

Losing the master key makes every stored upstream secret unrecoverable by design — there is no
recovery path, that is the point of the encryption.

```bash
# consistent hot copy of a live SQLite database
sqlite3 /path/to/data/switchboard.db ".backup /tmp/switchboard-backup.db"
```

Restore: stop the container, put `switchboard.db` and the master key back, start it again.
Migrations run automatically at boot.

## Updates

```bash
git pull && docker compose up -d --build
```

`scripts/deploy.sh` wraps this: it pulls and rebuilds on a remote host over SSH, then polls
`/healthz` until the new version is healthy. Every value is environment-overridable.

Migrations run at startup. Clients holding an old `Mcp-Session-Id` receive a 404 and re-initialize,
which is the standard MCP recovery path — open agent sessions survive a deploy without config
changes.

## Adding your first upstream

Once you are logged in, **Serveurs → Ajouter**, or via the API:

```bash
curl -X POST https://switchboard.example.com/api/v1/upstreams \
  -H "Cookie: sb_admin=<session>" -H "content-type: application/json" \
  -d '{"slug":"github","name":"GitHub","transport":"http","url":"https://api.githubcopilot.com/mcp/",
       "authType":"bearer","bearerToken":"ghp_…","enabled":true}'
```

The upstream connects immediately and its tools appear in the catalog. Then grant it to a key
(**Clés → Droits**): a new key sees nothing until you grant something.

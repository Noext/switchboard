# Security policy

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Report it privately through GitHub Security Advisories:
<https://github.com/Noext/switchboard/security/advisories/new>

Please include: the affected version (from `/healthz` or the dashboard), the deployment shape
(Docker Compose, reverse proxy, LAN or public), reproduction steps, and the impact you expect.
Redact secrets — never paste a live key, upstream token or master key.

Expect an acknowledgement within a few days and an assessment with a fix plan or a reasoned
rejection. Please give us a reasonable window to ship a fix before publishing. Only test against an
instance you own or have explicit permission to test.

## Scope

In scope:

- Authentication and authorisation at `/mcp` and under `/api/v1`
- Client key handling: generation, storage, rotation, revocation, grace windows
- Encryption at rest of upstream secrets, and any path that returns or logs a secret
- Access-control bypasses: seeing or calling a tool a key was not granted
- stdio environment isolation
- The upstream OAuth flow (state binding, PKCE, token storage)
- Admin UI session handling

Out of scope:

- Vulnerabilities in upstream MCP servers, in MCP clients, or in third-party packages (report
  those upstream; tell us if Switchboard's usage makes it worse)
- Misconfiguration: exposed admin UI without TLS, default password left in place, published
  `data/` directory
- stdio MCPs executing third-party code — that is the documented design; report it only if the
  isolation described below can be escaped
- Findings that already require control of the host, the data directory or the master key

## Security model

- **Secrets at rest** are encrypted with AES-256-GCM before they reach SQLite (random 96-bit IV per
  value). The master key is 32 bytes from `SWITCHBOARD_MASTER_KEY` or `data/master.key` (mode
  0600). Losing it makes stored upstream secrets unrecoverable by design.
- **Client keys** are `sk-sw-` + 32 base62 characters, stored as SHA-256 hashes and compared in
  constant time. A revocation takes effect within seconds and closes live sessions.
- **No secret is ever returned** by the API or the UI: read models expose only booleans and key
  *names*. A plaintext secret is shown exactly once, on creation, rotation or duplication.
- **Deny by default, enforced per call.** Access is recomputed from the database on every
  `tools/call`; an unauthorised call is indistinguishable from an unknown tool and is logged as a
  denial. Global tool deactivation beats every grant; a per-key deny beats every grant.
- **stdio children get only their declared environment plus `PATH` and `HOME`.** Everything else,
  including the gateway's own secrets, is blanked.
- **Outputs are redacted**: log lines, call-log previews, stderr views, UI events and feedback
  records pass through a redactor that knows the decrypted upstream values.
- **Rate limits**: 50 concurrent calls per key, 300 calls/minute per key, 20 feedback submissions
  per key per hour.

## Current limitations

- **Single admin password.** One shared password for the admin UI; no user accounts, no per-user
  roles, no audit separation between operators. Keep the UI behind TLS and a trusted network.
- **No client-side OAuth.** Agent clients authenticate with bearer keys only. A client that insists
  on dynamic client registration against the gateway (for example a hosted connector) is not
  supported in this version.
- **stdio MCPs run third-party code in the container.** They run as the non-root container user and
  with a stripped environment, but there is no per-upstream container isolation. Treat any stdio
  upstream you add as code you trust, and prefer HTTP upstreams otherwise.

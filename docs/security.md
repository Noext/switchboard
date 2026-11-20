# Security model

## Threat model

Switchboard concentrates every MCP credential and every agent connection in one process. The
assets are: upstream secrets (API tokens, bearer tokens, OAuth refresh tokens), client API keys,
and the ability to invoke upstream tools.

## Secrets at rest

- Everything secret is encrypted with **AES-256-GCM** before hitting SQLite (`lib/crypto.ts`).
  Format: `version | iv | tag | ciphertext`, random 96-bit IV per value.
- The master key is 32 bytes from `SWITCHBOARD_MASTER_KEY` (base64) or generated into
  `data/master.key` with mode 0600 on first run.
- Encrypted columns: `upstreams.env_enc`, `headers_enc`, `oauth_enc`.
- Secrets are **never** returned by the API or the UI. Upstream read models expose only booleans
  and key *names* (`hasEnv`, `envKeys`, `hasHeaders`, `headerKeys`, `hasOAuth`).
- A plaintext secret is shown exactly once: on key creation, rotation or duplication.

## Secrets in transit and in output

- Every string that leaves toward a log, event, call-log preview, stderr view or feedback record
  passes through the redactor (`lib/redact.ts`). Values are registered when an upstream config is
  decrypted for use.
- Call-log previews are truncated to 2 KB before redaction.
- OAuth `state` is signed and bound to the upstream, with a 10-minute TTL; PKCE (S256) is mandatory.

## Client key handling

- Format `sk-sw-` + 32 base62 characters.
- Stored as SHA-256; comparison is constant time.
- Auth cache TTL ≤ 5 s, so a revocation takes effect almost immediately; revocation additionally
  notifies the gateway synchronously (`onKeyLifecycle`) so live sessions close at once.
- Rotation supports a 0 / 1 h / 24 h grace window, after which the previous hash stops matching.
- Admin-scope keys can use `/api/v1` but are rejected with 403 on `/mcp`.

## Least privilege

- Deny by default: a new key sees nothing until granted.
- An unauthorized tool is **indistinguishable** from a nonexistent one — same JSON-RPC error, and
  the denied attempt is recorded with `denied: true`.
- Access is re-evaluated from the database on **every** call, not only when listing.
- Global tool deactivation beats every grant; a per-key deny beats every grant.

## stdio process isolation

- A child gets **only** its declared environment plus `PATH` and `HOME`. Every other variable the
  MCP SDK would inherit is blanked, so `SWITCHBOARD_MASTER_KEY` and friends cannot leak.
- The container runs as a non-root user (uid 1001).
- stdio MCPs still execute third-party code **inside the container**. This is documented in the UI
  and in the README; per-upstream container isolation is out of scope for v1.

## Rate limiting

- 50 concurrent calls per key, 300 calls/minute per key, then an explicit error.
- `report_feedback`: 20 submissions per key per hour.

## What is not protected (and why)

- No multi-user auth: one admin password for the UI. Single-operator tool by design.
- No OAuth on the client side in v1 (a claude.ai connector would require dynamic client
  registration against the gateway); bearer keys only.

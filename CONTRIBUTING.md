# Contributing

Thanks for taking the time to contribute. This is a small, single-operator tool; the most useful
contributions are focused bug fixes, tests, and documentation corrections that match how the code
actually behaves.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Local setup

Requires Node 20+.

```bash
cp .env.example .env      # set SWITCHBOARD_ADMIN_PASSWORD and SWITCHBOARD_SECRET
npm install
npm run dev               # MCP gateway + Next UI on http://localhost:3000
```

- Admin UI: <http://localhost:3000> (password from `.env`)
- MCP endpoint: `POST/GET/DELETE http://localhost:3000/mcp` with `Authorization: Bearer sk-sw-…`
- Health: `GET http://localhost:3000/healthz`

State lives in `./data` (SQLite database and, if you did not set `SWITCHBOARD_MASTER_KEY`,
`master.key`). Delete that directory to start from an empty instance. Neither is ever committed.

`npm run dev` runs `server.ts` under `tsx watch`: the MCP gateway and the Next.js request handler
in one process, which is the production topology too.

`.env` is loaded by Next when the server boots, so a variable consumed before that (the data
directory, for instance) has to come from the shell environment instead:
`SWITCHBOARD_DATA_DIR=./data npm run dev`. Everything read per request — the admin password, the
public URL from the settings table — picks up `.env` normally.

## Checks that must pass

| Command | Expected |
|---|---|
| `npx tsc --noEmit` | No output, exit 0. |
| `npx vitest run` | Every test file passes. |
| `npm run check` | Typecheck + tests; this is the shorthand for the two above. |

Optionally, before a larger change, build the production bundle: `npm run build`. Tests run
against `tests/` only (`npm test` is `vitest run`); a behaviour change without a test is treated
as an incomplete change.

Some suites are file-scoped and keep runtime state across cases (`keepRuntimeStateForFile()` in
`tests/helpers/reset.ts`); most rely on the default per-test reset. Follow the pattern of the
neighbouring suite rather than inventing one.

## Coding conventions

- **TypeScript strict.** No `any` to silence a compiler error, no non-null assertions where a
  narrow check would do. Fix the type, not the diagnostic.
- **`lib/` is server-only.** Anything touching SQLite, crypto, the upstream manager or the catalog
  stays under `lib/` and is reached from a server component or a route handler. Client components
  live in `components/` and `app/(ui)/**` and talk to `/api/v1/**`; they must never import
  server-only modules.
- **Shared runtime state goes through `lib/runtime/global.ts`.** The process runs two module
  graphs (the esbuild server bundle and Next's bundle), so a module-level singleton is not shared
  across them. Use the accessors (`getDb()`, `getUpstreamManager()`, `getCatalogSnapshot()`, …).
- **Tests live in `tests/`**, one file per behaviour area, named after the module or the contract
  they pin (`access.test.ts`, `discoverability.test.ts`). Prefer asserting observable behaviour
  (gateway response, DB row, HTTP status) over internal call order.
- **UI copy is French; identifiers are English.** User-facing strings, labels and error messages
  stay in French. Variable names, function names, types, file names, log messages and code
  comments are English.
- Match the surrounding style: 2-space indent, double quotes, explicit return types on exported
  functions where the signature is not obvious.

## Pull requests

- Keep it **small and focused**: one behaviour or one fix per PR. Unrelated reformatting makes a
  review impossible and will be asked out.
- **Tests for behaviour changes** — bug fixes include a test that fails before and passes after.
- Run `npx tsc --noEmit` and `npx vitest run` locally; say in the PR description what you ran.
- **No secrets in commits.** No `.env`, no `data/`, no API keys, no captured tokens — including in
  logs pasted into the description or a test fixture. Redact before pasting.
- Describe what changed and why, and call out anything user-visible (UI copy, API shape, config
  variable, migration).

## License

Contributions are accepted under the MIT license (see [LICENSE](LICENSE)).

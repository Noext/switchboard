# End-to-end checklist

A guided manual test with two real MCP clients, each configured with only Switchboard and its own
key. It covers the acceptance criteria in [SPEC.md](./SPEC.md) §12.2.

## 0. Prerequisites

- Switchboard reachable at `https://switchboard.example.com/mcp` (or a LAN address).
- At least one upstream MCP server connected (Serveurs → Ajouter), with **three or more tools**.
- Two agent keys created in **Clés API**: `agent-a` and `agent-b`.

Below, the upstream is called `demo` with tools `A`, `B`, `C`.

## 1. Set the rights

1. **Serveurs → demo → Accès**: grant nothing yet.
2. **Clés → agent-a → Droits → demo → Sélection**: check A, B, C.
3. **Clés → agent-b → Droits → demo → Sélection**: check B only.

A key that has never been granted anything sees no tools at all — that is the deny-by-default rule.

## 2. First agent (full access)

```bash
claude mcp add --scope user --transport http switchboard https://switchboard.example.com/mcp \
  --header "Authorization: Bearer sk-sw-<agent-a>"
claude
```

- [ ] `/mcp` shows `switchboard` connected.
- [ ] The tool list contains exactly `demo__A`, `demo__B`, `demo__C` (plus `report_feedback`).
- [ ] Calling `demo__A` succeeds.
- [ ] `demo__D` is absent.

## 3. Second agent (restricted key)

Add the same server with `sk-sw-<agent-b>`.

- [ ] The tool list contains only `demo__B` (plus `report_feedback`).
- [ ] A forced call to `demo__A` returns "unknown tool", and the **Journal** shows a `denied` row.
      The error must be indistinguishable from calling a tool that does not exist.

## 4. Hot changes (no client restart)

- [ ] With both agents open, grant D to `agent-a`. Within 5 s its session lists `demo__D`
      (if the client honours `list_changed`; otherwise it appears in the next session, still with
      no config change).
- [ ] Add a new upstream in the UI. Within 5 s an open session sees its tools.
- [ ] Disable a tool globally (**Serveur → Outils** toggle). It disappears for every key.
- [ ] Edit a role used by both keys. Both sessions update within 5 s.

## 5. Feedback

- [ ] As `agent-b`, call `report_feedback` with `category: access_needed` and `tool: "demo__A"`.
      The **Retours** page shows it with the key, the session and the related denied call.
- [ ] Sending the identical feedback again increments `occurrences` instead of creating a row.
- [ ] "Accorder cet outil" pre-fills the rights editor; granting it makes `demo__A` appear within 5 s.

## 6. Key lifecycle

- [ ] Revoke `agent-a`: its open session closes immediately, further requests get 401.
- [ ] Rotate `agent-b` with a 1 h grace window: the old value keeps working during the window, and
      the new one works immediately.
- [ ] Duplicate `agent-b`: the copy has the same roles and grants, with its own secret.
- [ ] `INSTALL-<key>.md` downloads from the key page and contains the right URL and snippets.

## 7. Transports and discovery

- [ ] Add a stdio upstream (`npx …`) in `lazy` mode: tools are listed without the process running,
      the first call starts it, and it stops after the idle timeout.
- [ ] Give a key more than 60 tools (or set its exposure mode to `discovery`): `tools/list` returns
      `list_servers`, `search_tools`, `describe_tool`, `call_tool` + `report_feedback`.
- [ ] `search_tools({})` with no query lists every authorised tool. `list_servers({})` shows the
      inventory. `describe_tool({name: "search_tools"})` works (meta-tools are describable).
- [ ] A search that matches nothing names the servers that *are* reachable.

## 8. OAuth upstream

- [ ] Connect an OAuth-protected MCP (GitHub, Atlassian…) from the UI.
- [ ] Restart Switchboard: the tools still work (the refresh token survived).
- [ ] Revoke the token upstream and call a tool: the upstream turns `auth_required`, its tools
      disappear from the catalog, and the dashboard shows a reconnect banner.

## 9. Isolation and failure

- [ ] Break one upstream (wrong URL). The others keep working and the dashboard marks it
      `degraded`/`error`.
- [ ] Confirm no upstream secret appears in the API, the logs or the events
      (`grep` the container logs for the token).
- [ ] Confirm a stdio child does not inherit the gateway's environment (try echoing
      `SWITCHBOARD_MASTER_KEY` from inside it — it must be empty).

## 10. Naming hygiene

- [ ] Every tool name exposed by Switchboard matches `[a-zA-Z0-9_-]+` and is ≤ 46 characters
      (clients add their own prefix on top).
- [ ] `report_feedback` is present for every agent key, even with no grants and in discovery mode.

#!/usr/bin/env node
/**
 * End-to-end acceptance scenario (spec §12.2), against a live Switchboard + a real upstream MCP:
 *
 *   sk-aaa (first agent)   -> toto: A, B, C
 *   sk-bbb (second agent)  -> toto: B only
 *   - sk-bbb lists only toto__B (+ report_feedback)
 *   - sk-bbb calling toto__A gets the same error as an unknown tool, and a denied log row
 *   - toto publishes D -> sk-aaa (granted "all") sees it, sk-bbb ("selected") does not
 *   - disabling A globally hides it from everyone
 *   - revoking sk-bbb cuts its session immediately
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BASE = process.env.SMOKE_BASE ?? "http://127.0.0.1:3999";
const cookies = process.env.SMOKE_COOKIE;
let failures = 0;

function ok(msg) { console.log("  ok  " + msg); }
function bad(msg) { failures++; console.error("  FAIL " + msg); }
function expectEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) ok(label); else bad(label + "\n        expected " + e + "\n        received " + a);
}

async function api(pathname, init = {}) {
  const res = await fetch(BASE + "/api/v1" + pathname, {
    ...init,
    headers: { cookie: cookies, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) throw new Error(pathname + " -> " + res.status + " " + text.slice(0, 300));
  return body;
}

async function connect(secret) {
  const transport = new StreamableHTTPClientTransport(new URL(BASE + "/mcp"), {
    requestInit: { headers: { authorization: "Bearer " + secret } },
  });
  const client = new Client({ name: "acceptance", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}

const toolNames = async (client) => (await client.listTools()).tools.map((t) => t.name).sort();

// ---------------------------------------------------------------- setup
console.log("\n[setup] two keys from the spec scenario");

// Unique suffix so the script can be re-run against the same database.
const RUN = Date.now().toString(36).slice(-6);
const createdA = await api("/keys", { method: "POST", body: JSON.stringify({ name: "first-agent-" + RUN, exposureMode: "direct" }) });
const createdB = await api("/keys", { method: "POST", body: JSON.stringify({ name: "second-agent-" + RUN, exposureMode: "direct" }) });
const keyA = createdA.key, secretA = createdA.secret;
const keyB = createdB.key, secretB = createdB.secret;
if (!secretA || !secretB) throw new Error("key creation did not return secrets");

const ups = await api("/upstreams");
const toto = ups.items.find((u) => u.slug === "toto");
if (!toto) throw new Error("no toto upstream");

// sk-aaa: selected A,B,C   |   sk-bbb: selected B
for (const [keyId, tools] of [[keyA.id, ["A", "B", "C"]], [keyB.id, ["B"]]]) {
  await api("/grants", {
    method: "PUT",
    body: JSON.stringify({ subjectType: "key", subjectId: keyId, upstreamId: toto.id, toolMode: "selected", tools, prompts: true, resources: true }),
  });
}
ok("grants set: sk-aaa = A,B,C / sk-bbb = B");

// ---------------------------------------------------------------- listings
console.log("\n[1] listings are scoped per key");
{
  const { client } = await connect(secretA);
  expectEq(await toolNames(client), ["report_feedback", "toto__A", "toto__B", "toto__C"], "sk-aaa sees A, B, C");
  await client.close();
}
{
  const { client } = await connect(secretB);
  expectEq(await toolNames(client), ["report_feedback", "toto__B"], "sk-bbb sees only B");
  await client.close();
}

// ---------------------------------------------------------------- denied call
console.log("\n[2] an unauthorised call is indistinguishable from an unknown one");
{
  const { client } = await connect(secretB);

  const errors = [];
  for (const name of ["toto__A", "nope__A"]) {
    try {
      await client.callTool({ name, arguments: {} });
      errors.push({ name, threw: false });
    } catch (error) {
      errors.push({ name, threw: true, code: error.code, message: String(error.message) });
    }
  }
  if (!errors.every((e) => e.threw)) bad("both calls should have failed: " + JSON.stringify(errors));
  else ok("both calls failed");

  const normalise = (m) => String(m).replace(/toto__A|nope__A/g, "<tool>");
  if (errors[0].code === errors[1].code && normalise(errors[0].message) === normalise(errors[1].message)) {
    ok("denied and unknown produce identical errors (" + errors[0].code + ")");
  } else {
    bad("errors differ:\n        " + JSON.stringify(errors));
  }

  const allowed = await client.callTool({ name: "toto__B", arguments: { text: "hello" } });
  const text = JSON.stringify(allowed.content);
  if (text.includes("B:hello")) ok("sk-bbb can still call toto__B");
  else bad("toto__B call failed: " + text);

  await client.close();
}

// denied row in the log
{
  const logs = await api("/logs?denied=1&limit=5");
  const deniedRows = (logs.items ?? []).filter((l) => l.denied);
  if (deniedRows.length > 0) ok("a denied call_logs row was written (" + deniedRows[0].name + ")");
  else bad("no denied row in the log: " + JSON.stringify(logs).slice(0, 300));
}

// ---------------------------------------------------------------- new tool D
console.log("\n[3] a newly published tool D reaches 'all' keys only");
{
  // Switch sk-aaa to mode "all" so it auto-receives future tools (spec §7.4).
  await api("/grants", {
    method: "PUT",
    body: JSON.stringify({ subjectType: "key", subjectId: keyA.id, upstreamId: toto.id, toolMode: "all", tools: [], prompts: true, resources: true }),
  });

  // Restart the fixture upstream with its 4th tool, then have Switchboard reconnect and re-list.
  const { spawn, execSync } = await import("node:child_process");
  const here = new URL(".", import.meta.url).pathname;
  try {
    execSync("pkill -f 'fixtures/toto-upstream' || true", { stdio: "ignore" });
  } catch {
    /* nothing to kill */
  }
  await new Promise((r) => setTimeout(r, 1000));
  const child = spawn(process.execPath, [here + "fixtures/toto-upstream.mjs", "--with-d"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, PORT: "4100" },
  });
  child.unref();
  await new Promise((r) => setTimeout(r, 1800));
  await api("/upstreams/" + toto.id + "/restart", { method: "POST" });
  await new Promise((r) => setTimeout(r, 2500));

  const { client } = await connect(secretA);
  const aTools = await toolNames(client);
  if (aTools.includes("toto__D")) ok("sk-aaa (mode all) sees the new tool D");
  else bad("sk-aaa missing toto__D: " + JSON.stringify(aTools));
  await client.close();

  const { client: cb } = await connect(secretB);
  const bTools = await toolNames(cb);
  if (!bTools.includes("toto__D")) ok("sk-bbb (mode selected) does not see D");
  else bad("sk-bbb should not see D: " + JSON.stringify(bTools));
  await cb.close();

  const discoveries = await api("/discoveries");
  if (discoveries.items.some((d) => d.toolName === "D")) ok("D recorded in tool_discoveries");
  else bad("D not in discoveries: " + JSON.stringify(discoveries.items?.map((d) => d.toolName)));
}

// ---------------------------------------------------------------- global disable
console.log("\n[4] globally disabling a tool hides it from every key");
{
  const items = await api("/upstreams/" + toto.id + "/items?kind=tool");
  const bTool = items.items.find((t) => t.name === "B");
  if (!bTool) throw new Error("tool B not found in items");
  await api("/upstreams/" + toto.id + "/items/tool/B", { method: "PUT", body: JSON.stringify({ enabled: false }) });

  const { client } = await connect(secretB);
  const tools = await toolNames(client);
  if (!tools.includes("toto__B")) ok("B is gone for sk-bbb after global disable");
  else bad("B still listed: " + JSON.stringify(tools));
  await client.close();

  await api("/upstreams/" + toto.id + "/items/tool/B", { method: "PUT", body: JSON.stringify({ enabled: true }) });
  ok("B re-enabled");
}

// ---------------------------------------------------------------- revocation
console.log("\n[5] revoking a key cuts its live session immediately (spec §6.1)");
{
  const { client } = await connect(secretB);
  ok("sk-bbb session open");
  await api("/keys/" + keyB.id + "/revoke", { method: "POST", body: "{}" });
  await new Promise((r) => setTimeout(r, 600));

  let refused = false;
  try {
    await client.listTools();
  } catch {
    refused = true;
  }
  if (refused) ok("open session refused after revocation");
  else bad("session still usable after revocation");

  // A brand-new connection must get 401.
  const res = await fetch(BASE + "/mcp", {
    method: "POST",
    headers: { authorization: "Bearer " + secretB, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } } }),
  });
  if (res.status === 401) ok("revoked key -> 401 on /mcp");
  else bad("revoked key got HTTP " + res.status);

  try { await client.close(); } catch {}
}

// ---------------------------------------------------------------- rotation grace
console.log("\n[6] rotation keeps the old secret alive during the grace window");
{
  const key = await api("/keys", { method: "POST", body: JSON.stringify({ name: "rotate-me-" + RUN }) });
  const rotated = await api("/keys/" + key.key.id + "/rotate", { method: "POST", body: JSON.stringify({ graceSeconds: 3600 }) });
  const newSecret = rotated.secret;
  if (!newSecret) throw new Error("rotate returned no secret");

  for (const [label, secret] of [["new secret", newSecret], ["old secret (grace)", key.secret]]) {
    const res = await fetch(BASE + "/mcp", {
      method: "POST",
      headers: { authorization: "Bearer " + secret, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } } }),
    });
    if (res.status === 200) ok(label + " accepted");
    else bad(label + " rejected with " + res.status);
  }
}

// ---------------------------------------------------------------- effective view + install
console.log("\n[7] per-key effective view and INSTALL file");
{
  const eff = await api("/keys/" + keyA.id + "/effective");
  const publicTools = eff.effective?.publicTools ?? [];
  if (publicTools.length > 0) ok("effective view lists " + publicTools.length + " tool(s) for sk-aaa");
  else bad("effective view is empty: " + JSON.stringify(eff).slice(0, 200));
  const install = await fetch(BASE + "/api/v1/keys/" + keyA.id + "/install.md", { headers: { cookie: cookies } });
  const md = await install.text();
  if (install.ok && md.includes("claude mcp add")) ok("install.md contains the Claude Code command");
  else bad("install.md unexpected: " + install.status + " " + md.slice(0, 200));
}

console.log("\n" + (failures === 0 ? "ACCEPTANCE OK" : failures + " FAILURE(S)"));
process.exit(failures === 0 ? 0 : 1);

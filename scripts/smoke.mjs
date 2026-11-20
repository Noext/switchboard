import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BASE = process.env.SMOKE_BASE ?? "http://127.0.0.1:3999";
const KEY = process.env.SMOKE_KEY;

function fail(msg) { console.error("FAIL: " + msg); process.exit(1); }
function ok(msg) { console.log("ok  " + msg); }

async function connect(key) {
  const transport = new StreamableHTTPClientTransport(new URL(BASE + "/mcp"), {
    requestInit: { headers: { Authorization: "Bearer " + key } },
  });
  const client = new Client({ name: "smoke-client", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

// 1. No key -> 401
{
  const res = await fetch(BASE + "/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } } }),
  });
  if (res.status !== 401) fail("missing key should be 401, got " + res.status);
  ok("missing key -> 401");
}

// 2. Bad key -> 401
{
  const res = await fetch(BASE + "/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer sk-sw-" + "z".repeat(32), accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } } }),
  });
  if (res.status !== 401) fail("bad key should be 401, got " + res.status);
  ok("bad key -> 401");
}

// 3. Real session: initialize + tools/list
const client = await connect(KEY);
ok("initialize with valid key");
const { tools } = await client.listTools();
console.log("    tools: " + tools.map((t) => t.name).join(", "));
if (!tools.some((t) => t.name === "report_feedback")) fail("report_feedback must always be listed");
ok("report_feedback is listed with no upstream access");

// 4. Calling an unknown tool must error, not crash
try {
  await client.callTool({ name: "nope__nothing", arguments: {} });
  fail("unknown tool should have errored");
} catch {
  ok("unknown tool rejected");
}

// 5. report_feedback works end to end
const fb = await client.callTool({
  name: "report_feedback",
  arguments: {
    category: "missing_tool",
    severity: "medium",
    title: "Smoke test feedback",
    description: "Filed by the smoke test to prove the tool is wired.",
  },
});
const text = fb.content?.[0]?.text ?? "";
const structured = fb.structuredContent ?? {};
const status = structured.status;
if (status !== "recorded" && status !== "merged") fail("feedback not recorded: " + JSON.stringify(fb));
if (!structured.id) fail("feedback response missing id: " + JSON.stringify(fb));
ok("report_feedback recorded (" + status + ", id=" + structured.id + "): " + text.slice(0, 90));

// 6. Prompt/resource listing works even when empty
const prompts = await client.listPrompts();
const resources = await client.listResources();
ok("prompts/resources list without error (" + prompts.prompts.length + "/" + resources.resources.length + ")");

// 7. instructions are present
ok("server instructions length: " + (client.getInstructions() ?? "").length);

await client.close();
console.log("\nSMOKE OK");

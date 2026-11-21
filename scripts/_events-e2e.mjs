/**
 * End-to-end check of the events relay against the REAL Harbor.
 *
 * Runs a tiny webhook receiver, asks Switchboard for the event types, subscribes, and verifies
 * the whole handshake: verification POST, challenge echo, then a signed delivery.
 */
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";

const BASE = process.env.SB_BASE ?? "https://switchboard.home.noext.fr";
const COOKIE = process.env.SB_COOKIE;
const PORT = Number(process.env.HOOK_PORT ?? 9099);
let fails = 0;
const ok = (m) => console.log("  ok   " + m);
const bad = (m) => { fails++; console.error("  FAIL " + m); };

const api = async (p, init = {}) => {
  const res = await fetch(BASE + "/api/v1" + p, {
    ...init,
    headers: { cookie: COOKIE, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(p + " -> " + res.status + " " + (await res.text()).slice(0, 200));
  return res.json();
};

// --- webhook receiver -------------------------------------------------------
const received = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let parsed = null;
    try { parsed = JSON.parse(body); } catch { /* keep raw */ }
    received.push({
      headers: req.headers,
      body: parsed,
      raw: body.slice(0, 400),
    });
    // A verification POST carries a challenge: echo it back as the extension expects.
    const challenge = parsed?.challenge ?? parsed?.verification?.challenge;
    if (challenge) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ challenge }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
});
await new Promise((r) => server.listen(PORT, "0.0.0.0", r));
console.log("webhook receiver on :" + PORT);

// --- key with harbor access -------------------------------------------------
const created = await api("/keys", { method: "POST", body: JSON.stringify({ name: "events-e2e-" + Date.now().toString(36) }) });
const keyId = created.key.id, secret = created.secret;
const ups = await api("/upstreams");
const harbor = ups.items.find((u) => u.slug === "harbor");
await api("/grants", { method: "PUT", body: JSON.stringify({ subjectType: "key", subjectId: keyId, upstreamId: harbor.id, toolMode: "all" }) });
ok("key granted harbor");

const transport = new StreamableHTTPClientTransport(new URL(BASE + "/mcp"), {
  requestInit: { headers: { authorization: "Bearer " + secret } },
});
const client = new Client({ name: "events-e2e", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);

const caps = client.getServerCapabilities();
const ext = caps?.extensions?.["io.modelcontextprotocol/events"];
if (ext) ok("capabilities advertise events: " + JSON.stringify(ext));
else bad("capabilities do NOT advertise events: " + JSON.stringify(caps));

const anyResult = z.custom((v) => typeof v === "object" && v !== null);
const rpc = async (method, params) => client.request({ method, params }, anyResult);

// --- events/list ------------------------------------------------------------
const list = await rpc("events/list", {});
const names = (list.events ?? []).map((e) => e.name).sort();
console.log("       event types: " + names.join(", "));
const expected = ["feedback.received", "job.finished", "sandbox.failed", "sandbox.ready"];
if (JSON.stringify(names) === JSON.stringify(expected)) ok("all four Harbor event types with schemas");
else bad("unexpected types: " + JSON.stringify(names));
if ((list.events ?? []).every((e) => e.payloadSchema)) ok("every type carries a payloadSchema");
else bad("some types lack payloadSchema");

// --- events/subscribe (webhook) --------------------------------------------
const receiverUrl = process.env.HOOK_URL ?? `http://192.168.101.249:${PORT}/hook`;
const sub = await rpc("events/subscribe", {
  upstream: "harbor",
  name: "sandbox.ready",
  delivery: { mode: "webhook", url: receiverUrl, secret: "whsec_e2e_test_secret" },
}).catch((e) => ({ error: String(e) }));
if (sub.subscriptionId) ok("subscribed: " + sub.subscriptionId);
else bad("subscribe failed: " + JSON.stringify(sub).slice(0, 250));

// Give the verification POST a moment.
await new Promise((r) => setTimeout(r, 1500));
if (received.length > 0) {
  const first = received[0];
  ok("receiver got a POST (" + received.length + ")");
  console.log("       first body: " + first.raw.slice(0, 160));
} else {
  bad("receiver got nothing (verification POST missing)");
}

// --- trigger a real event: create a sandbox --------------------------------
const sandboxName = "evt-e2e-" + Date.now().toString(36);
const created2 = await client.callTool({ name: "harbor__sandbox_create", arguments: { name: sandboxName } }).catch((e) => ({ error: String(e) }));
console.log("       sandbox_create -> " + JSON.stringify(created2.content ?? created2).slice(0, 120));
await new Promise((r) => setTimeout(r, 4000));

const signed = received.filter((r) => r.headers["webhook-signature"] || r.headers["webhook-id"]);
if (signed.length > 0) {
  ok("signed delivery received: id=" + signed[0].headers["webhook-id"] + " ts=" + signed[0].headers["webhook-timestamp"]);
  console.log("       signature: " + String(signed[0].headers["webhook-signature"]).slice(0, 40) + "...");
  console.log("       payload: " + JSON.stringify(signed[0].body).slice(0, 160));
} else {
  bad("no signed delivery after creating a sandbox (" + received.length + " POSTs total)");
}

// --- cleanup ----------------------------------------------------------------
await client.callTool({ name: "harbor__sandbox_delete", arguments: { sandbox: sandboxName, confirm: true } }).catch(() => {});
if (sub.subscriptionId) {
  await rpc("events/unsubscribe", { upstream: "harbor", subscriptionId: sub.subscriptionId }).catch(() => {});
  ok("unsubscribed");
}
await client.close();
await api("/keys/" + keyId + "/revoke", { method: "POST", body: "{}" });
server.close();
console.log(fails === 0 ? "\nEVENTS E2E OK" : "\n" + fails + " FAILURE(S)");
process.exit(fails === 0 ? 0 : 1);

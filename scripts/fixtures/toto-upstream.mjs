#!/usr/bin/env node
/**
 * Standalone upstream MCP server used by the acceptance smoke test.
 * Exposes tools A, B, C (and D when started with --with-d) over Streamable HTTP.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "node:http";
import { z } from "zod";

const PORT = Number(process.env.PORT ?? 4100);
const WITH_D = process.argv.includes("--with-d");

function buildServer() {
  const server = new McpServer({ name: "toto-upstream", version: "1.0.0" });
  const tools = ["A", "B", "C"];
  if (WITH_D) tools.push("D");
  for (const t of tools) {
    server.registerTool(
      t,
      {
        description: "Tool " + t + " of the toto upstream",
        inputSchema: { text: z.string().optional() },
        annotations: { readOnlyHint: true },
      },
      async ({ text }) => ({ content: [{ type: "text", text: t + ":" + (text ?? "ok") }] }),
    );
  }
  server.registerPrompt("review", { description: "Review something" }, async () => ({
    messages: [{ role: "user", content: { type: "text", text: "Please review." } }],
  }));
  return server;
}

const http = createServer(async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = buildServer();
  res.on("close", () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err) {
    if (!res.headersSent) res.writeHead(500).end(String(err));
  }
});

http.listen(PORT, "127.0.0.1", () => console.log("upstream listening on " + PORT));

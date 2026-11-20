#!/usr/bin/env node
/**
 * Tiny MCP stdio server used by tests/upstreams.test.ts.
 *
 * Exposes tools that make the interesting behaviours observable:
 *   - echo {text}          -> echoes the text back
 *   - env_probe            -> returns the child's whole environment (env isolation check)
 *   - slow {steps, delay}  -> emits progress notifications, then returns
 *   - hang {ms}            -> sleeps, then returns (used for cancellation)
 *   - fail                 -> returns an isError result
 *   - big_list {count}     -> returns many tools (pagination smoke test helper)
 * Also registers a prompt and a resource so the listing cache can be exercised.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "switchboard-stdio-fixture", version: "0.1.0" });

const text = (value) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] });

server.registerTool(
  "echo",
  {
    title: "Echo",
    description: "Echoes the provided text back.",
    inputSchema: { text: z.string().describe("text to echo") },
  },
  async ({ text: value }) => text(value),
);

server.registerTool(
  "env_probe",
  {
    description: "Returns the environment visible to this child process.",
    inputSchema: {},
  },
  async () => text({ env: { ...process.env }, cwd: process.cwd(), pid: process.pid }),
);

server.registerTool(
  "slow",
  {
    description: "Emits progress notifications before answering.",
    inputSchema: { steps: z.number().int().positive().default(2), delayMs: z.number().int().nonnegative().default(5) },
  },
  async ({ steps, delayMs }, extra) => {
    const token = extra?._meta?.progressToken;
    for (let step = 1; step <= steps; step++) {
      if (token !== undefined) {
        await extra.sendNotification({
          method: "notifications/progress",
          params: { progressToken: token, progress: step, total: steps, message: "step " + step },
        });
      }
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return text("done after " + steps + " steps");
  },
);

server.registerTool(
  "hang",
  {
    description: "Sleeps for the given number of milliseconds.",
    inputSchema: { ms: z.number().int().nonnegative().default(5000) },
  },
  async ({ ms }) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return text("slept " + ms);
  },
);

server.registerTool(
  "fail",
  {
    description: "Always returns an error result.",
    inputSchema: { message: z.string().default("boom") },
  },
  async ({ message }) => ({ content: [{ type: "text", text: message }], isError: true }),
);

server.registerTool(
  "stderr_noise",
  {
    description: "Writes a line to stderr (ring buffer check).",
    inputSchema: { line: z.string().default("noise") },
  },
  async ({ line }) => {
    process.stderr.write("fixture-stderr: " + line + "\n");
    return text("wrote " + line);
  },
);

let added = 0;
server.registerTool(
  "mutate_tools",
  {
    description: "Registers a new tool at runtime and emits notifications/tools/list_changed.",
    inputSchema: {},
  },
  async () => {
    added += 1;
    const name = "dynamic_tool_" + added;
    server.registerTool(name, { description: "Added at runtime #" + added, inputSchema: {} }, async () =>
      text("dynamic " + added),
    );
    server.sendToolListChanged();
    return text(name);
  },
);

server.registerPrompt(
  "greet",
  { title: "Greeting", description: "A greeting prompt.", argsSchema: { name: z.string().optional() } },
  ({ name }) => ({
    messages: [{ role: "user", content: { type: "text", text: "Bonjour " + (name ?? "monde") } }],
  }),
);

server.registerResource(
  "readme",
  "fixture://readme",
  { title: "Fixture readme", description: "Static test resource.", mimeType: "text/plain" },
  async (uri) => ({ contents: [{ uri: uri.href, text: "fixture resource body", mimeType: "text/plain" }] }),
);

await server.connect(new StdioServerTransport());

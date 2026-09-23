// R28 MCP live fixture — a real MCP server over stdio using the official SDK.
// Tools: echo (readOnly hint), add (readOnly hint), mutate (no hint — mutating counter),
// crash (makes the server exit, for dead-server transition checks).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

let counter = 0;
const server = new McpServer({ name: "r28-mcp-fixture", version: "1.0.0" });

server.registerTool(
  "echo",
  {
    description: "Echoes the input text back",
    inputSchema: { text: z.string() },
    annotations: { readOnlyHint: true },
  },
  async ({ text }) => ({ content: [{ type: "text", text: `ECHO:${text}` }] }),
);

server.registerTool(
  "add",
  {
    description: "Adds two numbers",
    inputSchema: { a: z.number(), b: z.number() },
    annotations: { readOnlyHint: true },
  },
  async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }),
);

server.registerTool(
  "mutate",
  { description: "Increments a server-side counter", inputSchema: {} },
  async () => {
    counter += 1;
    return { content: [{ type: "text", text: `COUNT:${counter}` }] };
  },
);

server.registerTool(
  "crash",
  { description: "Terminates the server process", inputSchema: {} },
  async () => {
    setTimeout(() => process.exit(42), 25);
    return { content: [{ type: "text", text: "CRASHING" }] };
  },
);

await server.connect(new StdioServerTransport());

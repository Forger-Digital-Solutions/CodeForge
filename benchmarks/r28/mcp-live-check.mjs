// R28 MCP live check — spawns a real MCP SDK server over stdio and drives the actual
// McpRegistry: handshake, tool enumeration, namespaced bridging, effect classification,
// real tool calls, dead-server transition, disabled-server refusal.
//
//   node benchmarks/r28/mcp-live-check.mjs
import fs from "node:fs";
import path from "node:path";
import { McpRegistry } from "@codeforge/mcp";

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + String(detail).slice(0, 150) : ""}`); };

const registry = new McpRegistry({ connectTimeoutMs: 20000, callTimeoutMs: 10000 });
registry.configure({
  name: "r28-fixture",
  transport: "stdio",
  command: process.execPath,
  args: [path.resolve("benchmarks/r28/mcp-fixture-server.mjs")],
  trust: {
    enabled: true,
    defaultEffect: "external",
    toolEffects: { echo: "network_read", crash: "deny" },
  },
});
registry.configure({
  name: "r28-disabled",
  transport: "stdio",
  command: process.execPath,
  args: [path.resolve("benchmarks/r28/mcp-fixture-server.mjs")],
  trust: { enabled: false, defaultEffect: "external" },
});

// 1. connectAll: enabled server connects, disabled refuses honestly
const connectResults = await registry.connectAll();
const fixtureTools = connectResults.get("r28-fixture");
const disabledResult = connectResults.get("r28-disabled");
check("enabled server connects + enumerates tools", Array.isArray(fixtureTools) && fixtureTools.length === 4, `${Array.isArray(fixtureTools) ? fixtureTools.length : "error"} tools`);
check("disabled server refuses without spawning", disabledResult?.code === "MCP_SERVER_DISABLED", disabledResult?.code ?? String(disabledResult));

// 2. State + definitions
const state = registry.listServerStates().find((s) => s.name === "r28-fixture");
check("server state connected with tool count", state?.status === "connected" && state?.toolCount === 4, JSON.stringify(state));
const defs = registry.toolDefinitions().map((d) => d.name).sort();
check("namespaced tool definitions bridged", defs.join(",") === "mcp__r28-fixture__add,mcp__r28-fixture__echo,mcp__r28-fixture__mutate", defs.join(","));
check("deny-effect tool never advertised", !defs.includes("mcp__r28-fixture__crash"), "crash excluded");

// 3. Effect classification through the trust profile
check("effect override honored (echo→network_read)", registry.effectOf("mcp__r28-fixture__echo") === "network_read", registry.effectOf("mcp__r28-fixture__echo"));
check("default effect applied (mutate→external)", registry.effectOf("mcp__r28-fixture__mutate") === "external", registry.effectOf("mcp__r28-fixture__mutate"));

// 4. Real tool calls
const exec = registry.executor();
const echoOut = await exec("mcp__r28-fixture__echo", { text: "hello-r28" });
check("real call: echo returns server output", echoOut.includes("ECHO:hello-r28"), echoOut.slice(0, 100));
check("call receipt carries effect + server", echoOut.includes('"serverName":"r28-fixture"') && echoOut.includes('"effect":"network_read"'), "receipt ok");
const addOut = await exec("mcp__r28-fixture__add", { a: 20, b: 28 });
check("real call: add computes", addOut.includes("48"), addOut.slice(0, 80));
const mutOut = await exec("mcp__r28-fixture__mutate", {});
check("real call: stateful mutate increments", mutOut.includes("COUNT:1"), mutOut.slice(0, 80));
check("non-MCP tools fall through", (await exec("browser_launch", {})) === undefined, "undefined for foreign tool");
try {
  await exec("mcp__r28-fixture__nope", {});
  check("unknown tool errors honestly", false, "no error");
} catch (e) {
  check("unknown tool errors honestly", /No connected MCP server provides|unknown/i.test(e.message), e.message.slice(0, 80));
}

// 5. Dead-server transition: call crash via a second registry where it isn't denied
const crashRegistry = new McpRegistry({ connectTimeoutMs: 20000, callTimeoutMs: 10000 });
crashRegistry.configure({
  name: "r28-fixture2",
  transport: "stdio",
  command: process.execPath,
  args: [path.resolve("benchmarks/r28/mcp-fixture-server.mjs")],
  trust: { enabled: true, defaultEffect: "external" },
});
await crashRegistry.connectAll();
const crashExec = crashRegistry.executor();
await crashExec("mcp__r28-fixture2__crash", {}).catch(() => undefined);
await new Promise((r) => setTimeout(r, 1500));
const deadState = crashRegistry.listServerStates().find((s) => s.name === "r28-fixture2");
check("crashed server transitions out of connected", deadState?.status !== "connected", `status=${deadState?.status}${deadState?.lastError ? " err=" + deadState.lastError.slice(0, 60) : ""}`);
try {
  await crashExec("mcp__r28-fixture2__echo", { text: "post-mortem" });
  check("call to dead server fails honestly", false, "call succeeded on dead server");
} catch (e) {
  check("call to dead server fails honestly", true, e.message.slice(0, 80));
}
await crashRegistry.closeAll();

await registry.closeAll();
const after = registry.listServerStates().find((s) => s.name === "r28-fixture");
check("closeAll tears down sessions", after?.status !== "connected", `status=${after?.status}`);

const passed = results.filter((r) => r.ok).length;
console.log(`\nMCP_LIVE_CHECK ${passed}/${results.length} PASS`);
fs.writeFileSync("docs/evidence/r28-capability-completion/R28-MCP-LIVE-EVIDENCE.json", JSON.stringify({
  schema: "r28-mcp-live-check-1",
  recordedAt: new Date().toISOString(),
  transport: "stdio (real @modelcontextprotocol/sdk 1.30 server child)",
  results,
}, null, 2) + "\n");
process.exit(passed === results.length ? 0 : 1);

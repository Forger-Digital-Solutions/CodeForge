// R31 §35-37: real MCP lifecycle + adversarial-server evidence.
// Spawns the repo's deterministic stdio fixture in each adversarial mode and records what the
// GovernedMcpClient/McpRegistry actually did — states, timeouts, refusals, redaction, truncation.
// Usage: node benchmarks/r31/mcp-lifecycle-evidence.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixture = path.join(root, "packages", "mcp", "test", "fixtures", "mcp-fixture-server.mjs");
const outDir = path.join(root, "docs", "evidence", "r31-production-release-closure", "24-tool-servers");
mkdirSync(outDir, { recursive: true });

const { McpRegistry } = await import("@codeforge/mcp");

const cfg = (name, mode, extra = {}) => ({
  name,
  transport: "stdio",
  command: process.execPath,
  args: [fixture, mode],
  trust: { enabled: true, defaultEffect: "external", ...(extra.trust ?? {}) },
  ...extra,
});

const results = { generatedAt: new Date().toISOString(), cases: {} };
const mark = (k, v) => { results.cases[k] = v; };

// Case 1: normal — configure → connect → discover → invoke → close → reconnect
{
  const reg = new McpRegistry({ connectTimeoutMs: 10_000, callTimeoutMs: 10_000 });
  reg.configure(cfg("normal", "normal"));
  const tools = await reg.connect("normal");
  const call = await reg.executor()("mcp__normal__echo", { text: "r31 proof" });
  const stateAfterCall = reg.listServerStates();
  await reg.closeAll();
  const stateAfterClose = reg.listServerStates();
  const tools2 = await reg.connect("normal"); // reconnect
  mark("normal", {
    toolsDiscovered: tools.map((t) => ({ toolName: t.toolName, effect: t.effect, readOnlyHint: t.readOnlyHint })),
    echoResult: call.slice(0, 200),
    stateAfterCall, stateAfterClose,
    reconnectTools: tools2.length,
  });
  await reg.closeAll();
}

// Case 2: trust policy — mutate_things lies about readOnlyHint; default external must win
{
  const reg = new McpRegistry();
  reg.configure(cfg("trust", "normal"));
  const tools = await reg.connect("trust");
  mark("lying_annotations_default_external", {
    mutate: tools.find((t) => t.remoteName === "mutate_things")?.effect,
    read: tools.find((t) => t.remoteName === "read_things")?.effect,
  });
  await reg.closeAll();
}

// Case 3: deny effect — a denied tool must never execute
{
  const reg = new McpRegistry();
  reg.configure(cfg("deny", "normal", { trust: { enabled: true, defaultEffect: "external", toolEffects: { mutate_things: "deny" } } }));
  await reg.connect("deny");
  let denied;
  try { await reg.executor()("mcp__deny__mutate_things", { id: "1" }); denied = "EXECUTED"; }
  catch (e) { denied = String(e.code ?? e.message).slice(0, 120); }
  mark("deny_effect", { mutateDenied: denied });
  await reg.closeAll();
}

// Case 4: crash-after-init — server death must flip state to dead, callers must not wedge
{
  const reg = new McpRegistry({ connectTimeoutMs: 10_000 });
  reg.configure(cfg("crash", "crash-after-init"));
  let connectErr = null;
  try { await reg.connect("crash"); } catch (e) { connectErr = String(e.code ?? e.message).slice(0, 120); }
  await new Promise((r) => setTimeout(r, 400));
  mark("crash_after_init", { connectErr, state: reg.listServerStates() });
  await reg.closeAll();
}

// Case 5: hang-tools — call timeout must fire; server marked degraded
{
  const reg = new McpRegistry({ connectTimeoutMs: 5_000, callTimeoutMs: 2_000 });
  reg.configure(cfg("hang", "hang-tools"));
  const t0 = Date.now();
  let err = null;
  try { await reg.connect("hang"); } catch (e) { err = String(e.code ?? e.message).slice(0, 140); }
  mark("hang_tools_timeout", { elapsedMs: Date.now() - t0, err, state: reg.listServerStates() });
  await reg.closeAll();
}

// Case 6: lying-schema — malformed descriptors are refused (incl. builtin-shadowing name attempt)
{
  const reg = new McpRegistry({ connectTimeoutMs: 10_000 });
  reg.configure(cfg("lies", "lying-schema"));
  let err = null;
  try { await reg.connect("lies"); } catch (e) { err = String(e.code ?? e.message).slice(0, 160); }
  mark("lying_schema", { err, state: reg.listServerStates() });
  await reg.closeAll();
}

// Case 7: secret-echo — tool output containing a token must be redacted before reaching the model
{
  const reg = new McpRegistry();
  reg.configure(cfg("secrets", "secret-echo"));
  await reg.connect("secrets");
  const out = await reg.executor()("mcp__secrets__echo", { text: "hi" });
  mark("secret_echo_redaction", {
    leaked: out.includes("ghp_" + "A".repeat(40)),
    outputSample: out.slice(0, 220),
  });
  await reg.closeAll();
}

// Case 8: giant-result — 2MB output must truncate at the 64KB cap
{
  const reg = new McpRegistry({ callTimeoutMs: 20_000 });
  reg.configure(cfg("giant", "giant-result"));
  await reg.connect("giant");
  const out = await reg.executor()("mcp__giant__echo", { text: "x" });
  mark("giant_result_truncation", {
    outputBytes: Buffer.byteLength(out, "utf8"),
    truncatedMarker: out.includes("TRUNCATED"),
  });
  await reg.closeAll();
}

// Case 9: unconfigured server — connect() on unknown name must refuse
{
  const reg = new McpRegistry();
  let err = null;
  try { await reg.connect("nonexistent"); } catch (e) { err = String(e.code ?? e.message).slice(0, 120); }
  mark("unconfigured", { err });
}

const outPath = path.join(outDir, "mcp-lifecycle.json");
writeFileSync(outPath, JSON.stringify(results, null, 1) + "\n");
console.log(`wrote ${outPath}`);
console.log(Object.keys(results.cases).join(", "));

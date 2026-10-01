#!/usr/bin/env node
/**
 * R59 Gate A — live supply inventory with exact exclusion reasons.
 *
 * Boots the packaged CodeForge executable with a throwaway profile, connects the provider
 * credentials the operator supplied (presence-only — values never leave the child env), and
 * captures GET /api/free-cloud/supply repeatedly while discovery + qualification run. The
 * ledger answers "why is no route usable" from data instead of inference.
 */
import { execFile as execFileCallback, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const exePath = path.join(root, "apps/desktop/release/win-unpacked/CodeForge.exe");
const option = (name, fallback = "") => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const output = path.resolve(option("output", path.join(root, "docs/evidence/r59-supply-recovery/live-supply-inventory.json")));
const windowSeconds = Math.max(20, Number(option("window-sec", "150")) || 150);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

class DevToolsSession {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener("message", (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message ?? "DevTools error"));
      else pending.resolve(message.result);
    });
    socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("DevTools closed")); }
      this.pending.clear();
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`DevTools ${method} timed out`)); }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return response;
  }
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout: 25_000 });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? "Renderer evaluation failed");
    return result.result?.value;
  }
  close() { this.socket.close(); }
}

async function connectRenderer(port, endpoint) {
  for (let attempt = 0; attempt < 90; attempt++) {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) }).then((response) => response.json());
      const page = targets.find((item) => item.type === "page" && item.url?.startsWith("file:") && item.webSocketDebuggerUrl);
      if (page) {
        const url = new URL(page.webSocketDebuggerUrl);
        if (!["127.0.0.1", "localhost"].includes(url.hostname) || Number(url.port) !== port) throw new Error("DevTools target escaped loopback");
        const socket = new WebSocket(url);
        await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
        const session = new DevToolsSession(socket);
        await session.send("Runtime.enable");
        if (await session.evaluate("window.electronAPI?.getRuntimeEndpoint?.()") === endpoint) return session;
        session.close();
      }
    } catch {}
    await delay(1000);
  }
  throw new Error("Primary packaged renderer did not connect to the expected runtime endpoint");
}

async function request(renderer, endpoint, pathname, method = "GET", body) {
  const init = { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
  return renderer.evaluate(`fetch(${JSON.stringify(`${endpoint}${pathname}`)}, ${JSON.stringify(init)}).then(async response => ({ status: response.status, body: await response.json().catch(() => null) }))`);
}

async function metadata(profile, pid) {
  for (let attempt = 0; attempt < 90; attempt++) {
    try {
      const value = JSON.parse(await readFile(path.join(profile, "runtime.json"), "utf8"));
      if (value.pid === pid && /^http:\/\/127\.0\.0\.1:\d+$/.test(value.runtimeEndpoint)) return value;
    } catch {}
    await delay(1000);
  }
  throw new Error("Packaged process did not publish matching runtime metadata");
}

/** Compact one-line-per-route ledger view for the console — full rows stay in the JSON. */
function compactRoutes(supply) {
  const routes = Array.isArray(supply?.routes) ? supply.routes : [];
  return routes.map((r) => ({
    route: `${r.providerId}/${r.modelId}`,
    verified: r.verifiedFree === true,
    executable: r.executable === true,
    forgeAuto: r.forgeAutoEligible === true,
    pending: r.pendingQualification === true,
    qualification: r.qualificationState ?? null,
    roles: r.roles ?? [],
    fallbackRoles: r.fallbackRoles ?? [],
    health: r.health ?? null,
    gate: r.admission?.failedGate ?? null,
    reason: r.admission?.reason ?? null,
    fabricExclusion: r.fabric?.exclusionReason ?? null,
    healthGate: r.fabric?.healthGate ?? null,
    inCoderPlan: r.fabric?.inCoderSupplyPlan ?? null,
  }));
}

async function main() {
  if (process.platform !== "win32") throw new Error("Live supply inventory requires the packaged Windows build");
  const providers = ["openrouter", "groq"].filter((p) => process.env[p === "groq" ? "GROQ_API_KEY" : "OPENROUTER_API_KEY"]);
  if (providers.length === 0) throw new Error("OPENROUTER_API_KEY and/or GROQ_API_KEY required (presence only)");
  // --profile=<dir> reuses a persistent profile so qualification receipts accumulate
  // across runs (a returning user keeps them); the caller then owns cleanup.
  const profileOption = option("profile", "");
  const profileReused = profileOption !== "";
  const profile = profileReused ? path.resolve(profileOption) : await mkdtemp(path.join(os.tmpdir(), "codeforge-r59-supply-"));
  if (profileReused) await mkdir(profile, { recursive: true });
  const localAppData = path.join(profile, "localappdata");
  const port = await freePort();
  const childEnv = { ...process.env, LOCALAPPDATA: localAppData };
  for (const name of Object.keys(childEnv)) if (/^(?:NODE_PATH|NODE_OPTIONS|ELECTRON_RUN_AS_NODE)$/i.test(name) || /(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|CLIENT_SECRET|PASSWORD)/i.test(name)) delete childEnv[name];
  const child = spawn(exePath, [`--user-data-dir=${profile}`, "--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${port}`], {
    cwd: path.dirname(exePath), env: childEnv, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  let exited = false;
  child.on("exit", () => { exited = true; });
  const startedAt = new Date().toISOString();
  const samples = [];
  let renderer;
  let failure = null;
  try {
    const runtime = await metadata(profile, child.pid);
    renderer = await connectRenderer(port, runtime.runtimeEndpoint);
    for (const providerId of providers) {
      const keyName = providerId === "groq" ? "GROQ_API_KEY" : "OPENROUTER_API_KEY";
      await renderer.evaluate(`window.electronAPI.setProviderCredential(${JSON.stringify(providerId)}, ${JSON.stringify(process.env[keyName])})`);
      // R59: the harness asserts the operator-confirmed free plan — the UI asks the same
      // question; without it allowance providers correctly refuse to spend the probe.
      await renderer.evaluate(`window.electronAPI.attestProviderFreePlan?.(${JSON.stringify(providerId)}, true)`).catch(() => undefined);
    }
    const deadline = Date.now() + windowSeconds * 1000;
    while (Date.now() < deadline) {
      if (exited) throw new Error("Packaged process exited during inventory");
      // A busy packaged server can stall a single DevTools evaluate past its timeout — record
      // the sample as unreachable rather than abandoning the inventory.
      const supply = await request(renderer, runtime.runtimeEndpoint, "/api/free-cloud/supply").catch((e) => ({ status: 0, body: { error: String(e) } }));
      const registry = await request(renderer, runtime.runtimeEndpoint, "/api/free-cloud/registry").catch((e) => ({ status: 0, body: { error: String(e) } }));
      samples.push({
        at: new Date().toISOString(),
        supplyStatus: supply.status,
        providers: supply.status === 200 ? supply.body?.providers : undefined,
        qualification: supply.status === 200 ? supply.body?.qualification : undefined,
        routes: supply.status === 200 ? compactRoutes(supply.body) : supply.body,
        registryPending: registry.status === 200 ? registry.body?.pendingQualification : undefined,
        registryQualifying: registry.status === 200 ? registry.body?.qualifying : undefined,
      });
      const q = samples[samples.length - 1].qualification ?? [];
      const providerRows = samples[samples.length - 1].providers ?? [];
      const anyPending = q.some((row) => (row?.pending ?? 0) > 0) || (samples[samples.length - 1].registryQualifying === true);
      const stillDiscovering = providerRows.some((p) => p?.discovering === true || p?.connected !== true);
      // Stop early once every provider's posture has settled — connected, not discovering,
      // pending==0 and nothing in flight — but always take at least three samples so
      // transient states show in the timeline.
      if (samples.length >= 3 && !anyPending && !stillDiscovering) break;
      await delay(10_000);
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    renderer?.close();
    if (!exited) {
      await execFile("taskkill", ["/PID", String(child.pid), "/T"], { windowsHide: true }).catch(() => {});
      await delay(2_000);
      if (!exited) await execFile("taskkill", ["/F", "/PID", String(child.pid), "/T"], { windowsHide: true }).catch(() => {});
    }
    if (!profileReused) await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
  await mkdir(path.dirname(output), { recursive: true });
  const result = { schema: "r59-live-supply-inventory/v1", evidenceClass: "packaged_live_provider", startedAt, finishedAt: new Date().toISOString(), providers, samples, failure };
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  const last = samples[samples.length - 1];
  console.log(JSON.stringify({ output, providers, samples: samples.length, failure, lastQualification: last?.qualification, lastRoutes: last?.routes?.length }, null, 1));
  for (const r of last?.routes ?? []) console.log(JSON.stringify(r));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

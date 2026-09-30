#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const exePath = path.join(root, "apps/desktop/release/win-unpacked/CodeForge.exe");
const option = (name, fallback = "") => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const output = path.resolve(option("output", path.join(root, "docs/evidence/r58-progress-aware-autonomy/packaged-self-dogfood.json")));
const workspacePath = path.resolve(option("workspace"));
const goalFile = path.resolve(option("goal-file"));
const modelId = option("model", "");
const providerId = option("provider", "openrouter");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const redactProviderIdentity = (value) => typeof value === "string"
  ? value.replace(/\borg_[a-z0-9]+\b/gi, "org_[redacted]")
  : value;

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
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

async function main() {
  if (process.platform !== "win32") throw new Error("Packaged self-dogfood requires Windows");
  const insideRoot = (candidate) => {
    const relative = path.relative(root, path.resolve(candidate));
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  };
  if (!insideRoot(workspacePath) || !insideRoot(output)) throw new Error("R58 self-dogfood paths must stay inside the CodeForge repository");
  // A packaged user can connect several free providers at once; ForgeAuto then admits the
  // first route that qualifies — connecting both lanes hedges transient free-tier 429 bursts.
  const providerIds = providerId.split(",").map((p) => p.trim()).filter(Boolean);
  for (const p of providerIds) if (!["openrouter", "groq"].includes(p)) throw new Error("Only the verified-free OpenRouter and Groq lanes are supported");
  const providerKeys = new Map(providerIds.map((p) => [p, { keyName: p === "groq" ? "GROQ_API_KEY" : "OPENROUTER_API_KEY" }]));
  for (const [p, rec] of providerKeys) {
    rec.key = process.env[rec.keyName];
    if (!rec.key) throw new Error(`${rec.keyName} is required (presence only)`);
    void p;
  }
  const task = JSON.parse(await readFile(goalFile, "utf8"));
  if (typeof task.goal !== "string" || !Array.isArray(task.verificationCommands)) throw new Error("Invalid goal file");
  const baselineHead = (await execFile("git", ["rev-parse", "HEAD"], { cwd: workspacePath })).stdout.trim();
  const baselineStatus = (await execFile("git", ["status", "--porcelain"], { cwd: workspacePath })).stdout.trim();
  if (baselineStatus) throw new Error("Isolated self-dogfood worktree must be clean at the task boundary");
  const workspaceDependencyLink = path.join(workspacePath, "node_modules");
  let workspaceDependencyLinkCreated = false;
  try { await lstat(workspaceDependencyLink); }
  catch {
    await symlink(path.join(root, "node_modules"), workspaceDependencyLink, "junction");
    workspaceDependencyLinkCreated = true;
  }
  const profileRoot = path.join(root, "benchmarks", "r58", "tmp");
  await mkdir(profileRoot, { recursive: true });
  const profile = await mkdtemp(path.join(profileRoot, "codeforge-r58-packaged-dogfood-"));
  const relative = path.relative(path.resolve(profileRoot), path.resolve(profile));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Temporary profile escaped the R58 workspace root");
  const localAppData = path.join(profile, "localappdata");
  const worktreesRoot = path.join(localAppData, "CodeForge", "worktrees", path.basename(workspacePath));
  const worktreeDependencyLink = path.join(worktreesRoot, "node_modules");
  await mkdir(path.dirname(worktreeDependencyLink), { recursive: true });
  await symlink(path.join(root, "node_modules"), worktreeDependencyLink, "junction");
  // Verification commands run with cwd inside the per-run managed worktree, so path-exec
  // like `node node_modules/vitest/...` needs the dependency link inside each wt-* directory.
  const linkWorktreeDependencies = async () => {
    try {
      for (const entry of await readdir(worktreesRoot)) {
        if (!entry.startsWith("wt-")) continue;
        await symlink(path.join(root, "node_modules"), path.join(worktreesRoot, entry, "node_modules"), "junction").catch(() => {});
      }
    } catch {}
  };
  const depsTimer = setInterval(() => { void linkWorktreeDependencies(); }, 1000);
  const port = await freePort();
  const childEnv = { ...process.env, LOCALAPPDATA: localAppData };
  delete childEnv.CODEFORGE_SUBAGENTS_R1;
  for (const name of Object.keys(childEnv)) if (/^(?:NODE_PATH|NODE_OPTIONS|ELECTRON_RUN_AS_NODE)$/i.test(name) || /(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|CLIENT_SECRET|PASSWORD)/i.test(name)) delete childEnv[name];
  const child = spawn(exePath, [`--user-data-dir=${profile}`, "--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${port}`], {
    cwd: path.dirname(exePath), env: childEnv, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  let stderrBytes = 0;
  let stdoutBytes = 0;
  let exited = false;
  child.stderr.on("data", (chunk) => { stderrBytes += chunk.length; });
  child.stdout.on("data", (chunk) => { stdoutBytes += chunk.length; });
  child.on("exit", () => { exited = true; });
  const startedAt = new Date().toISOString();
  const resourceSamples = [];
  const sampleResources = async () => {
    try {
      const command = `$p=Get-Process -Id ${Number(child.pid)} -ErrorAction Stop; [pscustomobject]@{rssBytes=$p.WorkingSet64;handles=$p.Handles}|ConvertTo-Json -Compress`;
      const sample = JSON.parse((await execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true, timeout: 10_000 })).stdout);
      resourceSamples.push({ at: new Date().toISOString(), ...sample });
    } catch {}
  };
  await sampleResources();
  const resourceTimer = setInterval(() => { void sampleResources(); }, 30_000);
  let renderer;
  let result;
  let failure = null;
  let runtime;
  const cleanup = { removedWorktrees: [], worktreeRemovalFailures: [], profileRemoved: false };
  try {
    runtime = await metadata(profile, child.pid);
    renderer = await connectRenderer(port, runtime.runtimeEndpoint);
    for (const [p, rec] of providerKeys) {
      await renderer.evaluate(`window.electronAPI.setProviderCredential(${JSON.stringify(p)}, ${JSON.stringify(rec.key)})`);
      // R59: account-dependent allowance providers (e.g. Groq) refuse to spend even a no-charge
      // probe without the operator's free-plan attestation — the same confirmation the UI asks
      // for. The harness asserts it because the operator supplying the key asserts it; without
      // it the eligible catalog is correctly empty and the run exercises nothing.
      await renderer.evaluate(`window.electronAPI.attestProviderFreePlan?.(${JSON.stringify(p)}, true)`).catch(() => undefined);
    }
    const supplyAtStart = await request(renderer, runtime.runtimeEndpoint, "/api/free-cloud/supply")
      .then((r) => (r.status === 200 ? r.body : { error: r.status }))
      .catch((e) => ({ error: String(e) }));
    const models = await request(renderer, runtime.runtimeEndpoint, "/api/models");
    assert.equal(models.status, 200, "Packaged renderer could not read models after credential setup");
    const setWorkspace = await request(renderer, runtime.runtimeEndpoint, "/api/workspace/set", "POST", { path: workspacePath });
    assert.equal(setWorkspace.status, 200, `Workspace selection failed: ${JSON.stringify(setWorkspace.body)}`);
    let catalog = Array.isArray(models.body) ? models.body : [];
    let catalogIds = catalog.filter((m) => m && m.eligible === true).map((m) => `${m.providerId}/${m.id ?? m.modelId}`);
    const sessionId = `r58-packaged-dogfood-${randomUUID()}`;
    if (modelId) {
      let selection;
      for (let attempt = 0; attempt < 30; attempt++) {
        selection = await request(renderer, runtime.runtimeEndpoint, "/api/model-selection", "POST", { sessionId, providerId: providerIds[0], modelId, lock: "route" });
        if (selection.status === 200) break;
        if (selection.body?.error !== "MODEL_NOT_FOUND") break;
        const refreshed = await request(renderer, runtime.runtimeEndpoint, "/api/models");
        if (Array.isArray(refreshed.body)) {
          catalog = refreshed.body;
          catalogIds = catalog.filter((m) => m && m.eligible === true).map((m) => `${m.providerId}/${m.id ?? m.modelId}`);
        }
        await delay(5_000);
      }
      assert.equal(selection?.status, 200, `Free route selection failed: ${JSON.stringify(selection?.body)} | eligible catalog: ${JSON.stringify(catalogIds.slice(0, 60))}`);
    }
    const launched = await request(renderer, runtime.runtimeEndpoint, "/api/orchestrator/run", "POST", { sessionId, workspacePath, goal: task.goal, verificationCommands: task.verificationCommands });
    assert.equal(launched.status, 200, `Autonomous run launch failed: ${JSON.stringify(launched.body)}`);
    let runId = launched.body.runId;
    const deadlineMinutes = Math.max(5, Number(option("run-deadline-min", "90")) || 90);
    const deadline = Date.now() + deadlineMinutes * 60_000;
    const missingDeadline = Date.now() + 90_000;
    let run;
    let consecutivePollFailures = 0;
    while (Date.now() < deadline) {
      if (exited) throw new Error("Packaged process exited during autonomous task");
      // A busy packaged server (qualification suites + active model turns share the loop)
      // can stall a single DevTools evaluate past its timeout — a slow poll is not a failed
      // run. Skip the tick; only a sustained outage (60s+) is evidence of a dead endpoint.
      let response;
      try {
        response = await request(renderer, runtime.runtimeEndpoint, `/api/orchestrator/${runId}`);
        consecutivePollFailures = 0;
      } catch (pollError) {
        consecutivePollFailures += 1;
        if (consecutivePollFailures >= 12) throw pollError;
        await delay(5_000);
        continue;
      }
      if (response.status === 200) run = response.body;
      if (response.status === 404) {
        const listed = await request(renderer, runtime.runtimeEndpoint, "/api/orchestrator/list").catch(() => ({ status: 0, body: null }));
        const matching = listed.status === 200 && Array.isArray(listed.body)
          ? listed.body.find((item) => item.sessionId === sessionId && item.goal === task.goal)
          : null;
        if (matching?.id) runId = matching.id;
        else if (Date.now() >= missingDeadline) throw new Error("Packaged autonomous run was never registered under its returned ID");
      }
      if (run && ["completed", "blocked", "failed", "cancelled"].includes(run.status)) break;
      await delay(5_000);
    }
    if (!run || !["completed", "blocked", "failed", "cancelled"].includes(run.status)) throw new Error(`Packaged autonomous task exceeded ${deadlineMinutes}-minute deadline`);
    const finalHead = (await execFile("git", ["rev-parse", "HEAD"], { cwd: workspacePath })).stdout.trim();
    const finalStatus = (await execFile("git", ["status", "--porcelain"], { cwd: workspacePath })).stdout.trim();
    const diff = (await execFile("git", ["diff", "--binary", baselineHead, "HEAD"], { cwd: workspacePath, maxBuffer: 8 * 1024 * 1024 })).stdout;
    let independentVerification;
    try {
      const command = task.verificationCommands[0].split(" ");
      const test = await execFile(command[0], command.slice(1), { cwd: workspacePath, timeout: 120_000 });
      independentVerification = { passed: true, outputSample: test.stdout.slice(-300) };
    } catch (error) {
      independentVerification = { passed: false, outputSample: String(`${error.stdout ?? ""}${error.stderr ?? ""}` || error.message).slice(-300) };
    }
    let independentAcceptance;
    try {
      const probe = await execFile(process.execPath, [path.join(root, "benchmarks/r57/selfdogfood-acceptance.mjs"), `--workspace=${workspacePath}`], { cwd: root, timeout: 30_000 });
      independentAcceptance = { passed: true, outputSample: probe.stdout.slice(-200) };
    } catch (error) {
      independentAcceptance = { passed: false, outputSample: String(`${error.stdout ?? ""}${error.stderr ?? ""}` || error.message).slice(-300) };
    }
    const session = await request(renderer, runtime.runtimeEndpoint, `/api/sessions/${sessionId}`);
    const items = session.status === 200 && Array.isArray(session.body?.workItems) ? session.body.workItems : [];
    const supplyAtEnd = await request(renderer, runtime.runtimeEndpoint, "/api/free-cloud/supply")
      .then((r) => (r.status === 200 ? r.body : { error: r.status }))
      .catch((e) => ({ error: String(e) }));
    result = {
      schema: "r58-packaged-self-dogfood/v1", evidenceClass: "packaged_live_provider",
      startedAt, finishedAt: new Date().toISOString(),
      artifact: { version: runtime.applicationVersion, sha256: await hashFile(exePath) },
      workspace: { baselineHead, finalHead, cleanAtStart: !baselineStatus, cleanAtFinish: !finalStatus, changedFiles: run.result?.changedFiles ?? [], diffSha256: createHash("sha256").update(diff).digest("hex") },
      task: { goalClass: task.goalClass ?? "bounded_test_utility", verificationCommands: task.verificationCommands },
      run: { id: runId, status: run.status, summary: redactProviderIdentity(run.result?.summary ?? null), completion: run.result?.completion?.outcome ?? null, integration: run.result?.integration?.status ?? null, reviewPassed: run.result?.review?.passed ?? false, verificationPassed: run.result?.verification?.map((row) => row.passed) ?? [], verification: (run.result?.verification ?? []).map((row) => ({ command: row.command, cwd: row.cwd, exitCode: row.exitCode, output: redactProviderIdentity(String(row.output ?? "")).slice(-400), failures: (row.failures ?? []).map((f) => redactProviderIdentity(String(f?.message ?? f)).slice(-200)) })), counters: run.result?.counters ?? null, error: redactProviderIdentity(run.error ?? null) },
      provider: { sourceClass: "MANAGED_FREE", providerIds, selectedModel: modelId || null, modelCount: catalog.length, eligibleCatalogSample: catalogIds, planAttestation: "asserted via provider:attestFreePlan", supplyAtStart, supplyAtEnd },
      runtimeFlags: { CODEFORGE_SUBAGENTS_R1: "unset" },
      workers: items.filter((item) => item.kind === "subagent_run").map((item) => ({ id: item.id, role: item.role, status: item.status, executorKind: item.executorKind, model: item.model, modelRequests: item.telemetry?.modelRequests, toolCalls: item.telemetry?.toolCalls, usefulProgressEvents: item.usefulProgressEvents ?? 0, duplicateProgressChecks: item.duplicateProgressChecks ?? 0, watchdogExtensions: item.watchdogExtensions ?? 0, watchdogAbortReason: item.watchdogAbortReason ?? null, observedModelLatencyMs: item.observedModelLatencyMs ?? null })),
      modelTurns: items.filter((item) => item.kind === "agent_model_turn").map((item) => ({ runId: item.runId, state: item.state, servedProviderId: item.servedProviderId, servedModelId: item.servedModelId, modelLatencyMs: item.modelLatencyMs ?? null })),
      toolExecutionCount: items.filter((item) => item.kind === "agent_tool_execution").length,
      continuations: items.filter((item) => item.kind === "coder_lease_continuation").map((item) => ({ status: item.status, priorWorkerId: item.priorWorkerId, checkpointCommit: item.checkpointCommit, changedFiles: item.changedFiles })),
      shillingEntryCount: items.filter((item) => item.kind === "shilling_entry").length,
      experienceReceiptCount: items.filter((item) => item.kind === "autonomous_experience_receipt").length,
      independentVerification, independentAcceptance, process: { pid: child.pid, stdoutBytes, stderrBytes, resourceSamples },
    };
  } catch (error) {
    failure = redactProviderIdentity(error instanceof Error ? error.message : String(error));
    result = { schema: "r58-packaged-self-dogfood/v1", evidenceClass: "packaged_live_provider", startedAt, finishedAt: new Date().toISOString(), failure, artifact: { sha256: await hashFile(exePath) }, workspace: { baselineHead }, process: { pid: child.pid, stdoutBytes, stderrBytes, resourceSamples } };
  } finally {
    clearInterval(resourceTimer);
    clearInterval(depsTimer);
    await sampleResources();
    renderer?.close();
    if (!exited) {
      await execFile("taskkill", ["/PID", String(child.pid), "/T"], { windowsHide: true }).catch(() => {});
      await delay(2_000);
      if (!exited) await execFile("taskkill", ["/F", "/PID", String(child.pid), "/T"], { windowsHide: true }).catch(() => {});
    }
    await delay(1_000);
    for (const entry of await readdir(worktreesRoot).catch(() => [])) {
      if (!/^wt-[a-z0-9]+$/i.test(entry)) continue;
      const target = path.resolve(worktreesRoot, entry);
      if (!insideRoot(target)) continue;
      try {
        await execFile("git", ["-c", "core.longpaths=true", "worktree", "remove", "--force", target], { cwd: root, timeout: 30_000 });
        cleanup.removedWorktrees.push(entry);
      } catch (error) {
        cleanup.worktreeRemovalFailures.push({ worktree: entry, error: String(error.message ?? error).slice(0, 200) });
      }
    }
    if (workspaceDependencyLinkCreated) await unlink(workspaceDependencyLink).catch(() => {});
    await unlink(worktreeDependencyLink).catch(() => {});
    const resolvedProfile = path.resolve(profile);
    const profileRelative = path.relative(path.resolve(profileRoot), resolvedProfile);
    if (profileRelative && !profileRelative.startsWith("..") && !path.isAbsolute(profileRelative)) {
      cleanup.profileRemoved = await rm(resolvedProfile, { recursive: true, force: true }).then(() => true, () => false);
    }
  }
  result.cleanup = cleanup;
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ output, status: result.run?.status ?? "no_run", failure, completion: result.run?.completion ?? null, changedFiles: result.workspace?.changedFiles ?? [] }));
  if (failure || result.run?.status !== "completed" || result.run.completion !== "completed" || !result.independentVerification?.passed || !result.independentAcceptance?.passed) process.exitCode = 2;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

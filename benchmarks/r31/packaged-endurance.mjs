#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback, spawn, spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const defaultExecutable = path.join(root, "apps/desktop/release/win-unpacked/CodeForge.exe");
const evidenceRoot = path.join(root, "docs/evidence/r31-production-release-closure/08-endurance");
const r30ArchiveHash = "768b6557819dd527f50dcb3e3e12c09adfcd0f586cd2db19a04e3279986777bd";
const processQuery = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,WorkingSetSize,PrivatePageCount,HandleCount,KernelModeTime,UserModeTime,ReadTransferCount,WriteTransferCount | ConvertTo-Json -Compress -Depth 3";

function option(name, fallback) {
  const flag = process.argv.find((arg) => arg.startsWith(`${name}=`));
  return flag ? flag.slice(name.length + 1) : fallback;
}

function boundedInteger(name, fallback, min, max) {
  const raw = option(name, String(fallback));
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be ${min}..${max}`);
  return value;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sha256(file) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { bytes, sha256: hash.digest("hex") };
}

function within(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function runtimeMetadata(profile, childPid) {
  const metadataPath = path.join(profile, "runtime.json");
  for (let attempt = 0; attempt < 90; attempt++) {
    try {
      const value = JSON.parse(await readFile(metadataPath, "utf8"));
      if (value.pid === childPid && /^http:\/\/127\.0\.0\.1:\d+$/.test(value.runtimeEndpoint ?? "")) return value;
    } catch {}
    await delay(1000);
  }
  throw new Error("The isolated packaged process did not publish matching runtime metadata within 90 seconds.");
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
      clearTimeout(pending.timeout);
      if (message.error) pending.reject(new Error(message.error.message ?? "DevTools command failed"));
      else pending.resolve(message.result);
    });
    socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error("DevTools connection closed"));
      }
      this.pending.clear();
    });
  }

  async send(method, params = {}) {
    const id = this.nextId++;
    const response = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`DevTools ${method} timed out`));
      }, 20_000);
      this.pending.set(id, { resolve, reject, timeout });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return response;
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout: 15_000 });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? "Renderer evaluation failed");
    return result.result?.value;
  }

  close() {
    this.socket.close();
  }
}

async function connectRenderer(port, expectedEndpoint) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) });
      const targets = await response.json();
      const page = targets.find((target) => target.type === "page" && target.url?.startsWith("file:") && target.webSocketDebuggerUrl);
      if (page) {
        const debuggerUrl = new URL(page.webSocketDebuggerUrl);
        if (!["127.0.0.1", "localhost"].includes(debuggerUrl.hostname) || Number(debuggerUrl.port) !== port) {
          throw new Error("DevTools target left the isolated loopback port");
        }
        const socket = new WebSocket(debuggerUrl);
        await new Promise((resolve, reject) => {
          socket.addEventListener("open", resolve, { once: true });
          socket.addEventListener("error", reject, { once: true });
        });
        const session = new DevToolsSession(socket);
        await session.send("Runtime.enable");
        const rendererEndpoint = await session.evaluate("window.electronAPI?.getRuntimeEndpoint?.()");
        if (rendererEndpoint === expectedEndpoint) return session;
        session.close();
      }
    } catch {}
    await delay(1000);
  }
  throw new Error("Could not attach to the isolated primary renderer and validate its runtime endpoint.");
}

async function rendererRequest(session, endpoint, pathname, method = "GET", body) {
  const request = {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
  const expression = `fetch(${JSON.stringify(`${endpoint}${pathname}`)}, ${JSON.stringify(request)}).then(async response => ({ status: response.status, body: await response.json().catch(() => null) }))`;
  return session.evaluate(expression);
}

function descendants(allRows, rootPid) {
  const selected = new Map();
  const queue = [rootPid];
  while (queue.length > 0) {
    const parent = queue.pop();
    const row = allRows.find((value) => Number(value.ProcessId) === parent);
    if (row && !selected.has(parent)) selected.set(parent, row);
    for (const child of allRows) {
      const pid = Number(child.ProcessId);
      if (Number(child.ParentProcessId) === parent && !selected.has(pid)) {
        selected.set(pid, child);
        queue.push(pid);
      }
    }
  }
  return [...selected.values()];
}

async function processSample(rootPid, exePath) {
  const { stdout } = await execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command", processQuery], {
    timeout: 20_000,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  const parsed = JSON.parse(stdout.trim() || "[]");
  const allRows = Array.isArray(parsed) ? parsed : [parsed];
  const rootRow = allRows.find((row) => Number(row.ProcessId) === rootPid);
  if (!rootRow) throw new Error(`Launched process ${rootPid} is absent from Win32_Process`);
  if (rootRow.ExecutablePath && path.resolve(rootRow.ExecutablePath).toLowerCase() !== path.resolve(exePath).toLowerCase()) {
    throw new Error("Launched PID no longer belongs to the selected executable");
  }
  const rows = descendants(allRows, rootPid);
  const sum = (field) => rows.reduce((total, row) => total + (Number(row[field]) || 0), 0);
  const byType = (type) => rows.filter((row) => String(row.CommandLine ?? "").includes(`--type=${type}`)).length;
  return {
    processCount: rows.length,
    rendererCount: byType("renderer"),
    utilityCount: byType("utility"),
    gpuCount: byType("gpu-process"),
    shellOrTestChildCount: rows.filter((row) => /^(?:node|cmd|powershell|python|git)\.exe$/i.test(String(row.Name))).length,
    workingSetBytes: sum("WorkingSetSize"),
    privateBytes: sum("PrivatePageCount"),
    handles: sum("HandleCount"),
    cpuTimeMs: (sum("KernelModeTime") + sum("UserModeTime")) / 10_000,
    readBytes: sum("ReadTransferCount"),
    writeBytes: sum("WriteTransferCount"),
    pids: rows.map((row) => Number(row.ProcessId)).sort((a, b) => a - b),
  };
}

async function profileSizes(profile) {
  const sizes = { databaseBytes: 0, logBytes: 0, totalBytes: 0, fileCount: 0 };
  async function walk(directory) {
    for (const item of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const absolute = path.join(directory, item.name);
      if (item.isDirectory()) await walk(absolute);
      else if (item.isFile()) {
        const file = await stat(absolute).catch(() => null);
        if (!file) continue;
        sizes.totalBytes += file.size;
        sizes.fileCount++;
        if (/\.(?:db|sqlite)(?:-(?:wal|shm))?$/i.test(item.name)) sizes.databaseBytes += file.size;
        if (/\.log$/i.test(item.name) || absolute.toLowerCase().includes(`${path.sep}logs${path.sep}`)) sizes.logBytes += file.size;
      }
    }
  }
  await walk(profile);
  return sizes;
}

function slopePerHour(samples, key) {
  if (samples.length < 3) return null;
  const x = samples.map((sample) => sample.elapsedMs / 3_600_000);
  const y = samples.map((sample) => sample.process?.[key]);
  if (y.some((value) => !Number.isFinite(value))) return null;
  const meanX = x.reduce((a, b) => a + b, 0) / x.length;
  const meanY = y.reduce((a, b) => a + b, 0) / y.length;
  const denominator = x.reduce((total, value) => total + (value - meanX) ** 2, 0);
  return denominator === 0 ? null : x.reduce((total, value, index) => total + (value - meanX) * (y[index] - meanY), 0) / denominator;
}

async function main() {
  if (process.platform !== "win32") throw new Error("Packaged endurance requires Windows process telemetry.");
  const minutes = boundedInteger("--minutes", 240, 1, 720);
  const sampleMs = boundedInteger("--sample-ms", 30_000, 1000, 300_000);
  const workloadMs = boundedInteger("--workload-ms", 60_000, 5000, 300_000);
  const mode = option("--mode", "active");
  if (!["active", "observe"].includes(mode)) throw new Error("--mode must be active or observe");
  const exePath = path.resolve(option("--exe", defaultExecutable));
  const asarPath = path.join(path.dirname(exePath), "resources/app.asar");
  const executable = await sha256(exePath);
  const archive = await sha256(asarPath);
  const isR30Artifact = archive.sha256 === r30ArchiveHash;
  if (isR30Artifact && !process.argv.includes("--allow-r30-baseline")) {
    throw new Error("The selected app.asar is the retained R30 artifact; use --allow-r30-baseline for harness calibration only.");
  }
  const runId = randomUUID();
  const evidencePath = path.join(evidenceRoot, `packaged-${new Date().toISOString().replaceAll(":", "-")}-${runId.slice(0, 8)}.json`);
  if (process.argv.includes("--dry-run")) {
    console.log(JSON.stringify({ mode, minutes, sampleMs, workloadMs, exePath, executable, archive, isR30Artifact, evidencePath, launched: false }));
    return;
  }
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codeforge-r31-endurance-"));
  if (!within(os.tmpdir(), tempRoot) || !path.basename(tempRoot).startsWith("codeforge-r31-endurance-")) {
    throw new Error("Isolated endurance directory escaped the system temp root.");
  }
  const profile = path.join(tempRoot, "profile");
  const workspace = path.join(tempRoot, "workspace");
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await mkdir(profile, { recursive: true });
  await writeFile(path.join(workspace, "package.json"), `${JSON.stringify({ name: "codeforge-r31-endurance-fixture", private: true, type: "module" }, null, 2)}\n`);
  await writeFile(path.join(workspace, "src/calc.js"), "export function add(a, b) { return a + b; }\n");
  for (let index = 0; index < 64; index++) {
    await writeFile(path.join(workspace, "src", `module-${index}.js`), `export const baselineSymbol${index} = ${index};\n`);
  }
  const gitInit = spawnSync("git", ["init", "-q"], { cwd: workspace, encoding: "utf8", windowsHide: true });
  if (gitInit.status !== 0) throw new Error(`Could not initialize isolated fixture: ${gitInit.stderr?.trim() ?? "git init failed"}`);
  const devToolsPort = await freePort();
  const runtimeEnv = { ...process.env };
  for (const key of Object.keys(runtimeEnv)) {
    if (/^(?:NODE_PATH|NODE_OPTIONS|ELECTRON_RUN_AS_NODE)$/i.test(key) || /(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|CLIENT_SECRET|PASSWORD|CSC_LINK)/i.test(key)) delete runtimeEnv[key];
  }
  const child = spawn(exePath, [
    `--user-data-dir=${profile}`,
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${devToolsPort}`,
  ], { cwd: path.dirname(exePath), env: runtimeEnv, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let exited = false;
  let exitCode = null;
  child.stdout.on("data", (chunk) => { stdoutBytes += chunk.length; });
  child.stderr.on("data", (chunk) => { stderrBytes += chunk.length; });
  child.on("close", (code) => { exited = true; exitCode = code; });
  const startedAt = Date.now();
  const deadline = startedAt + minutes * 60_000;
  const samples = [];
  const cycles = [];
  let metadata;
  let renderer;
  let failure = null;
  let shutdown = "not_started";
  try {
    metadata = await runtimeMetadata(profile, child.pid);
    if (mode === "active") renderer = await connectRenderer(devToolsPort, metadata.runtimeEndpoint);
    const endpoint = metadata.runtimeEndpoint;
    if (renderer) {
      const setWorkspace = await rendererRequest(renderer, endpoint, "/api/workspace/set", "POST", { path: workspace });
      if (setWorkspace.status !== 200) throw new Error(`Packaged runtime refused isolated workspace: HTTP ${setWorkspace.status}`);
      const settings = await rendererRequest(renderer, endpoint, "/api/repository-index/settings", "POST", { enabled: true });
      if (settings.status !== 200) throw new Error(`Packaged runtime refused index settings: HTTP ${settings.status}`);
    }

    const sampleLoop = async () => {
      while (Date.now() < deadline && !exited) {
        const at = Date.now();
        let process = null;
        let processError = null;
        try { process = await processSample(child.pid, exePath); }
        catch (error) { processError = error instanceof Error ? error.message : String(error); }
        const endpointProbe = await fetch(`${endpoint}/api/models`, { signal: AbortSignal.timeout(5000) })
          .then((response) => ({ reachable: true, status: response.status }))
          .catch((error) => ({ reachable: false, error: error instanceof Error ? error.message : String(error) }));
        samples.push({ at: new Date(at).toISOString(), elapsedMs: at - startedAt, process, processError, profile: await profileSizes(profile), endpointProbe });
        await delay(Math.min(sampleMs, Math.max(0, deadline - Date.now())));
      }
    };

    const workloadLoop = async () => {
      if (!renderer) return;
      let iteration = 0;
      while (Date.now() < deadline && !exited) {
        const started = Date.now();
        const symbol = `enduranceSymbol${iteration}`;
        await writeFile(path.join(workspace, "src", "active.js"), `export const ${symbol} = ${iteration};\n`);
        const statuses = {};
        try {
          const tree = await rendererRequest(renderer, endpoint, "/api/workspace/tree");
          statuses.workspaceTree = tree.status;
          const rebuild = await rendererRequest(renderer, endpoint, "/api/repository-index/rebuild", "POST");
          statuses.indexRebuild = rebuild.status;
          let state = "UNKNOWN";
          for (let attempt = 0; attempt < 40; attempt++) {
            const status = await rendererRequest(renderer, endpoint, "/api/repository-index/status");
            statuses.indexStatus = status.status;
            state = status.body?.state ?? "UNKNOWN";
            if (["READY", "ERROR"].includes(state)) break;
            await delay(250);
          }
          statuses.indexState = state;
          const search = await rendererRequest(renderer, endpoint, `/api/repository-index/search?q=${symbol}`);
          statuses.search = search.status;
          statuses.searchFound = JSON.stringify(search.body).includes(symbol);
          const activity = await rendererRequest(renderer, endpoint, "/api/activity/overview?period=all");
          statuses.activity = activity.status;
          const sessions = await rendererRequest(renderer, endpoint, "/api/sessions");
          statuses.sessions = sessions.status;
          const git = await renderer.evaluate(`window.electronAPI.execCommand(${JSON.stringify({ command: "git", args: ["status", "--short"], cwd: workspace })})`);
          statuses.gitExitCode = git?.exitCode;
          const runtime = await renderer.evaluate("window.electronAPI.getRuntimeStatus()");
          statuses.runtime = runtime && {
            activeWorkflows: runtime.activeWorkflows,
            activeAgentTurns: runtime.activeAgentTurns,
            activeCommands: runtime.activeCommands,
            pendingApprovals: runtime.pendingApprovals,
            activeVerifications: runtime.activeVerifications,
            hostedContinuations: runtime.hostedContinuations,
            backgroundTasks: runtime.backgroundTasks,
            discoveringProviders: runtime.discoveringProviders,
          };
          statuses.passed = statuses.workspaceTree === 200 && statuses.indexRebuild === 202 && state === "READY" &&
            statuses.search === 200 && statuses.searchFound && statuses.activity === 200 && statuses.sessions === 200 && statuses.gitExitCode === 0;
        } catch (error) {
          statuses.error = error instanceof Error ? error.message : String(error);
          statuses.passed = false;
        }
        cycles.push({ iteration, at: new Date(started).toISOString(), elapsedMs: started - startedAt, durationMs: Date.now() - started, ...statuses });
        iteration++;
        await delay(Math.min(workloadMs, Math.max(0, deadline - Date.now())));
      }
    };

    await Promise.all([sampleLoop(), workloadLoop()]);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    renderer?.close();
    if (!exited && Number.isInteger(child.pid)) {
      await execFile("taskkill", ["/PID", String(child.pid), "/T"], { windowsHide: true, timeout: 15_000 }).catch(() => {});
      const until = Date.now() + 10_000;
      while (!exited && Date.now() < until) await delay(250);
      shutdown = exited ? "taskkill_tree" : "forced_taskkill_tree";
      if (!exited) await execFile("taskkill", ["/F", "/PID", String(child.pid), "/T"], { windowsHide: true, timeout: 15_000 }).catch(() => {});
    } else {
      shutdown = "process_exited_before_stop";
    }
    await delay(1000);
    let leftoverPids = [];
    try { leftoverPids = (await processSample(child.pid, exePath)).pids; } catch {}
    const processSamples = samples.filter((sample) => sample.process);
    const telemetryFailures = samples.filter((sample) => sample.processError).length;
    const elapsedMs = Date.now() - startedAt;
    const result = {
      schema: "r31-packaged-endurance-1",
      recordedAt: new Date().toISOString(),
      runId,
      binary: { executable: { path: path.relative(root, exePath).replaceAll("\\", "/"), ...executable }, archive: { path: path.relative(root, asarPath).replaceAll("\\", "/"), ...archive }, isR30Artifact },
      design: { mode, minutesBudgeted: minutes, sampleEveryMs: sampleMs, workloadEveryMs: workloadMs, isolation: "fresh temporary userData profile and disposable git fixture; only loopback DevTools and runtime endpoints", realProviderRequestsEnabled: false },
      runtime: metadata ? { pid: metadata.pid, version: metadata.applicationVersion, endpointWasLoopback: true } : null,
      outcome: {
        elapsedMs,
        metBudget: elapsedMs >= minutes * 60_000,
        processAliveThroughWindow: !exited || shutdown !== "process_exited_before_stop",
        processSamples: processSamples.length,
        telemetryFailures,
        activeCycles: cycles.length,
        passedActiveCycles: cycles.filter((cycle) => cycle.passed).length,
        endpoint401Count: samples.filter((sample) => sample.endpointProbe?.status === 401).length,
        endpointUnexpectedCount: samples.filter((sample) => sample.endpointProbe?.reachable && sample.endpointProbe.status !== 401).length,
        leftoverPids,
        childExitCode: exitCode,
        shutdown,
        failure,
      },
      trendsPerHour: {
        workingSetBytes: slopePerHour(processSamples, "workingSetBytes"),
        privateBytes: slopePerHour(processSamples, "privateBytes"),
        handles: slopePerHour(processSamples, "handles"),
        processCount: slopePerHour(processSamples, "processCount"),
      },
      streamBytes: { stdout: stdoutBytes, stderr: stderrBytes },
      samples,
      cycles,
      coverage: {
        packagedRuntimeAndRenderer: mode === "active" && cycles.length > 0,
        repositoryReadsAndIndexing: cycles.some((cycle) => cycle.passed),
        authenticatedControlPlaneFromPrimaryRenderer: cycles.some((cycle) => cycle.sessions === 200),
        gitReadThroughDesktopBridge: cycles.some((cycle) => cycle.gitExitCode === 0),
        realProviderRequests: false,
        autonomousTaskCompletion: false,
        terminalAndTestExecution: false,
        appRestartAndResume: false,
      },
    };
    await mkdir(evidenceRoot, { recursive: true });
    await writeFile(evidencePath, `${JSON.stringify(result, null, 2)}\n`);
    if (leftoverPids.length === 0 && within(os.tmpdir(), tempRoot) && path.basename(tempRoot).startsWith("codeforge-r31-endurance-")) {
      await rm(tempRoot, { recursive: true, force: true });
    }
    const passed = !failure && result.outcome.metBudget && result.outcome.processSamples >= 2 && telemetryFailures === 0 &&
      result.outcome.endpoint401Count === samples.length && leftoverPids.length === 0 &&
      (mode === "observe" || cycles.length > 0 && cycles.every((cycle) => cycle.passed));
    console.log(JSON.stringify({ evidencePath, passed, elapsedMs, samples: samples.length, activeCycles: cycles.length, passedActiveCycles: result.outcome.passedActiveCycles, telemetryFailures, leftoverPids, failure }));
    if (!passed) process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

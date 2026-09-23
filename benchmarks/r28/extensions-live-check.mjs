// R28 extensions live check — exercises the real ExtensionManager + ExtensionHost
// end-to-end: dev-load, activation, command execution, settings/secrets/workspace/
// notification delegates, permission gates inside the vm sandbox, disable/enable,
// managed-dir discovery, engine gating, broken-manifest containment, uninstall.
//
//   node benchmarks/r28/extensions-live-check.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExtensionManager } from "@codeforge/plugins";

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + String(detail).slice(0, 150) : ""}`); };

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cf-ext-live-"));
const extensionsDir = path.join(scratch, "extensions");
const stateFile = path.join(scratch, "extensions-state.json");
const secrets = new Map();
const notifications = [];

const stateStore = {
  load: () => (fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : {}),
  save: (records) => fs.writeFileSync(stateFile, JSON.stringify(records, null, 2)),
};
const secretStore = {
  get: async (ext, key) => secrets.get(`${ext}:${key}`),
  set: async (ext, key, v) => secrets.set(`${ext}:${key}`, v),
  delete: async (ext, key) => secrets.delete(`${ext}:${key}`),
  deleteAll: async (ext) => { for (const k of [...secrets.keys()]) if (k.startsWith(`${ext}:`)) secrets.delete(k); },
};
const workspace = { name: "r28-live-ws", rootPath: "G:\\CodeForge" };

const manager = new ExtensionManager({
  extensionsDir,
  stateStore,
  secretStore,
  appVersion: "0.4.0",
  delegates: {
    appVersion: "0.4.0",
    getWorkspaceInfo: () => workspace,
    showNotification: (_id, title, body) => notifications.push({ title, body }),
    log: () => {},
  },
});

const fixtureDir = path.resolve("benchmarks/r28/ext-fixture/r28.lifecycle");
const brokenDir = path.resolve("benchmarks/r28/ext-fixture/r28.broken");

// 1. start() with empty managed dir
await manager.start();
check("start with empty managed dir", manager.list().length === 0, `${manager.list().length} extensions`);

// 2. Dev-load the fixture → activates, commands registered
const load = await manager.loadDeveloperExtension(fixtureDir);
const ext = manager.list().find((e) => e.id === "r28.lifecycle");
check("dev-load activates fixture", load.ok === true && ext?.status === "active", `status=${ext?.status}${ext?.lastError ? " err=" + ext.lastError : ""}`);
check("commands bridged from manifest", ext?.commands?.length === 7, `${ext?.commands?.length} commands`);

// 3. Command execution through the real vm sandbox
const parse = (r) => { try { return JSON.parse(r); } catch { return r; } };
const ping = await manager.runCommand("r28.lifecycle", "r28.lifecycle.ping");
check("command executes in sandbox", ping.ok && parse(ping.result) === "PONG", ping.result ?? ping.error);
const ws = await manager.runCommand("r28.lifecycle", "r28.lifecycle.ws");
check("workspace:read delegate injected", ws.ok && parse(parse(ws.result)).name === "r28-live-ws", ws.result ?? ws.error);

// 4. Settings + secrets round-trips through real delegates
const settings = await manager.runCommand("r28.lifecycle", "r28.lifecycle.settingsRoundTrip");
check("settings round-trip through persisted store", settings.ok && parse(settings.result) === "mode=b", settings.result ?? settings.error);
check("manager.getSetting reflects persisted value", manager.getSetting("r28.lifecycle", "mode") === "b", JSON.stringify(manager.getSetting("r28.lifecycle", "mode")));
const sec = await manager.runCommand("r28.lifecycle", "r28.lifecycle.secretRoundTrip");
check("sealed secrets round-trip", sec.ok && parse(sec.result) === "SECRET_OK", sec.result ?? sec.error);

// 5. Permission gates inside the sandbox
const rogueS = await manager.runCommand("r28.lifecycle", "r28.lifecycle.rogueSetting");
check("undeclared setting write refused", !rogueS.ok || rogueS.result !== "SHOULD_NOT_REACH", (rogueS.error ?? rogueS.result ?? "").slice(0, 100));
const rogueC = await manager.runCommand("r28.lifecycle", "r28.lifecycle.rogueCommand");
check("undeclared command registration refused", !rogueC.ok || rogueC.result !== "SHOULD_NOT_REACH", (rogueC.error ?? rogueC.result ?? "").slice(0, 100));
const probe = await manager.runCommand("r28.lifecycle", "r28.lifecycle.sandboxProbe");
const probeData = probe.ok ? parse(parse(probe.result)) : {};
check("sandbox has no process/require/fs", probeData.process === "undefined" && probeData.require === "undefined" && probeData.fs === "undefined", probe.result?.slice(0, 120));

// 6. Undeclared-command run refused; disabled extension refuses commands
const missing = await manager.runCommand("r28.lifecycle", "r28.lifecycle.nothere");
check("unregistered command id errors", !missing.ok, missing.error?.slice(0, 80));
await manager.setEnabled("r28.lifecycle", false);
const offPing = await manager.runCommand("r28.lifecycle", "r28.lifecycle.ping");
check("disabled extension refuses commands", !offPing.ok, offPing.error?.slice(0, 80));
await manager.setEnabled("r28.lifecycle", true);
const onPing = await manager.runCommand("r28.lifecycle", "r28.lifecycle.ping");
check("re-enable restores commands", onPing.ok && parse(onPing.result) === "PONG", onPing.result ?? onPing.error);

// 7. Broken manifest is contained, never crashes the manager
const broken = await manager.loadDeveloperExtension(brokenDir);
check("broken manifest contained as error", broken.ok === false && typeof broken.error === "string", (broken.error ?? "").slice(0, 100));

// 8. Engine gate: a fixture requiring >=99.0.0 must not activate
const engineDir = path.join(scratch, "engine-gated");
fs.mkdirSync(engineDir, { recursive: true });
fs.writeFileSync(path.join(engineDir, "codeforge-extension.json"), JSON.stringify({
  id: "r28.gated", name: "Gated", version: "1.0.0", engines: { codeforge: ">=99.0.0" },
  main: "extension.js", permissions: ["commands:register"],
  contributes: { commands: [{ id: "r28.gated.x", title: "X" }] },
}));
fs.writeFileSync(path.join(engineDir, "extension.js"), "module.exports.activate=()=>{};");
const gated = await manager.loadDeveloperExtension(engineDir);
check("engine-incompatible extension refused", gated.ok === false, (gated.error ?? "").slice(0, 80));

// 9. Managed-dir discovery: copy fixture into extensionsDir and start a fresh manager
const managedTarget = path.join(extensionsDir, "r28.managed");
fs.mkdirSync(managedTarget, { recursive: true });
fs.copyFileSync(path.join(fixtureDir, "codeforge-extension.json"), path.join(managedTarget, "codeforge-extension.json"));
fs.writeFileSync(path.join(managedTarget, "extension.js"), 'module.exports.activate=(c)=>{c.commands.register("r28.managed.hello",()=>"MANAGED_OK")};');
const managedManifest = JSON.parse(fs.readFileSync(path.join(managedTarget, "codeforge-extension.json"), "utf8"));
managedManifest.id = "r28.managed";
managedManifest.contributes.commands = [{ id: "r28.managed.hello", title: "Hello" }];
fs.writeFileSync(path.join(managedTarget, "codeforge-extension.json"), JSON.stringify(managedManifest));

const manager2 = new ExtensionManager({
  extensionsDir, stateStore, secretStore, appVersion: "0.4.0",
  delegates: { appVersion: "0.4.0", getWorkspaceInfo: () => workspace, showNotification: () => {}, log: () => {} },
});
await manager2.start();
const managed = manager2.list().find((e) => e.id === "r28.managed");
check("managed-dir extension discovered + activated on start", managed?.status === "active", `status=${managed?.status}`);
const managedCmd = await manager2.runCommand("r28.managed", "r28.managed.hello");
check("managed extension command runs", managedCmd.ok && parse(managedCmd.result) === "MANAGED_OK", managedCmd.result ?? managedCmd.error);

// 10. Persistence across manager instances + devMode record survives restart
const devExt = manager2.list().find((e) => e.id === "r28.lifecycle");
check("dev-load record persisted across manager instances", devExt !== undefined && devExt.devMode === true, `devMode=${devExt?.devMode} status=${devExt?.status}`);

// 11. Uninstall: record gone, managed copy removed, secrets purged
await secrets.set("r28.managed:token", "x");
const uninstalled = await manager2.uninstall("r28.managed");
check("uninstall removes record + managed copy", uninstalled === true && !manager2.list().some((e) => e.id === "r28.managed") && !fs.existsSync(managedTarget), `exists=${fs.existsSync(managedTarget)}`);
check("uninstall purges sealed secrets", !secrets.has("r28.managed:token"), "secret removed");

await manager.stop();
await manager2.stop();

const passed = results.filter((r) => r.ok).length;
console.log(`\nEXTENSIONS_LIVE_CHECK ${passed}/${results.length} PASS`);
fs.writeFileSync("docs/evidence/r28-capability-completion/R28-EXTENSIONS-LIVE-EVIDENCE.json", JSON.stringify({
  schema: "r28-extensions-live-check-1",
  recordedAt: new Date().toISOString(),
  fixture: "benchmarks/r28/ext-fixture/r28.lifecycle (vm sandbox, real delegates)",
  results,
}, null, 2) + "\n");
process.exit(passed === results.length ? 0 : 1);

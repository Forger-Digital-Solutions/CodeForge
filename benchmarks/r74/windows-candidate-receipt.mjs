import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, statSync, existsSync, readdirSync } from "node:fs";
import { resolve, relative, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractFile, listPackage } from "@electron/asar";

const root = fileURLToPath(new URL("../../", import.meta.url));
const evidence = resolve(root, "docs/evidence/r74-autonomous-completion-and-free-reliability");
const artifact = resolve(process.argv[2] ?? join(root, "apps/desktop/release-r74-final/win-unpacked"));
const frozenRevision = process.argv[3];
if (!/^[a-f0-9]{40}$/.test(frozenRevision ?? "")) throw new Error("Pass the frozen 40-character source SHA as the second argument.");
const receiptPrefix = process.argv[4] ?? frozenRevision.slice(0, 12);
if (!/^[a-zA-Z0-9_-]+$/.test(receiptPrefix)) throw new Error("Receipt prefix must contain only letters, digits, underscores, and hyphens.");
const receiptName = (name, extension) => `windows-${name}-${receiptPrefix}.${extension}`;
const run = (program, args) => spawnSync(program, args, { cwd: root, encoding: "utf8", windowsHide: true });
const git = (...args) => {
  const result = run("git", ["-c", "core.fsmonitor=false", ...args]);
  if (result.status !== 0) throw new Error(`git inspection failed: ${result.stderr}`);
  return result.stdout.trim();
};
const head = git("rev-parse", "HEAD");
if (head !== frozenRevision) throw new Error(`Current HEAD ${head} differs from frozen source ${frozenRevision}.`);
const archive = join(artifact, "resources/app.asar");
if (!existsSync(archive)) throw new Error(`No archive at ${archive}`);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fileReceipt = (path, file = relative(artifact, path).replaceAll("\\", "/")) => ({ file, path, bytes: statSync(path).size, sha256: hash(readFileSync(path)) });
const readEntry = (entry) => {
  for (const spelling of [entry, entry.replaceAll("/", "\\")]) {
    try { return extractFile(archive, spelling); } catch { /* ASAR accepts platform-specific separators. */ }
  }
  throw new Error(`Archive entry missing: ${entry}`);
};
const audits = [];
for (const [name, script, args] of [
  ["build-identity", "audit-packaged-build-identity.mjs", ["--require-clean"]],
  ["internal-dependencies", "audit-packaged-internal-dependencies.mjs", []],
  ["runtime-dependencies", "audit-packaged-runtime-dependencies.mjs", []],
  ["browser-security", "audit-packaged-browser-security.mjs", []],
  ["auth-endpoint", "audit-packaged-auth-endpoint.mjs", ["--channel", "development", "--mode", "smoke", "--expected-url", "http://127.0.0.1:3220"]],
]) {
  const result = run(process.execPath, [join(root, "apps/desktop/scripts", script), artifact, ...args]);
  const log = receiptName(name, "log");
  writeFileSync(join(evidence, log), `${result.stdout ?? ""}${result.stderr ?? ""}`, "utf8");
  audits.push({ name, log, exitCode: result.status, passed: result.status === 0, error: result.error?.message });
}
const included = [];
for (const [source, entry] of [
  ["packages/providers/dist/capacity-governor.js", "node_modules/@codeforge/providers/dist/capacity-governor.js"],
  ["packages/model-registry/dist/bundled-role-evidence.js", "node_modules/@codeforge/model-registry/dist/bundled-role-evidence.js"],
  ["packages/model-registry/dist/bundled-role-evidence.json", "node_modules/@codeforge/model-registry/dist/bundled-role-evidence.json"],
  ["packages/server/dist/role-output-budget.js", "node_modules/@codeforge/server/dist/role-output-budget.js"],
  ["packages/eight-bit/dist/qualification/role-protocols.js", "node_modules/@codeforge/eight-bit/dist/qualification/role-protocols.js"],
  ["packages/eight-bit/dist/qualification/persistence.js", "node_modules/@codeforge/eight-bit/dist/qualification/persistence.js"],
  ["packages/eight-bit/dist/role-quality.js", "node_modules/@codeforge/eight-bit/dist/role-quality.js"],
  ["packages/providers/dist/blockrun-free.js", "node_modules/@codeforge/providers/dist/blockrun-free.js"],
  ["packages/providers/dist/openai-compatible.js", "node_modules/@codeforge/providers/dist/openai-compatible.js"],
  ["packages/providers/dist/provider-factory.js", "node_modules/@codeforge/providers/dist/provider-factory.js"],
  ["packages/providers/dist/puter.js", "node_modules/@codeforge/providers/dist/puter.js"],
  ["packages/providers/dist/openrouter.js", "node_modules/@codeforge/providers/dist/openrouter.js"],
  ["packages/providers/dist/openrouter-entitlement.js", "node_modules/@codeforge/providers/dist/openrouter-entitlement.js"],
  ["packages/providers/dist/openrouter-oauth.js", "node_modules/@codeforge/providers/dist/openrouter-oauth.js"],
  ["packages/model-registry/dist/blockrun-policy-reverification.js", "node_modules/@codeforge/model-registry/dist/blockrun-policy-reverification.js"],
  ["packages/model-registry/dist/free-cloud-service.js", "node_modules/@codeforge/model-registry/dist/free-cloud-service.js"],
  ["packages/server/dist/autonomous-orchestrator.js", "node_modules/@codeforge/server/dist/autonomous-orchestrator.js"],
  ["packages/server/dist/subagent-manager.js", "node_modules/@codeforge/server/dist/subagent-manager.js"],
  ["packages/protocol/dist/subagent-runtime.js", "node_modules/@codeforge/protocol/dist/subagent-runtime.js"],
  ["packages/server/dist/agent-runtime.js", "node_modules/@codeforge/server/dist/agent-runtime.js"],
  ["packages/server/dist/reviewer-evidence.js", "node_modules/@codeforge/server/dist/reviewer-evidence.js"],
  ["packages/server/dist/model-execution-adapter.js", "node_modules/@codeforge/server/dist/model-execution-adapter.js"],
  ["packages/server/dist/index.js", "node_modules/@codeforge/server/dist/index.js"],
  ["packages/server/dist/user-intelligence.js", "node_modules/@codeforge/server/dist/user-intelligence.js"],
  ["packages/server/dist/forgeauto-roster.js", "node_modules/@codeforge/server/dist/forgeauto-roster.js"],
  ["packages/server/dist/personal-account-policy.js", "node_modules/@codeforge/server/dist/personal-account-policy.js"],
  ["packages/server/dist/personal-free-capacity.js", "node_modules/@codeforge/server/dist/personal-free-capacity.js"],
  ["packages/forge-zero/dist/capacity-independence.js", "node_modules/@codeforge/forge-zero/dist/capacity-independence.js"],
  ["packages/forge-zero/dist/capacity-forecast.js", "node_modules/@codeforge/forge-zero/dist/capacity-forecast.js"],
  ["packages/forge-zero/dist/capacity-reservations.js", "node_modules/@codeforge/forge-zero/dist/capacity-reservations.js"],
  ["packages/secrets/dist/index.js", "node_modules/@codeforge/secrets/dist/index.js"],
  ["packages/agent/dist/index.js", "node_modules/@codeforge/agent/dist/index.js"],
  ["packages/eight-bit/dist/qualification/role-suite.js", "node_modules/@codeforge/eight-bit/dist/qualification/role-suite.js"],
  ["apps/desktop/dist/provider-connections.js", "apps/desktop/dist/provider-connections.js"],
  ["apps/desktop/dist/openrouter-oauth-flow.js", "apps/desktop/dist/openrouter-oauth-flow.js"],
  ["apps/desktop/dist/main.js", "apps/desktop/dist/main.js"],
  ["apps/desktop/dist/connected-accounts.js", "apps/desktop/dist/connected-accounts.js"],
  ["apps/desktop/dist/paid-request-estimates.js", "apps/desktop/dist/paid-request-estimates.js"],
  ["apps/desktop/dist/provider-account-qualification.js", "apps/desktop/dist/provider-account-qualification.js"],
  ["apps/desktop/dist/connected-account-types.js", "apps/desktop/dist/connected-account-types.js"],
  ["apps/desktop/dist/provider-account-routing.js", "apps/desktop/dist/provider-account-routing.js"],
  ["apps/desktop/dist/preload.cjs", "apps/desktop/dist/preload.cjs"],
]) {
  const compiled = readFileSync(join(root, source));
  const packaged = readEntry(entry);
  included.push({ source, entry, bytes: packaged.length, sha256: hash(packaged), compiledSha256: hash(compiled), matchesFrozenBuildOutput: packaged.equals(compiled) });
}
const rendererAccountControls = [];
for (const rawEntry of listPackage(archive)) {
  const entry = rawEntry.replaceAll("\\", "/").replace(/^\//, "");
  if (!/^apps\/desktop\/dist\/renderer\/assets\/index-[^/]+\.js$/.test(entry)) continue;
  const compiled = readFileSync(join(root, entry));
  const packaged = readEntry(entry);
  included.push({ source: entry, entry, bytes: packaged.length, sha256: hash(packaged), compiledSha256: hash(compiled), matchesFrozenBuildOutput: packaged.equals(compiled) });
  const source = packaged.toString("utf8");
  rendererAccountControls.push({ entry, controls: ["Your connected accounts", "Save account preferences", "Permit paid account routing", "Paid request estimate", "Qualify selected personal model"].map((label) => ({ label, present: source.includes(label) })) });
}
const nativeRoot = join(artifact, "resources/app.asar.unpacked/node_modules");
const nativeFiles = [];
const visit = (directory) => {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) visit(path);
    else if (/\.(?:node|dll|exe)$/i.test(entry.name)) nativeFiles.push(fileReceipt(path));
  }
};
visit(nativeRoot);
const signaturePath = join(artifact, "CodeForge.exe").replaceAll("'", "''");
const signature = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$r74Signature = Get-AuthenticodeSignature -LiteralPath '${signaturePath}'; [pscustomobject]@{ Status = [string]$r74Signature.Status; StatusMessage = $r74Signature.StatusMessage; Path = $r74Signature.Path; SignerSubject = $r74Signature.SignerCertificate.Subject } | ConvertTo-Json -Depth 3`]);
let signatureReceipt;
try {
  const parsed = JSON.parse(signature.stdout);
  const statuses = ["Valid", "UnknownError", "NotSigned", "HashMismatch", "NotTrusted", "NotSupportedFileFormat", "Incompatible"];
  if (signature.status !== 0 || !statuses.includes(parsed.Status) || typeof parsed.Path !== "string" || resolve(parsed.Path) !== resolve(join(artifact, "CodeForge.exe"))) throw new Error("Signature subprocess returned no authoritative file status.");
  signatureReceipt = { ...parsed, method: "Subprocess powershell.exe Get-AuthenticodeSignature" };
} catch (error) {
  signatureReceipt = { Status: "UNAVAILABLE", method: "Subprocess powershell.exe Get-AuthenticodeSignature", exitCode: signature.status,
    stdout: signature.stdout, stderr: signature.stderr, error: signature.error?.message ?? (error instanceof Error ? error.message : String(error)) };
}
writeFileSync(join(evidence, receiptName("signature", "json")), `${JSON.stringify(signatureReceipt, null, 2)}\n`);
const stamp = JSON.parse(readEntry("apps/desktop/dist/build-identity.json").toString("utf8"));
const dependencyVersions = {};
for (const name of ["electron", "electron-builder", "@electron/asar", "better-sqlite3", "node-pty", "electron-updater", "typescript", "vite"]) {
  dependencyVersions[name] = JSON.parse(readFileSync(join(root, "node_modules", name, "package.json"))).version;
}
const receipt = {
  observedAt: new Date().toISOString(), sourceRevision: frozenRevision, artifact, receiptPrefix, signatureReceiptFile: receiptName("signature", "json"),
  sourceIdentity: stamp, sourceTrackedStatusAtAudit: git("status", "--porcelain", "--untracked-files=no"),
  node: process.version, dependencyVersions, packageLockSha256: hash(readFileSync(join(root, "package-lock.json"))),
  files: [fileReceipt(join(artifact, "CodeForge.exe")), fileReceipt(archive)], nativeFiles,
  archiveEntries: listPackage(archive).length, included, rendererAccountControls, audits, signature: signatureReceipt,
  execution: "NOT_EXECUTED_NO_AUTHORIZED_ISOLATED_WINDOWS_ENVIRONMENT", installer: "NOT_BUILT_NOT_CERTIFIED", nativeRebuild: false,
};
writeFileSync(join(evidence, receiptName("artifact-manifest", "json")), `${JSON.stringify(receipt, null, 2)}\n`);
const passed = audits.every((audit) => audit.passed) && included.every((entry) => entry.matchesFrozenBuildOutput)
  && rendererAccountControls.length > 0 && rendererAccountControls.every((bundle) => bundle.controls.every((control) => control.present))
  && stamp.commit === frozenRevision && stamp.dirty === false;
console.log(JSON.stringify({ sourceRevision: frozenRevision, artifact, staticAuditsPassed: audits.filter((audit) => audit.passed).length, includedModules: included.length, nativeFiles: nativeFiles.length, signature: signatureReceipt.Status, passed }, null, 2));
if (!passed) process.exitCode = 1;

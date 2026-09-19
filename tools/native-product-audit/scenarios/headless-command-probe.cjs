// Runs a command through the INSTALLED app's own execution path (the packaged @codeforge/terminal
// executor + @codeforge/workflow's prepareShellCommand, under the packaged Electron runtime) and
// reports which backend ran it. Driven by Invoke-HeadlessCommandProbe.ps1, which watches for any
// console window (conhost / Windows Terminal / mintty) while this runs.
//
//   ELECTRON_RUN_AS_NODE=1 CodeForge.exe headless-command-probe.cjs <appResources> <cwd> <command> [--mode prepared|shell]
const path = require("node:path");
const [resources, cwd, command, ...rest] = process.argv.slice(2);
const mode = rest.includes("--mode") ? rest[rest.indexOf("--mode") + 1] : "prepared";
if (!resources || !cwd || !command) {
  console.error("usage: headless-command-probe.cjs <appResources> <cwd> <command> [--mode prepared|shell]");
  process.exit(2);
}
const asarModules = path.join(resources, "app.asar", "node_modules", "@codeforge");
// --packages <repoPackagesDir> exercises a not-yet-packaged build of the executor (the repo's
// dist) under the packaged Electron runtime; default is the installed app's own copy.
const packagesDir = rest.includes("--packages") ? rest[rest.indexOf("--packages") + 1] : asarModules;
const terminal = require(path.join(packagesDir, "terminal", "dist", "index.js"));
const workflow = require(path.join(packagesDir, "workflow", "dist", "index.js"));
const execPath = path.join(path.dirname(resources), "CodeForge.exe");

(async () => {
  const started = Date.now();
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  let result;
  let prepared = null;
  if (mode === "shell") {
    result = await terminal.execute({ commandLine: command, cwd, env, timeoutMs: 120_000 });
  } else if (mode === "shell-electron") {
    // The Electron runtime as node, but hosted by the ConPTY's cmd.exe (so its parent owns the
    // pseudo console) instead of being the pty root itself.
    prepared = workflow.prepareShellCommand(command, env, cwd, { execPath, isElectron: true, platform: "win32" });
    const quoted = [prepared.command, ...prepared.args].map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(" ");
    result = await terminal.execute({ commandLine: prepared.shell ? prepared.command : quoted, cwd, env: prepared.env, timeoutMs: 120_000 });
  } else {
    prepared = workflow.prepareShellCommand(command, env, cwd, { execPath, isElectron: true, platform: "win32" });
    result = await terminal.executePrepared(prepared, { cwd, timeoutMs: 120_000 });
  }
  console.log(JSON.stringify({
    command,
    mode,
    backend: result.backend,
    exitCode: result.exitCode,
    durationMs: Date.now() - started,
    spawnError: result.spawnError ?? null,
    prepared: prepared ? { command: prepared.command, args: prepared.args, runtimeKind: prepared.runtimeKind, shell: prepared.shell } : null,
    outputTail: result.output.slice(-400),
  }));
  process.exit(0);
})().catch((error) => {
  console.log(JSON.stringify({ command, mode, error: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
});

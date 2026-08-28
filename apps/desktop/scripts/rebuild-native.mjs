import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(desktopRoot, "..", "..");
const electronRebuildCli = path.join(repositoryRoot, "node_modules", "@electron", "rebuild", "lib", "cli.js");
const windowsPathLimit = 2_048;

function compactPath(source) {
  const runtimeDirectory = path.dirname(process.execPath);
  const systemRoot = source.SystemRoot ?? source.WINDIR ?? "C:\\Windows";
  const candidates = [runtimeDirectory, path.join(systemRoot, "System32"), systemRoot];
  const original = source.PATH ?? source.Path ?? source.path ?? "";
  const originalEntries = original.split(path.delimiter);
  const buildToolEntries = originalEntries.filter((entry) =>
    /(?:nodejs|python|visual studio|windows kits|git[\\/]cmd)/i.test(entry),
  );
  candidates.push(...buildToolEntries, ...originalEntries);

  const seen = new Set();
  const result = [];
  let length = 0;
  for (const raw of candidates) {
    const entry = raw.trim().replace(/^"|"$/g, "").replace(/[\\/]+$/, "");
    if (!entry) continue;
    const key = process.platform === "win32" ? entry.toLowerCase() : entry;
    if (seen.has(key)) continue;
    const addition = entry.length + (result.length ? 1 : 0);
    if (length + addition > windowsPathLimit) continue;
    seen.add(key);
    result.push(entry);
    length += addition;
  }
  return result.join(path.delimiter);
}

function createBuildEnvironment(source) {
  const allowed = [
    "APPDATA", "CI", "COMSPEC", "CommonProgramFiles", "CommonProgramFiles(x86)",
    "CommonProgramW6432", "HOME", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA",
    "NUMBER_OF_PROCESSORS", "PATHEXT", "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER",
    "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "SystemDrive", "SystemRoot",
    "TEMP", "TMP", "TMPDIR", "USERNAME", "USERPROFILE", "WINDIR",
  ];
  const env = {};
  for (const key of allowed) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  env.PATH = compactPath(source);
  env.npm_config_loglevel = "warn";
  if (source.npm_config_cache) env.npm_config_cache = source.npm_config_cache;
  if (source.ELECTRON_CACHE) env.ELECTRON_CACHE = source.ELECTRON_CACHE;
  if (source.ELECTRON_GYP_CACHE) env.ELECTRON_GYP_CACHE = source.ELECTRON_GYP_CACHE;
  return env;
}

const result = spawnSync(process.execPath, [
  electronRebuildCli,
  "-v", "33.4.11",
  "-f",
  "-o", "better-sqlite3",
  "--build-from-source",
], {
  cwd: repositoryRoot,
  env: createBuildEnvironment(process.env),
  stdio: "inherit",
  windowsHide: true,
});

if (result.error) {
  console.error(`Native rebuild failed to launch: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);

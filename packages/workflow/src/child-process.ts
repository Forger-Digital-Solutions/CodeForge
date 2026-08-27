import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const WINDOWS_PATH_LIMIT = 8_000;
const TERMINATION_GRACE_MS = 2_000;

export interface RuntimeContext {
  execPath?: string;
  isElectron?: boolean;
  platform?: NodeJS.Platform;
}

export interface PreparedShellCommand {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  runtimeKind: "node" | "electron-as-node" | "shell";
  shell: boolean;
}

export function quoteShellArgument(value: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    if (value.includes('"')) throw new Error("Runtime path contains an unsupported quote character");
    return `"${value}"`;
  }
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function readPath(env: NodeJS.ProcessEnv): string {
  return env.PATH ?? env.Path ?? env.path ?? "";
}

function normalizeWindowsPath(env: NodeJS.ProcessEnv, runtimeDirectory: string): NodeJS.ProcessEnv {
  const result = { ...env };
  const original = readPath(env);
  const entries = [runtimeDirectory, ...original.split(";")];
  const seen = new Set<string>();
  const kept: string[] = [];
  let length = 0;

  for (const raw of entries) {
    const entry = raw.trim().replace(/^"|"$/g, "");
    if (!entry) continue;
    const key = entry.toLowerCase();
    if (seen.has(key)) continue;
    const addition = entry.length + (kept.length > 0 ? 1 : 0);
    if (length + addition > WINDOWS_PATH_LIMIT) continue;
    seen.add(key);
    kept.push(entry);
    length += addition;
  }

  for (const key of Object.keys(result)) {
    if (key.toLowerCase() === "path") delete result[key];
  }
  result.PATH = kept.join(";");
  return result;
}

function resolveNpmCli(
  tool: "npm" | "npx",
  env: NodeJS.ProcessEnv,
  runtimeExecutable: string,
  workspacePath?: string,
): string | undefined {
  const cliName = tool === "npm" ? "npm-cli.js" : "npx-cli.js";
  const candidates: string[] = [];
  if (tool === "npm" && env.npm_execpath) candidates.push(env.npm_execpath);
  if (tool === "npx" && env.npm_execpath) {
    candidates.push(path.join(path.dirname(env.npm_execpath), cliName));
  }
  if (workspacePath) {
    candidates.push(path.join(workspacePath, "node_modules", "npm", "bin", cliName));
  }
  candidates.push(path.join(path.dirname(runtimeExecutable), "node_modules", "npm", "bin", cliName));
  for (const entry of readPath(env).split(path.delimiter)) {
    if (!entry) continue;
    candidates.push(path.join(entry.replace(/^"|"$/g, ""), "node_modules", "npm", "bin", cliName));
  }
  return candidates.find((candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

function parseDirectArguments(input: string, platform: NodeJS.Platform): string[] | undefined {
  const args: string[] = [];
  let current = "";
  let quote: "single" | "double" | null = null;
  let started = false;

  for (let index = 0; index < input.length; index++) {
    const character = input[index] ?? "";
    const next = input[index + 1] ?? "";
    if (quote === "double") {
      if (character === "\\" && next === '"') {
        current += '"';
        index++;
      } else if (character === '"') {
        quote = null;
      } else {
        current += character;
      }
      started = true;
      continue;
    }
    if (quote === "single") {
      if (character === "'" && platform !== "win32") quote = null;
      else current += character;
      started = true;
      continue;
    }
    if (character === '"') {
      quote = "double";
      started = true;
      continue;
    }
    if (character === "'" && platform !== "win32") {
      quote = "single";
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) {
        args.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    if (/[&|<>`]/.test(character) || (platform !== "win32" && /[$()*?{}\[\]]/.test(character))) {
      return undefined;
    }
    current += character;
    started = true;
  }
  if (quote) return undefined;
  if (started) args.push(current);
  return args;
}

export function prepareShellCommand(
  command: string,
  env: NodeJS.ProcessEnv,
  workspacePath?: string,
  context: RuntimeContext = {},
): PreparedShellCommand {
  const platform = context.platform ?? process.platform;
  const runtimeExecutable = path.resolve(context.execPath ?? process.execPath);
  const isElectron = context.isElectron ?? Boolean(process.versions.electron);
  let childEnv = { ...env };
  delete childEnv.ELECTRON_RUN_AS_NODE;

  if (platform === "win32") {
    childEnv = normalizeWindowsPath(childEnv, path.dirname(runtimeExecutable));
  }

  const match = command.match(/^(\s*)(node(?:\.exe)?|npm(?:\.cmd|\.exe)?|npx(?:\.cmd|\.exe)?)(?=\s|$)/i);
  if (!match) return { command, args: [], env: childEnv, runtimeKind: "shell", shell: true };

  const prefix = match[1] ?? "";
  const token = (match[2] ?? "").toLowerCase();
  const tool = token.startsWith("npm") ? "npm" : token.startsWith("npx") ? "npx" : "node";
  const quotedRuntime = quoteShellArgument(runtimeExecutable, platform);
  const remainder = command.slice(match[0].length);
  const directArgs = parseDirectArguments(remainder, platform);

  if (isElectron) childEnv.ELECTRON_RUN_AS_NODE = "1";
  if (tool === "node") {
    if (directArgs) {
      return {
        command: runtimeExecutable,
        args: directArgs,
        env: childEnv,
        runtimeKind: isElectron ? "electron-as-node" : "node",
        shell: false,
      };
    }
    const shellRuntime = platform === "win32" ? `call ${quotedRuntime}` : quotedRuntime;
    return {
      command: `${prefix}${shellRuntime}${remainder}`,
      args: [],
      env: childEnv,
      runtimeKind: isElectron ? "electron-as-node" : "node",
      shell: true,
    };
  }

  const cli = resolveNpmCli(tool, childEnv, runtimeExecutable, workspacePath);
  if (!cli) {
    throw new Error(
      `Unable to resolve ${tool} without relying on shell PATH. Install npm with Node.js or configure an explicit verification command.`,
    );
  }
  if (directArgs) {
    return {
      command: runtimeExecutable,
      args: [cli, ...directArgs],
      env: childEnv,
      runtimeKind: isElectron ? "electron-as-node" : "node",
      shell: false,
    };
  }
  const shellRuntime = platform === "win32" ? `call ${quotedRuntime}` : quotedRuntime;
  return {
    command: `${prefix}${shellRuntime} ${quoteShellArgument(cli, platform)}${remainder}`,
    args: [],
    env: childEnv,
    runtimeKind: isElectron ? "electron-as-node" : "node",
    shell: true,
  };
}

function waitForClose(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function terminateProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) return;

  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
    const taskkill = path.join(systemRoot, "System32", "taskkill.exe");
    const closed = waitForClose(child, TERMINATION_GRACE_MS);
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const killer = spawn(taskkill, ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      const timer = setTimeout(() => {
        try { killer.kill(); } catch {}
        finish();
      }, TERMINATION_GRACE_MS);
      killer.once("error", () => {
        clearTimeout(timer);
        try { child.kill(); } catch {}
        finish();
      });
      killer.once("close", () => {
        clearTimeout(timer);
        finish();
      });
    });
    await closed;
    await new Promise((resolve) => setTimeout(resolve, 50));
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try { child.kill("SIGTERM"); } catch {}
  }
  await waitForClose(child, TERMINATION_GRACE_MS);
  if (child.exitCode === null && child.signalCode === null) {
    try { process.kill(-pid, "SIGKILL"); } catch {
      try { child.kill("SIGKILL"); } catch {}
    }
  }
}

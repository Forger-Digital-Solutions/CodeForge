import { promises as fs, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { FORGE_AAA_ERRORS, ForgeAaaError } from "../types.js";

/**
 * Unreal Engine 4.27 adapter (mission §8). Detection and capability negotiation are real
 * filesystem operations; editor execution is a bounded `UE4Editor-Cmd` process with a hard
 * timeout and captured log tail. UE4.27 is the certified target — a UE5 install negotiates
 * through its own adapter contract, never silently downgraded into this one's assumptions.
 */

export interface UnrealInstall {
  root: string;
  version: { major: number; minor: number; patch: number; changelist?: number; branch?: string };
  editorCmdPath?: string;
  editorPath?: string;
}

export interface UnrealDetection {
  installed: boolean;
  installs: UnrealInstall[];
  probedRoots: string[];
  detectedAt: string;
}

export interface UnrealCapabilities {
  version: string;
  /** Capability flags are negotiated per engine version — never assumed. */
  pythonScripting: "plugin_required" | "builtin" | "unavailable";
  remoteControl: "plugin_required" | "builtin" | "unavailable";
  commandlets: boolean;
  automationTests: boolean;
  fbxImport: boolean;
  editorUtilityWidgets: boolean;
  /** UE5+ installs are out of contract for this adapter. */
  supported: boolean;
  notes: string[];
}

export interface UnrealProjectInfo {
  path: string;
  engineAssociation?: string;
  category?: string;
  plugins: { name: string; enabled: boolean }[];
  targets: string[];
}

export interface UnrealCommandletRequest {
  projectPath: string;
  commandlet: string;
  args?: string[];
  timeoutMs?: number;
  install?: UnrealInstall;
}

export interface UnrealCommandletResult {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  logTail: string;
  logPath?: string;
  error?: string;
}

const UE_DEFAULT_ROOTS = [
  process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "Epic Games") : "C:\\Program Files\\Epic Games",
];
const DEFAULT_CMD_TIMEOUT_MS = 10 * 60_000;
const MAX_LOG_TAIL = 128 * 1024;

export interface UnrealAdapterDeps {
  fileExists?: (p: string) => boolean;
  listDir?: (p: string) => string[];
  readFile?: (p: string) => Promise<string>;
  spawnProcess?: typeof spawn;
  platform?: NodeJS.Platform;
  extraRoots?: string[];
}

export class UnrealAdapter {
  private readonly fileExists: (p: string) => boolean;
  private readonly listDir?: (p: string) => string[];
  private readonly readFile: (p: string) => Promise<string>;
  private readonly spawnProcess: typeof spawn;
  private readonly platform: NodeJS.Platform;
  private readonly extraRoots: string[];

  constructor(deps: UnrealAdapterDeps = {}) {
    this.fileExists = deps.fileExists ?? ((p) => existsSync(p));
    this.listDir = deps.listDir;
    this.readFile = deps.readFile ?? ((p) => fs.readFile(p, "utf8"));
    this.spawnProcess = deps.spawnProcess ?? spawn;
    this.platform = deps.platform ?? process.platform;
    this.extraRoots = deps.extraRoots ?? [];
  }

  private rootDirs(): string[] {
    if (this.platform !== "win32") return ["/opt", "/usr/local", ...this.extraRoots];
    return [...UE_DEFAULT_ROOTS, ...this.extraRoots];
  }

  private engineRoots(): { roots: string[]; probed: string[] } {
    const probed: string[] = [];
    const roots: string[] = [];
    for (const base of this.rootDirs()) {
      probed.push(base);
      for (const entry of this.safeList(base)) {
        if (/^UE_\d+\.\d+/.test(entry) || /^UnrealEngine[-\d.]*/i.test(entry)) {
          const candidate = path.join(base, entry);
          if (this.fileExists(path.join(candidate, "Engine", "Build", "Build.version"))) roots.push(candidate);
        }
      }
    }
    return { roots, probed };
  }

  private safeList(dir: string): string[] {
    try {
      const entries = this.listDir?.(dir);
      if (entries && entries.length > 0) return entries;
    } catch { /* fall through to fs */ }
    try {
      return existsSync(dir) ? readdirSync(dir) : [];
    } catch {
      return [];
    }
  }

  async detect(): Promise<UnrealDetection> {
    const detectedAt = new Date().toISOString();
    const { roots, probed } = this.engineRoots();
    const installs: UnrealInstall[] = [];
    for (const root of roots) {
      const buildVersionPath = path.join(root, "Engine", "Build", "Build.version");
      try {
        const parsed = JSON.parse(await this.readFile(buildVersionPath)) as {
          MajorVersion?: number; MinorVersion?: number; PatchVersion?: number; Changelist?: number; BranchName?: string;
        };
        const binariesDir = path.join(root, "Engine", "Binaries", "Win64");
        const editorCmd = ["UE4Editor-Cmd.exe", "UnrealEditor-Cmd.exe"].map((n) => path.join(binariesDir, n)).find((p) => this.fileExists(p));
        const editor = ["UE4Editor.exe", "UnrealEditor.exe"].map((n) => path.join(binariesDir, n)).find((p) => this.fileExists(p));
        installs.push({
          root,
          version: {
            major: parsed.MajorVersion ?? 0,
            minor: parsed.MinorVersion ?? 0,
            patch: parsed.PatchVersion ?? 0,
            ...(parsed.Changelist !== undefined ? { changelist: parsed.Changelist } : {}),
            ...(parsed.BranchName ? { branch: parsed.BranchName } : {}),
          },
          ...(editorCmd ? { editorCmdPath: editorCmd } : {}),
          ...(editor ? { editorPath: editor } : {}),
        });
      } catch {
        installs.push({ root, version: { major: 0, minor: 0, patch: 0 } });
      }
    }
    return { installed: installs.length > 0, installs, probedRoots: probed, detectedAt };
  }

  /** Explicit engine-version negotiation. UE4.27 supports editor scripting via optional
   *  plugins; nothing here may assume a UE5 API. */
  negotiate(install: UnrealInstall): UnrealCapabilities {
    const { major, minor } = install.version;
    const version = `${major}.${minor}`;
    const notes: string[] = [];
    if (major === 4 && minor === 27) {
      return {
        version,
        pythonScripting: "plugin_required",
        remoteControl: "plugin_required",
        commandlets: install.editorCmdPath !== undefined,
        automationTests: true,
        fbxImport: true,
        editorUtilityWidgets: true,
        supported: true,
        notes: ["UE 4.27 contract: Python Editor Script Plugin and Remote Control are plugin-gated; commandlets are always available."],
      };
    }
    if (major === 4) {
      notes.push(`UE ${version} is not the certified 4.27 target — capabilities negotiated conservatively.`);
      return { version, pythonScripting: "plugin_required", remoteControl: major === 4 && minor >= 26 ? "plugin_required" : "unavailable", commandlets: install.editorCmdPath !== undefined, automationTests: true, fbxImport: true, editorUtilityWidgets: minor >= 26, supported: true, notes };
    }
    return {
      version,
      pythonScripting: "unavailable", remoteControl: "unavailable", commandlets: install.editorCmdPath !== undefined,
      automationTests: false, fbxImport: false, editorUtilityWidgets: false, supported: false,
      notes: [`UE ${version} requires the version-aware UE5+ adapter — this adapter is certified for 4.27 only.`],
    };
  }

  async inspectProject(uprojectPath: string): Promise<UnrealProjectInfo> {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(await this.readFile(uprojectPath)) as Record<string, unknown>;
    } catch (err) {
      throw new ForgeAaaError(FORGE_AAA_ERRORS.MANIFEST_INVALID, `cannot parse .uproject: ${err instanceof Error ? err.message : String(err)}`);
    }
    const plugins = Array.isArray(parsed.Plugins)
      ? (parsed.Plugins as { Name?: unknown; Enabled?: unknown }[]).map((p) => ({ name: String(p.Name ?? ""), enabled: p.Enabled === true })).filter((p) => p.name)
      : [];
    const targets = Array.isArray(parsed.Targets)
      ? (parsed.Targets as { Name?: unknown }[]).map((t) => String(t.Name ?? "")).filter(Boolean)
      : [];
    return {
      path: uprojectPath,
      ...(typeof parsed.EngineAssociation === "string" ? { engineAssociation: parsed.EngineAssociation } : {}),
      ...(typeof parsed.Category === "string" ? { category: parsed.Category } : {}),
      plugins,
      targets,
    };
  }

  /**
   * Bounded commandlet execution (`UE4Editor-Cmd.exe <project> -run=<cmdlet> ...`).
   * Hard timeout + kill; the Saved/Logs tail is captured as evidence. A UE5-shaped install
   * refuses through negotiate() before any process spawns.
   */
  async runCommandlet(req: UnrealCommandletRequest): Promise<UnrealCommandletResult> {
    const install = req.install ?? (await this.detect()).installs.find((i) => i.version.major === 4 && i.version.minor === 27);
    if (!install) throw new ForgeAaaError(FORGE_AAA_ERRORS.ENGINE_NOT_FOUND, "no UE 4.27 install detected");
    const caps = this.negotiate(install);
    if (!caps.supported) throw new ForgeAaaError(FORGE_AAA_ERRORS.ENGINE_VERSION_UNSUPPORTED, `engine ${caps.version} unsupported by the UE 4.27 adapter`);
    if (!install.editorCmdPath) throw new ForgeAaaError(FORGE_AAA_ERRORS.ENGINE_NOT_FOUND, "UE4Editor-Cmd binary not found under Engine/Binaries/Win64");
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(req.commandlet)) {
      throw new ForgeAaaError(FORGE_AAA_ERRORS.OPERATION_DENIED, `commandlet name "${req.commandlet}" is not a safe token`);
    }
    const args = [req.projectPath, `-run=${req.commandlet}`, "-unattended", "-nop4", "-nosplash", ...(req.args ?? [])];
    const started = Date.now();
    const timeoutMs = req.timeoutMs ?? DEFAULT_CMD_TIMEOUT_MS;
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = this.spawnProcess(install.editorCmdPath!, args, { windowsHide: true });
      } catch (err) {
        resolve({ ok: false, exitCode: null, timedOut: false, durationMs: 0, logTail: "", error: err instanceof Error ? err.message : String(err) });
        return;
      }
      let out = "";
      let done = false;
      const finish = (r: Omit<UnrealCommandletResult, "durationMs">) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ ...r, durationMs: Date.now() - started });
      };
      const timer = setTimeout(() => {
        child.kill();
        finish({ ok: false, exitCode: null, timedOut: true, logTail: out.slice(-MAX_LOG_TAIL), error: `timeout after ${timeoutMs}ms` });
      }, timeoutMs);
      child.stdout?.on("data", (d: Buffer) => { out = (out + d.toString("utf8")).slice(-MAX_LOG_TAIL); });
      child.stderr?.on("data", (d: Buffer) => { out = (out + d.toString("utf8")).slice(-MAX_LOG_TAIL); });
      child.on("error", (err) => finish({ ok: false, exitCode: null, timedOut: false, logTail: out.slice(-MAX_LOG_TAIL), error: err.message }));
      child.on("close", (code) => finish({ ok: code === 0, exitCode: code, timedOut: false, logTail: out.slice(-MAX_LOG_TAIL), ...(code === 0 ? {} : { error: `exit ${code}` }) }));
    });
  }
}

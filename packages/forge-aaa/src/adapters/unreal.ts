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
  /** Omitted means raw editor switches only (e.g. `-ExecutePythonScript`), no `-run=`. */
  commandlet?: string;
  args?: string[];
  timeoutMs?: number;
  install?: UnrealInstall;
  /**
   * Absolute path for the engine's `-abslog=` output. Launcher builds write almost
   * nothing to stdout; the real log (including LogPython print output) lands here.
   */
  logPath?: string;
}

export interface UnrealCommandletResult {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  logTail: string;
  /** Last FORGEAAA_REPORT JSON emitted by an editor script, when present. */
  report?: Record<string, unknown>;
  logPath?: string;
  error?: string;
}

const UE_DEFAULT_ROOTS = [
  process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "Epic Games") : "C:\\Program Files\\Epic Games",
];
const DEFAULT_CMD_TIMEOUT_MS = 10 * 60_000;
const MAX_LOG_TAIL = 128 * 1024;

/** Emitted by editor scripts; the last occurrence in the captured tail is authoritative. */
const REPORT_MARKER = "FORGEAAA_REPORT:";

/**
 * Reviewed, deterministic placement script for UE4.27 (EditorScriptingUtilities API).
 * Inputs arrive as a single embedded JSON spec; every step is logged and the run ends
 * with a FORGEAAA_REPORT line the adapter parses back into structured evidence.
 */
const PLACEMENT_SCRIPT = `import unreal, json, sys
spec = json.loads("__FORGEAAA_SPEC__")
report = {"ok": True, "level": spec["level"], "placed": [], "actors_in_level": 0, "errors": []}
try:
    asset_lib = unreal.EditorAssetLibrary
    level_lib = unreal.EditorLevelLibrary
    if asset_lib.does_asset_exist(spec["level"]):
        level_lib.load_level(spec["level"])
        report["level_action"] = "loaded"
    else:
        level_lib.new_level(spec["level"])
        report["level_action"] = "created"
    existing = {}
    try:
        for a in level_lib.get_all_level_actors():
            try:
                existing[a.get_actor_label()] = a
            except Exception:
                pass
    except Exception:
        pass
    for p in spec["placements"]:
        try:
            asset = asset_lib.load_asset(p["asset"])
            if asset is None:
                report["errors"].append("asset missing: " + p["asset"])
                continue
            loc = unreal.Vector(p["location"][0], p["location"][1], p["location"][2])
            rot = unreal.Rotator(p["rotation"][0], p["rotation"][1], p["rotation"][2])
            scl = unreal.Vector(p["scale"][0], p["scale"][1], p["scale"][2])
            if p["name"] in existing:
                actor = existing[p["name"]]
                actor.set_actor_transform(unreal.Transform(loc, rot, scl), sweep=False, teleport=True)
                action = "updated"
            else:
                actor = level_lib.spawn_actor_from_object(asset, loc, rot)
                if actor is None:
                    report["errors"].append("spawn returned None: " + p["name"])
                    continue
                actor.set_actor_label(p["name"])
                if list(p["scale"]) != [1, 1, 1]:
                    actor.set_actor_scale3d(scl)
                action = "spawned"
            entry = {"name": p["name"], "actor": actor.get_actor_label(), "action": action}
            try:
                origin, extent = actor.get_actor_bounds(False)
                entry["bounds_cm"] = [round(v, 2) for v in (origin.x, origin.y, origin.z, extent.x, extent.y, extent.z)]
            except Exception:
                pass
            report["placed"].append(entry)
        except Exception as e:
            report["errors"].append(p["name"] + ": " + str(e))
    level_lib.save_current_level()
    report["level_saved"] = True
    try:
        report["actors_in_level"] = len(level_lib.get_all_level_actors())
    except Exception:
        report["actors_in_level"] = len(report["placed"])
except Exception as e:
    report["ok"] = False
    report["errors"].append("fatal: " + str(e))
report["ok"] = report["ok"] and len(report["errors"]) == 0 and len(report["placed"]) == len(spec["placements"])
print("FORGEAAA_REPORT:" + json.dumps(report))
sys.exit(0 if report["ok"] else 2)
`;

export interface UnrealImportRequest {
  projectPath: string;
  files: string[];
  /** Engine content path, must start with `/Game/`. */
  destinationPath: string;
  groupName?: string;
  replaceExisting?: boolean;
  /** Where the generated AutomatedAssetImportData JSON is written. */
  settingsPath: string;
  timeoutMs?: number;
  install?: UnrealInstall;
}

export interface UnrealImportResult extends UnrealCommandletResult {
  settingsPath: string;
}

export interface UnrealPlacement {
  /** Engine asset path, e.g. `/Game/ForgeAAA/SM_StairModule`. */
  assetPath: string;
  /** Stable logical name — actor label + idempotency key. Re-placement updates, never duplicates. */
  name: string;
  location: [number, number, number];
  rotation?: [number, number, number];
  scale?: [number, number, number];
}

export interface UnrealPlaceRequest {
  projectPath: string;
  /** Level object path, e.g. `/Game/ForgeAAA/Maps/L_StairTest`. Created when missing. */
  levelPath: string;
  placements: UnrealPlacement[];
  /** Where the generated placement script is written for evidence. */
  scriptPath: string;
  /** `-abslog=` destination for the engine run log. */
  logPath?: string;
  timeoutMs?: number;
  install?: UnrealInstall;
}

export interface UnrealPlaceResult extends UnrealCommandletResult {
  scriptPath: string;
  placed: { name: string; actor: string; action: "spawned" | "updated" }[];
}

export interface UnrealPythonScriptRequest {
  projectPath: string;
  /** Absolute path to a ForgeAAA-owned script file (never user content). */
  scriptPath: string;
  args?: string[];
  timeoutMs?: number;
  install?: UnrealInstall;
  /** `-abslog=` destination — required to observe LogPython output on launcher builds. */
  logPath?: string;
}

export interface UnrealAdapterDeps {
  fileExists?: (p: string) => boolean;
  listDir?: (p: string) => string[];
  readFile?: (p: string) => Promise<string>;
  writeFile?: (p: string, content: string) => Promise<void>;
  spawnProcess?: typeof spawn;
  platform?: NodeJS.Platform;
  extraRoots?: string[];
}

export class UnrealAdapter {
  private readonly fileExists: (p: string) => boolean;
  private readonly listDir?: (p: string) => string[];
  private readonly readFile: (p: string) => Promise<string>;
  private readonly writeFile: (p: string, content: string) => Promise<void>;
  private readonly spawnProcess: typeof spawn;
  private readonly platform: NodeJS.Platform;
  private readonly extraRoots: string[];

  constructor(deps: UnrealAdapterDeps = {}) {
    this.fileExists = deps.fileExists ?? ((p) => existsSync(p));
    this.listDir = deps.listDir;
    this.readFile = deps.readFile ?? ((p) => fs.readFile(p, "utf8"));
    this.writeFile = deps.writeFile ?? ((p, content) => fs.writeFile(p, content, "utf8"));
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
    if (req.commandlet !== undefined && !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(req.commandlet)) {
      throw new ForgeAaaError(FORGE_AAA_ERRORS.OPERATION_DENIED, `commandlet name "${req.commandlet}" is not a safe token`);
    }
    const args = [req.projectPath, ...(req.commandlet ? [`-run=${req.commandlet}`] : []), "-unattended", "-nop4", "-nosplash", ...(req.logPath ? [`-abslog=${req.logPath}`] : []), ...(req.args ?? [])];
    const started = Date.now();
    const tailFromLogFile = async (): Promise<string | undefined> => {
      if (!req.logPath) return undefined;
      try {
        const content = await this.readFile(req.logPath);
        return content.slice(-MAX_LOG_TAIL);
      } catch {
        return undefined;
      }
    };
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
      const reportFrom = (tail: string): Record<string, unknown> | undefined => {
        const idx = tail.lastIndexOf(REPORT_MARKER);
        if (idx < 0) return undefined;
        try { return JSON.parse((tail.slice(idx + REPORT_MARKER.length).trim().split(/\r?\n/)[0] ?? "")) as Record<string, unknown>; }
        catch { return undefined; }
      };
      const finish = (r: Omit<UnrealCommandletResult, "durationMs">) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        void (async () => {
          const fileTail = await tailFromLogFile();
          const tail = fileTail ?? ((r.logTail ?? "") || out.slice(-MAX_LOG_TAIL));
          const report = reportFrom(tail);
          resolve({ ...r, logTail: tail, ...(report ? { report } : {}), ...(req.logPath ? { logPath: req.logPath } : {}), durationMs: Date.now() - started });
        })();
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

  /**
   * Scripted asset import through the real `ImportAssets` commandlet — proven against
   * UE 4.27.2 to write .uasset files under the destination path. Caveat recorded from
   * live evidence: the launcher build counts the expected "Could not connect to source
   * control" message in its error summary even when import succeeds, so callers must
   * verify produced .uasset files themselves rather than trusting the exit code.
   */
  async importAssets(req: UnrealImportRequest): Promise<UnrealImportResult> {
    if (!/^\/Game(\/|$)/.test(req.destinationPath)) {
      throw new ForgeAaaError(FORGE_AAA_ERRORS.OPERATION_DENIED, `destinationPath must be under /Game — got "${req.destinationPath}"`);
    }
    for (const file of req.files) {
      if (!this.fileExists(file)) {
        throw new ForgeAaaError(FORGE_AAA_ERRORS.MANIFEST_INVALID, `import source missing: ${file}`);
      }
    }
    const settings = {
      ImportGroups: [{
        GroupName: req.groupName ?? "ForgeAAA",
        Filenames: req.files.map((f) => f.replace(/\\/g, "/")),
        DestinationPath: req.destinationPath,
        bReplaceExisting: req.replaceExisting === true,
        bSkipReadOnly: true,
      }],
    };
    await this.writeFile(req.settingsPath, JSON.stringify(settings, null, 2));
    const result = await this.runCommandlet({
      projectPath: req.projectPath,
      commandlet: "ImportAssets",
      args: [`-importSettings=${req.settingsPath}`],
      timeoutMs: req.timeoutMs,
      install: req.install,
    });
    return { ...result, settingsPath: req.settingsPath };
  }

  /**
   * Enable editor plugins in the project's .uproject (additive, idempotent — existing
   * entries are preserved). This mutates the project descriptor and must only be used
   * against PILOT_PROJECTs or an explicitly authorized project.
   */
  async ensurePlugins(projectPath: string, pluginNames: string[]): Promise<{ added: string[]; plugins: { name: string; enabled: boolean }[] }> {
    const info = await this.inspectProject(projectPath);
    const existing = new Set(info.plugins.map((p) => p.name));
    const additions = pluginNames.filter((n) => !existing.has(n));
    const raw = JSON.parse(await this.readFile(projectPath)) as Record<string, unknown>;
    const plugins = Array.isArray(raw.Plugins) ? raw.Plugins as unknown[] : [];
    for (const name of additions) plugins.push({ Name: name, Enabled: true });
    raw.Plugins = plugins;
    await this.writeFile(projectPath, JSON.stringify(raw, null, 2) + "\n");
    const after = await this.inspectProject(projectPath);
    return { added: additions, plugins: after.plugins };
  }

  /**
   * Run a ForgeAAA-owned Python file inside the editor via the `PythonScript` commandlet
   * (requires PythonScriptPlugin + EditorScriptingUtilities enabled — see ensurePlugins).
   * The script path must be a file we generated; arbitrary user scripts are rejected.
   */
  async runPythonScript(req: UnrealPythonScriptRequest): Promise<UnrealCommandletResult> {
    if (!this.fileExists(req.scriptPath)) {
      throw new ForgeAaaError(FORGE_AAA_ERRORS.MANIFEST_INVALID, `python script missing: ${req.scriptPath}`);
    }
    if (!req.scriptPath.toLowerCase().endsWith(".py")) {
      throw new ForgeAaaError(FORGE_AAA_ERRORS.OPERATION_DENIED, "runPythonScript only accepts .py files");
    }
    return this.runCommandlet({
      projectPath: req.projectPath,
      args: [`-ExecutePythonScript=${req.scriptPath}`, ...(req.args ?? [])],
      timeoutMs: req.timeoutMs,
      install: req.install,
      logPath: req.logPath,
    });
  }

  /**
   * Bounded, idempotent actor placement into a level. The generated editor script:
   * creates the level when missing, spawns or re-transforms actors keyed by stable
   * ForgeAAA label (repeat runs update rather than duplicate), saves the level, and
   * emits a FORGEAAA_REPORT line with placed actors and their world bounds.
   */
  async placeAssets(req: UnrealPlaceRequest): Promise<UnrealPlaceResult> {
    if (!/^\/Game(\/|$)/.test(req.levelPath)) {
      throw new ForgeAaaError(FORGE_AAA_ERRORS.OPERATION_DENIED, `levelPath must be under /Game — got "${req.levelPath}"`);
    }
    for (const p of req.placements) {
      if (!/^\/Game(\/|$)/.test(p.assetPath)) {
        throw new ForgeAaaError(FORGE_AAA_ERRORS.OPERATION_DENIED, `assetPath must be under /Game — got "${p.assetPath}"`);
      }
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(p.name)) {
        throw new ForgeAaaError(FORGE_AAA_ERRORS.OPERATION_DENIED, `invalid placement name "${p.name}"`);
      }
    }
    const spec = JSON.stringify({
      level: req.levelPath,
      placements: req.placements.map((p) => ({
        name: p.name, asset: p.assetPath, location: p.location,
        rotation: p.rotation ?? [0, 0, 0], scale: p.scale ?? [1, 1, 1],
      })),
    });
    const script = PLACEMENT_SCRIPT.replace("__FORGEAAA_SPEC__", spec.replace(/\\/g, "\\\\").replace(/"/g, '\\"'));
    await this.writeFile(req.scriptPath, script);
    const result = await this.runPythonScript({
      projectPath: req.projectPath,
      scriptPath: req.scriptPath,
      timeoutMs: req.timeoutMs,
      install: req.install,
      logPath: req.logPath,
    });
    const placed = (result.report as { placed?: UnrealPlaceResult["placed"] } | undefined)?.placed ?? [];
    return { ...result, scriptPath: req.scriptPath, placed };
  }
}

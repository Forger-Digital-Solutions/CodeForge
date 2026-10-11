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
  /**
   * `cmd` (default) uses UE4Editor-Cmd; `editor` uses UE4Editor — required for PIE
   * tests because Slate tick callbacks do not exist in a -Cmd process.
   */
  host?: "cmd" | "editor";
  /**
   * `-game` mode: launches UE4Editor in game mode on this map (real game world —
   * no editor subsystems). Map is inserted as the second positional argument.
   */
  game?: { map: string };
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

/**
 * PIE traversal test for UE4.27: runs in the GUI editor (Slate post-tick drives a
 * phase machine), spawns a real `Character`, applies movement input through its
 * CharacterMovement every tick — actual capsule collision + step-up physics — and
 * samples the trajectory. Raw metrics are emitted as FORGEAAA_REPORT; the adapter
 * evaluates the declared success gates. Never saves the level.
 */
/**
 * -game-mode traversal test for UE4.27: runs inside the real game world (no editor
 * subsystems). A Character is created via the `summon` console command, teleported
 * once to the spec spawn, then driven by CharacterMovement input every Slate tick —
 * real capsule collision + step-up physics. The report FILE is authoritative
 * evidence: print() inside deferred callbacks does not reach LogPython reliably.
 */
const TRAVERSAL_SCRIPT = `import unreal, json, math
spec = json.loads("__FORGEAAA_SPEC__")
report = {"kind": "traversal", "level": spec["level"], "runId": spec["runId"], "executed": False, "samples": [], "errors": [], "trace": []}
state = {"phase": "boot", "world": None, "pc": None, "t": 0.0, "last_sample_t": -1.0,
         "handle": None, "ticks": 0, "wait": 0}

def write_report():
    try:
        with open(spec["reportPath"], "w") as f:
            json.dump(report, f)
    except Exception as e:
        report["errors"].append("report write: " + str(e))

def finish():
    write_report()
    try:
        unreal.unregister_slate_post_tick_callback(state["handle"])
    except Exception:
        pass
    print("FORGEAAA_REPORT:" + json.dumps(report))
    try:
        unreal.SystemLibrary.execute_console_command(state.get("world"), "quit", state.get("pc"))
    except Exception:
        pass

def prep_char(c):
    # No controller possesses this pawn: bRunPhysicsWithNoController lets the movement
    # component simulate anyway. CheatManager-summoned characters can also come up with
    # MOVE_None — force walking so PhysWalking actually runs.
    try:
        cm = c.character_movement
        cm.run_physics_with_no_controller = True
        cm.set_movement_mode(unreal.MovementMode.MOVE_WALKING)
    except Exception as e:
        report["trace"].append("prep_warn:" + str(e))

def resolve_context():
    map_name = spec["level"].rsplit("/", 1)[-1]
    for name in (spec["level"] + "." + map_name, "PersistentLevel", map_name):
        try:
            obj = unreal.find_object(None, name)
            if obj is not None:
                return obj
        except Exception:
            pass
    return None

def tick(dt):
    state["ticks"] += 1
    if state["ticks"] > 15000:
        report["errors"].append("tick watchdog")
        finish()
        return
    try:
        if state["phase"] == "boot":
            ctx = resolve_context()
            if ctx is not None:
                state["world"] = ctx
                state["pc"] = unreal.GameplayStatics.get_player_controller(ctx, 0)
                report["trace"].append("world_ready:" + ctx.get_name())
                # GameMode auto-spawns a DefaultPawn at the PlayerStart — its collision
                # overlaps our test character's spawn and depenetrates it sideways.
                for p in unreal.GameplayStatics.get_all_actors_of_class(ctx, unreal.Pawn):
                    p.destroy_actor()
                unreal.SystemLibrary.execute_console_command(ctx, "summon Engine.Character", state["pc"])
                state["phase"] = "spawn_wait"
        elif state["phase"] == "spawn_wait":
            chars = unreal.GameplayStatics.get_all_actors_of_class(state["world"], unreal.Character)
            if len(chars):
                c = chars[0]
                sp = spec["spawn"]
                c.set_actor_location(unreal.Vector(sp[0], sp[1], sp[2]), False, False)
                d = spec["input"]
                yaw = math.degrees(math.atan2(d[1], d[0]))
                c.set_actor_rotation(unreal.Rotator(0, 0, yaw), False)
                # summon fabricates the pawn mid-fall at the camera position — velocity
                # survives the teleport and corrupts the run unless cleared.
                try:
                    c.character_movement.stop_movement_immediately()
                    c.character_movement.velocity = unreal.Vector(0, 0, 0)
                except Exception:
                    pass
                prep_char(c)
                state["char"] = c
                state["phase"] = "settle"
                state["settle"] = 0.0
        elif state["phase"] == "settle":
            # Let the capsule land on the floor before applying input — sampled input
            # during the initial fall corrupts the trajectory.
            c = state.get("char")
            if c is None:
                report["errors"].append("character lost during settle")
                finish()
                return
            state["settle"] += dt
            if state["settle"] >= 0.5:
                state["phase"] = "run"
                report["trace"].append("char_spawned")
                report["executed"] = True
            else:
                state["wait"] += 1
                if state["wait"] > 600:
                    report["errors"].append("spawn produced no Character")
                    finish()
        elif state["phase"] == "run":
            c = state.get("char")
            if c is None or not unreal.SystemLibrary.is_valid(c):
                chars = unreal.GameplayStatics.get_all_actors_of_class(state["world"], unreal.Character)
                c = chars[0] if len(chars) else None
                if c is None:
                    report["errors"].append("character lost mid-run")
                    finish()
                    return
                state["char"] = c
            if not state.get("diag"):
                state["diag"] = True
                try:
                    cm = c.character_movement
                    report["trace"].append("diag:rpnwc=%s mode=%s moveIgnored=%s role=%s" % (
                        cm.run_physics_with_no_controller, cm.movement_mode,
                        c.is_move_input_ignored(), c.get_local_role()))
                except Exception as e:
                    report["trace"].append("diag_err:" + str(e))
            if not state.get("stopped"):
                d = spec["input"]
                # bForce=True: AddMovementInput is dropped without a local controller otherwise.
                c.add_movement_input(unreal.Vector(d[0], d[1], d[2]), 1.0, True)
            state["t"] += dt
            if state["t"] - state["last_sample_t"] >= spec["samplePeriod"]:
                state["last_sample_t"] = state["t"]
                p = c.get_actor_location()
                v = c.get_velocity()
                wt = unreal.GameplayStatics.get_time_seconds(state["world"])
                report["samples"].append({"t": round(state["t"], 2), "wt": round(wt, 2),
                    "x": round(p.x, 2), "y": round(p.y, 2), "z": round(p.z, 2),
                    "v": round(math.sqrt(v.x*v.x + v.y*v.y + v.z*v.z), 2)})
                st = spec.get("stop")
                if st and not state.get("stopped"):
                    declared = (st.get("minZ") is not None) or (st.get("maxZ") is not None) or (st.get("minDisplacementCm") is not None)
                    met = declared
                    if st.get("minZ") is not None and p.z < st["minZ"]: met = False
                    if st.get("maxZ") is not None and p.z > st["maxZ"]: met = False
                    if st.get("minDisplacementCm") is not None:
                        p0 = report["samples"][0]
                        if math.hypot(p.x - p0["x"], p.y - p0["y"]) < st["minDisplacementCm"]: met = False
                    if met:
                        state["stopped"] = True
                        c.character_movement.stop_movement_immediately()
                        c.character_movement.velocity = unreal.Vector(0, 0, 0)
                        report["trace"].append("target_reached:t=" + str(round(state["t"], 2)))
            if state["t"] >= spec["durationS"]:
                state["phase"] = "done"
                finish()
    except Exception as e:
        report["errors"].append("tick: " + str(e))
        state["phase"] = "done"
        finish()

state["handle"] = unreal.register_slate_post_tick_callback(tick)
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

export type UnrealFunctionalTestState = "pass" | "fail" | "blocked" | "unsupported" | "timeout" | "not_executed";

export interface UnrealTraversalSpec {
  /** World-space character spawn point (capsule center). */
  spawn: [number, number, number];
  /** Unit world direction applied as movement input every tick during the run phase. */
  inputDirection: [number, number, number];
  /** Simulated-seconds budget for the movement phase. */
  durationS: number;
  /** Sampling period in simulated seconds; default 0.1. Lower for step-resolution profiling. */
  samplePeriodS?: number;
  /** Success gates — all declared gates must hold. Pure assertions; never stop input. */
  expect?: {
    minZ?: number;
    maxZ?: number;
    minDisplacementCm?: number;
    maxDisplacementCm?: number;
  };
  /** Early-stop conditions — input halts once all declared thresholds are met.
   *  Omit to drive for the full duration (e.g. blocked-movement tests). */
  stopWhen?: {
    minZ?: number;
    maxZ?: number;
    minDisplacementCm?: number;
  };
}

export interface UnrealFunctionalTestRequest {
  projectPath: string;
  /** Level under test — loaded but never mutated. */
  levelPath: string;
  /** ForgeAAA-owned script destination. */
  scriptPath: string;
  /** `-abslog=` destination for the engine run log. */
  logPath?: string;
  traversal: UnrealTraversalSpec;
  timeoutMs?: number;
  install?: UnrealInstall;
}

export interface UnrealFunctionalTestResult extends UnrealCommandletResult {
  state: UnrealFunctionalTestState;
  scriptPath: string;
  /** Engine-reported metrics: samples, z-gain, displacement, stuck detection. */
  metrics?: Record<string, unknown>;
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
  /** `editor` runs on UE4Editor.exe (needed for PIE/Slate ticks); default is -Cmd. */
  host?: "cmd" | "editor";
}

export interface UnrealAdapterDeps {
  fileExists?: (p: string) => boolean;
  listDir?: (p: string) => string[];
  readFile?: (p: string) => Promise<string>;
  writeFile?: (p: string, content: string) => Promise<void>;
  deleteFile?: (p: string) => Promise<void>;
  spawnProcess?: typeof spawn;
  platform?: NodeJS.Platform;
  extraRoots?: string[];
}

export class UnrealAdapter {
  private readonly fileExists: (p: string) => boolean;
  private readonly listDir?: (p: string) => string[];
  private readonly readFile: (p: string) => Promise<string>;
  private readonly writeFile: (p: string, content: string) => Promise<void>;
  private readonly deleteFile: (p: string) => Promise<void>;
  private readonly spawnProcess: typeof spawn;
  private readonly platform: NodeJS.Platform;
  private readonly extraRoots: string[];

  constructor(deps: UnrealAdapterDeps = {}) {
    this.fileExists = deps.fileExists ?? ((p) => existsSync(p));
    this.listDir = deps.listDir;
    this.readFile = deps.readFile ?? ((p) => fs.readFile(p, "utf8"));
    this.writeFile = deps.writeFile ?? ((p, content) => fs.writeFile(p, content, "utf8"));
    this.deleteFile = deps.deleteFile ?? ((p) => fs.rm(p, { force: true }));
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
    const exePath = req.host === "editor" ? install.editorPath : install.editorCmdPath;
    if (!exePath) throw new ForgeAaaError(FORGE_AAA_ERRORS.ENGINE_NOT_FOUND, req.host === "editor" ? "UE4Editor binary not found under Engine/Binaries/Win64" : "UE4Editor-Cmd binary not found under Engine/Binaries/Win64");
    if (req.commandlet !== undefined && !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(req.commandlet)) {
      throw new ForgeAaaError(FORGE_AAA_ERRORS.OPERATION_DENIED, `commandlet name "${req.commandlet}" is not a safe token`);
    }
    if (req.game && !/^\/Game(\/|$)/.test(req.game.map)) {
      throw new ForgeAaaError(FORGE_AAA_ERRORS.OPERATION_DENIED, `game map must be under /Game — got "${req.game.map}"`);
    }
    const args = [req.projectPath, ...(req.game ? [req.game.map, "-game"] : []), ...(req.commandlet ? [`-run=${req.commandlet}`] : []), "-unattended", "-nop4", "-nosplash", ...(req.logPath ? [`-abslog=${req.logPath}`] : []), ...(req.args ?? [])];
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
        child = this.spawnProcess(exePath, args, { windowsHide: true });
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
      host: req.host,
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
      if (!/^\/(Game|Engine)(\/|$)/.test(p.assetPath)) {
        throw new ForgeAaaError(FORGE_AAA_ERRORS.OPERATION_DENIED, `assetPath must be under /Game or /Engine — got "${p.assetPath}"`);
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

  /**
   * Temporarily point PythonScriptPlugin's StartupScripts at our file by appending the
   * setting section to the project's DefaultEngine.ini. Returns a
   * restore() that puts back the exact prior bytes (or deletes a file we created).
   */
  private async injectStartupScript(iniPath: string, scriptPath: string): Promise<() => Promise<void>> {
    let original: string | undefined;
    try {
      original = await this.readFile(iniPath);
    } catch {
      original = undefined;
    }
    const section = `\n[/Script/PythonScriptPlugin.PythonScriptPluginSettings]\n+StartupScripts="${scriptPath}"\n`;
    await fs.mkdir(path.dirname(iniPath), { recursive: true });
    await this.writeFile(iniPath, (original ?? "") + section);
    const restoreBytes = original;
    return async () => {
      try {
        if (restoreBytes === undefined) await fs.rm(iniPath, { force: true });
        else await this.writeFile(iniPath, restoreBytes);
      } catch { /* best effort restore */ }
    };
  }

  /**
   * Bounded traversal test in `-game` mode (UE4Editor game world — PIE/SIE cannot run
   * under `-unattended`; verified on this install). A Character is summoned, teleported
   * once to spec.spawn, then driven by real CharacterMovement input per Slate tick.
   * Success gates are evaluated here from engine-reported trajectory samples.
   */
  async runFunctionalTest(req: UnrealFunctionalTestRequest): Promise<UnrealFunctionalTestResult> {
    if (!/^\/Game(\/|$)/.test(req.levelPath)) {
      throw new ForgeAaaError(FORGE_AAA_ERRORS.OPERATION_DENIED, `levelPath must be under /Game — got "${req.levelPath}"`);
    }
    const dir = req.traversal.inputDirection;
    const mag = Math.hypot(dir[0], dir[1], dir[2]);
    if (mag < 0.5 || mag > 1.5) {
      throw new ForgeAaaError(FORGE_AAA_ERRORS.OPERATION_DENIED, "inputDirection must be a unit vector");
    }
    if (req.traversal.durationS <= 0 || req.traversal.durationS > 300) {
      throw new ForgeAaaError(FORGE_AAA_ERRORS.OPERATION_DENIED, "durationS must be in (0, 300]");
    }
    const reportPath = req.scriptPath.replace(/\.py$/i, ".report.json");
    const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const spec = JSON.stringify({
      level: req.levelPath,
      spawn: req.traversal.spawn,
      input: req.traversal.inputDirection,
      durationS: req.traversal.durationS,
      samplePeriod: req.traversal.samplePeriodS ?? 0.1,
      reportPath,
      runId,
      // Stop conditions are explicit (stopWhen), defaulting to the expect gates —
      // except maxDisplacementCm which can never be a "reached" condition.
      stop: req.traversal.stopWhen ?? req.traversal.expect ?? null,
    });
    // The report file is authoritative — delete any stale copy before launch so an old
    // report can never be mistaken for this run's output.
    try { await this.deleteFile(reportPath); } catch { /* absent is fine */ }
    const script = TRAVERSAL_SCRIPT.replace("__FORGEAAA_SPEC__", spec.replace(/\\/g, "\\\\").replace(/"/g, '\\"'));
    await this.writeFile(req.scriptPath, script);
    // Game mode has no -ExecutePythonScript; the supported hook is the plugin's
    // StartupScripts setting — UPythonScriptPluginSettings is config=Engine, verified
    // against the plugin source. Injected into DefaultEngine.ini, always restored.
    const iniPath = path.join(path.dirname(req.projectPath), "Config", "DefaultEngine.ini");
    const restore = await this.injectStartupScript(iniPath, req.scriptPath);
    let result: UnrealCommandletResult;
    try {
      result = await this.runCommandlet({
        projectPath: req.projectPath,
        game: { map: req.levelPath },
        timeoutMs: req.timeoutMs,
        install: req.install,
        logPath: req.logPath,
        host: "editor",
      });
    } finally {
      await restore();
    }
    if (result.timedOut) return { ...result, state: "timeout", scriptPath: req.scriptPath };
    // The report FILE is authoritative — print() inside slate callbacks doesn't reach
    // LogPython, so result.report may legitimately be absent on successful runs.
    let rep = (result.report ?? {}) as Record<string, unknown>;
    try {
      const onDisk = JSON.parse(await this.readFile(reportPath)) as Record<string, unknown>;
      // Reject reports that can't be proven fresh — runId is baked into the spec.
      if (onDisk.runId === runId) rep = onDisk;
      else rep = { executed: false, errors: [...(rep.errors as string[] ?? []), "stale report discarded"], stale: true };
    } catch {
      if (!result.report) rep = { executed: false, errors: ["no report produced"], not_executed: true };
    }
    if (rep.executed !== true) return { ...result, state: rep.errors ? "blocked" : "not_executed", scriptPath: req.scriptPath };
    const samples = Array.isArray(rep.samples) ? rep.samples as { t: number; x: number; y: number; z: number }[] : [];
    if (samples.length < 3) return { ...result, state: "blocked", scriptPath: req.scriptPath, metrics: rep };
    const first = samples[0]!;
    const last = samples[samples.length - 1]!;
    const disp = Math.hypot(last.x - first.x, last.y - first.y);
    const metrics: Record<string, unknown> = {
      samples: samples.length, simSeconds: last.t,
      start: [first.x, first.y, first.z], final: [last.x, last.y, last.z],
      zGain: last.z - first.z, displacementCm: disp,
      maxZ: Math.max(...samples.map((s) => s.z)), minZ: Math.min(...samples.map((s) => s.z)),
      errors: rep.errors ?? [],
    };
    const exp = req.traversal.expect;
    let state: UnrealFunctionalTestState = "pass";
    if (exp) {
      if (exp.minZ !== undefined && (last.z as number) < exp.minZ) state = "fail";
      if (exp.maxZ !== undefined && (last.z as number) > exp.maxZ) state = "fail";
      if (exp.minDisplacementCm !== undefined && disp < exp.minDisplacementCm) state = "fail";
      if (exp.maxDisplacementCm !== undefined && disp > exp.maxDisplacementCm) state = "fail";
    }
    return { ...result, state, scriptPath: req.scriptPath, metrics };
  }
}

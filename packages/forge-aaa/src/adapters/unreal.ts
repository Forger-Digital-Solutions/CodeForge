import { promises as fs, existsSync, readdirSync } from "node:fs";
import crypto from "node:crypto";
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
  /** Called synchronously once the engine process exists — used to record the PID
   *  in the config lock so a later recovery pass can reap an orphaned engine. */
  onSpawn?: (child: { pid?: number }) => void;
}

interface ForgeAaaConfigLock {
  runId: string;
  ownerPid: number;
  iniPath: string;
  /** Present iff the ini existed before injection — its original bytes live here. */
  backupPath: string | null;
  originalAbsent: boolean;
  injectedSha256: string;
  enginePid: number | null;
  startedAt: string;
}

const sha256 = (content: string): string => crypto.createHash("sha256").update(content, "utf8").digest("hex");

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
  /** False means DefaultEngine.ini did not restore cleanly — see configRestoreDetail. */
  configRestored?: boolean;
  configRestoreDetail?: string;
}

/**
 * Door/interaction scenario (mission §6.5-§6.8): a Character is driven through an action
 * timeline against a door leaf actor — summoned at runtime, or a level actor found by
 * label (persistence path). Every action gets its own measured displacement + door-state
 * record so assertions bind to engine evidence, not intent.
 */
export interface UnrealInteractionAction {
  op: "move" | "interact" | "wait";
  /** `move` only — unit-ish input direction. */
  direction?: [number, number, number];
  durationS: number;
  expect?: {
    maxDisplacementCm?: number;
    minDisplacementCm?: number;
    /** Asserted character world-Y at action end (cm). */
    minEndY?: number;
    maxEndY?: number;
    /** Asserted door leaf world yaw at action end (deg). */
    doorYawDeg?: number;
    /** Asserted door state label at action end. */
    doorState?: "closed" | "opening" | "open" | "closing";
  };
}

export interface UnrealInteractionTestRequest {
  projectPath: string;
  levelPath: string;
  scriptPath: string;
  logPath?: string;
  spawn: [number, number, number];
  door: {
    /** `/Game/...` static-mesh asset for the leaf (hinge-at-origin). */
    leafAsset: string;
    /** World location of the hinge axis at the sill. */
    hingeLocation: [number, number, number];
    closedYawDeg: number;
    /** Signed swing — final open yaw = closedYaw + openAngle. */
    openAngleDeg: number;
    transitionS: number;
    /** Level-actor label to reuse (persisted placement); absent → summon a leaf actor. */
    leafActorLabel?: string;
    /** Start the scenario with the leaf already open. */
    initiallyOpen?: boolean;
    /** Center of the doorway opening [x,y,z] — line-traced each action end to report
     *  whether the passage is physically clear (probeHit evidence). */
    probeCenter?: [number, number, number];
  };
  actions: UnrealInteractionAction[];
  samplePeriodS?: number;
  timeoutMs?: number;
  install?: UnrealInstall;
}

export interface UnrealInteractionTestResult extends UnrealFunctionalTestResult {
  /** Per-action engine measurements in spec order. */
  actionMetrics?: {
    op: string; displacementCm: number; doorYawDeg: number | null; doorState: string | null;
    /** Yaw read back from the leaf actor at action end — evidence the rotation
     *  actually applied (commanded yaw alone proves nothing). */
    obsDoorYawDeg?: number | null;
    start: [number, number, number]; end: [number, number, number];
  }[];
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

  private async readJson<T>(p: string): Promise<T | undefined> {
    try {
      return JSON.parse(await this.readFile(p)) as T;
    } catch {
      return undefined;
    }
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
        req.onSpawn?.({ pid: child.pid });
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
   * Crash-safe temporary DefaultEngine.ini modification.
   *
   * Instead of an in-memory restore closure (lost when the adapter process dies), the
   * pre-edit bytes are written to a sibling backup file and a lock records what the ini
   * is supposed to contain while we own it (sha256 of the injected content). The next
   * acquisition that finds an abandoned lock can therefore distinguish three states:
   *   - ini still holds exactly our injected bytes  → previous owner died; restore+reap.
   *   - ini changed since                          → someone else owns it now; fail closed.
   *   - lock/backup unreadable                     → ambiguous; fail closed.
   * Restore also verifies the ini still holds our bytes before overwriting — a user edit
   * made mid-test is never clobbered.
   */
  private async acquireConfigOwnership(iniPath: string, scriptPath: string, runId: string): Promise<{
    restore: () => Promise<{ restored: boolean; detail: string }>;
    setEnginePid: (pid: number | undefined) => void;
  }> {
    const lockPath = `${iniPath}.forgeaaa.lock`;
    const backupPath = `${iniPath}.forgeaaa-backup.${runId}`;
    // UE4 ini values eat backslashes — a Windows path must be forward-slashed or the
    // plugin can't find the file and execs the path string as code (live evidence R80).
    const iniScriptPath = scriptPath.replace(/\\/g, "/");
    const section = `\n[/Script/PythonScriptPlugin.PythonScriptPluginSettings]\n+StartupScripts="${iniScriptPath}"\n`;

    const priorLock = await this.readJson<ForgeAaaConfigLock>(lockPath);
    if (priorLock !== undefined) {
      await this.recoverAbandonedOwnership(priorLock, lockPath);
    }

    let original: string | undefined;
    try {
      original = await this.readFile(iniPath);
    } catch {
      original = undefined;
    }
    const injected = (original ?? "") + section;
    await fs.mkdir(path.dirname(iniPath), { recursive: true });
    if (original !== undefined) {
      await this.writeFile(backupPath, original);
    }
    await this.writeFile(iniPath, injected);
    const lock: ForgeAaaConfigLock = {
      runId,
      ownerPid: process.pid,
      iniPath,
      backupPath: original !== undefined ? backupPath : null,
      originalAbsent: original === undefined,
      injectedSha256: sha256(injected),
      enginePid: null,
      startedAt: new Date().toISOString(),
    };
    await this.writeFile(lockPath, JSON.stringify(lock, null, 2));

    const restore = async (): Promise<{ restored: boolean; detail: string }> => {
      try {
        const current = await this.readFile(iniPath).catch(() => undefined);
        const currentSha = current === undefined ? null : sha256(current);
        if (currentSha !== lock.injectedSha256) {
          // Bytes changed under us — ownership is ambiguous, so nothing is overwritten.
          // Backup and lock stay on disk for manual or next-run recovery.
          return { restored: false, detail: `ini changed during test (sha ${currentSha ?? "missing"} != ${lock.injectedSha256}) — original preserved at ${lock.backupPath ?? "none (file was absent)"}` };
        }
        if (lock.originalAbsent) await fs.rm(iniPath, { force: true });
        else await this.writeFile(iniPath, original!);
        await fs.rm(backupPath, { force: true });
        await fs.rm(lockPath, { force: true });
        return { restored: true, detail: "original bytes restored" };
      } catch (err) {
        return { restored: false, detail: `restore failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    };
    const setEnginePid = (pid: number | undefined): void => {
      lock.enginePid = pid ?? null;
      void this.writeFile(lockPath, JSON.stringify(lock, null, 2)).catch(() => undefined);
    };
    return { restore, setEnginePid };
  }

  /**
   * A prior run left its lock behind. Safe to reclaim only when the ini still holds the
   * exact bytes that run injected — anything else means legitimate post-crash edits we
   * must not clobber.
   */
  private async recoverAbandonedOwnership(lock: ForgeAaaConfigLock, lockPath: string): Promise<void> {
    const current = await this.readFile(lock.iniPath).catch(() => undefined);
    const currentSha = current === undefined ? null : sha256(current);
    if (currentSha === lock.injectedSha256) {
      if (lock.enginePid) await this.reapOrphanedEngine(lock.enginePid, lock.iniPath);
      if (lock.originalAbsent || !lock.backupPath) {
        await fs.rm(lock.iniPath, { force: true });
      } else {
        const original = await this.readFile(lock.backupPath);
        await this.writeFile(lock.iniPath, original);
      }
      if (lock.backupPath) await fs.rm(lock.backupPath, { force: true });
      await fs.rm(lockPath, { force: true });
      return;
    }
    throw new ForgeAaaError(
      FORGE_AAA_ERRORS.OPERATION_DENIED,
      `abandoned config lock at ${lockPath} but ${lock.iniPath} no longer matches the recorded bytes — refusing to overwrite; inspect and remove the lock manually`,
    );
  }

  /**
   * Kill an engine PID recorded in an abandoned lock — but only after confirming the
   * live process is actually a UE4Editor launched on our project (PID reuse must not
   * kill an unrelated user session). Best-effort, never throws.
   */
  private async reapOrphanedEngine(pid: number, iniPath: string): Promise<void> {
    if (this.platform !== "win32") return;
    const projectDir = path.basename(path.dirname(path.dirname(iniPath))).toLowerCase();
    try {
      const { execFile } = await import("node:child_process");
      const cmdline = await new Promise<string>((resolve) => {
        execFile(
          "powershell.exe",
          ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
          { timeout: 10_000, windowsHide: true },
          (err, stdout) => resolve(err ? "" : String(stdout)),
        );
      });
      const lower = cmdline.toLowerCase();
      if (lower.includes("ue4editor") && lower.includes(projectDir)) {
        process.kill(pid);
      }
    } catch { /* process already gone or query failed — nothing to reap */ }
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
    const { restore, setEnginePid } = await this.acquireConfigOwnership(iniPath, req.scriptPath, runId);
    let result: UnrealCommandletResult & Pick<UnrealFunctionalTestResult, "configRestored" | "configRestoreDetail">;
    let config: { restored: boolean; detail: string };
    try {
      result = await this.runCommandlet({
        projectPath: req.projectPath,
        game: { map: req.levelPath },
        timeoutMs: req.timeoutMs,
        install: req.install,
        logPath: req.logPath,
        host: "editor",
        onSpawn: ({ pid }) => setEnginePid(pid),
      });
    } finally {
      config = await restore();
    }
    result = { ...result, configRestored: config.restored, configRestoreDetail: config.detail };
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

  /**
   * Door interaction scenario in `-game` mode (mission §8 TEST 1-8): drives a Character
   * through a move/interact/wait timeline against a door leaf whose yaw is lerped over
   * the configured transition — a deterministic timeline-style mechanism (allowed by
   * §6.4) with live collision, not a two-position flip. `interact` toggles the leaf's
   * target yaw and is recorded as INTERACTION_COMMAND, an explicitly implemented
   * interaction path — it is not claimed as player-input (§6.7).
   */
  async runInteractionTest(req: UnrealInteractionTestRequest): Promise<UnrealInteractionTestResult> {
    if (!/^\/Game(\/|$)/.test(req.levelPath)) {
      throw new ForgeAaaError(FORGE_AAA_ERRORS.OPERATION_DENIED, `levelPath must be under /Game — got "${req.levelPath}"`);
    }
    if (!/^\/(Game|Engine)(\/|$)/.test(req.door.leafAsset)) {
      throw new ForgeAaaError(FORGE_AAA_ERRORS.OPERATION_DENIED, `leafAsset must be under /Game or /Engine — got "${req.door.leafAsset}"`);
    }
    if (req.actions.length === 0 || req.actions.length > 64) {
      throw new ForgeAaaError(FORGE_AAA_ERRORS.OPERATION_DENIED, "actions must contain 1..64 entries");
    }
    if (Math.abs(req.door.openAngleDeg) < 1 || Math.abs(req.door.openAngleDeg) > 180) {
      throw new ForgeAaaError(FORGE_AAA_ERRORS.OPERATION_DENIED, "openAngleDeg must be in [-180,-1]∪[1,180]");
    }
    if (req.door.transitionS <= 0 || req.door.transitionS > 30) {
      throw new ForgeAaaError(FORGE_AAA_ERRORS.OPERATION_DENIED, "transitionS must be in (0,30]");
    }
    for (const a of req.actions) {
      if (a.durationS <= 0 || a.durationS > 60) {
        throw new ForgeAaaError(FORGE_AAA_ERRORS.OPERATION_DENIED, `action durationS must be in (0,60] — got ${a.durationS}`);
      }
      if (a.op === "move") {
        if (!a.direction) throw new ForgeAaaError(FORGE_AAA_ERRORS.OPERATION_DENIED, "move action requires direction");
        const mag = Math.hypot(a.direction[0], a.direction[1], a.direction[2]);
        if (mag < 0.5 || mag > 1.5) throw new ForgeAaaError(FORGE_AAA_ERRORS.OPERATION_DENIED, "move direction must be a unit vector");
      }
    }
    const reportPath = req.scriptPath.replace(/\.py$/i, ".report.json");
    const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const spec = JSON.stringify({
      level: req.levelPath,
      spawn: req.spawn,
      door: req.door,
      actions: req.actions,
      samplePeriod: req.samplePeriodS ?? 0.1,
      reportPath,
      runId,
    });
    try { await this.deleteFile(reportPath); } catch { /* absent is fine */ }
    const script = INTERACTION_SCRIPT.replace("__FORGEAAA_SPEC__", spec.replace(/\\/g, "\\\\").replace(/"/g, '\\"'));
    await this.writeFile(req.scriptPath, script);
    const iniPath = path.join(path.dirname(req.projectPath), "Config", "DefaultEngine.ini");
    const { restore, setEnginePid } = await this.acquireConfigOwnership(iniPath, req.scriptPath, runId);
    let result: UnrealCommandletResult & Pick<UnrealFunctionalTestResult, "configRestored" | "configRestoreDetail">;
    let config: { restored: boolean; detail: string };
    try {
      result = await this.runCommandlet({
        projectPath: req.projectPath,
        game: { map: req.levelPath },
        timeoutMs: req.timeoutMs,
        install: req.install,
        logPath: req.logPath,
        host: "editor",
        onSpawn: ({ pid }) => setEnginePid(pid),
      });
    } finally {
      config = await restore();
    }
    result = { ...result, configRestored: config.restored, configRestoreDetail: config.detail };
    if (result.timedOut) return { ...result, state: "timeout", scriptPath: req.scriptPath };
    let rep = (result.report ?? {}) as Record<string, unknown>;
    try {
      const onDisk = JSON.parse(await this.readFile(reportPath)) as Record<string, unknown>;
      if (onDisk.runId === runId) rep = onDisk;
      else rep = { executed: false, errors: [...(rep.errors as string[] ?? []), "stale report discarded"], stale: true };
    } catch {
      if (!result.report) rep = { executed: false, errors: ["no report produced"], not_executed: true };
    }
    if (rep.executed !== true) return { ...result, state: rep.errors ? "blocked" : "not_executed", scriptPath: req.scriptPath };
    const actionMetrics = (Array.isArray(rep.actions) ? rep.actions : []) as NonNullable<UnrealInteractionTestResult["actionMetrics"]>;
    // An action that never produced an engine metric is unmeasured, not passed — the
    // scenario that dies mid-run is blocked, never a silent success.
    let state: UnrealFunctionalTestState = actionMetrics.length >= req.actions.length ? "pass" : "blocked";
    const failures: string[] = [];
    if (actionMetrics.length < req.actions.length) {
      failures.push(`scenario incomplete: ${actionMetrics.length}/${req.actions.length} actions measured`);
    }
    req.actions.forEach((a, i) => {
      const m = actionMetrics?.[i];
      if (!a.expect || !m) return;
      if (a.expect.maxDisplacementCm !== undefined && m.displacementCm > a.expect.maxDisplacementCm) {
        state = "fail"; failures.push(`action[${i}] displacement ${m.displacementCm} > ${a.expect.maxDisplacementCm}`);
      }
      if (a.expect.minDisplacementCm !== undefined && m.displacementCm < a.expect.minDisplacementCm) {
        state = "fail"; failures.push(`action[${i}] displacement ${m.displacementCm} < ${a.expect.minDisplacementCm}`);
      }
      if (a.expect.minEndY !== undefined && m.end[1] < a.expect.minEndY) {
        state = "fail"; failures.push(`action[${i}] endY ${m.end[1]} < ${a.expect.minEndY}`);
      }
      if (a.expect.maxEndY !== undefined && m.end[1] > a.expect.maxEndY) {
        state = "fail"; failures.push(`action[${i}] endY ${m.end[1]} > ${a.expect.maxEndY}`);
      }
      if (a.expect.doorState !== undefined && m.doorState !== a.expect.doorState) {
        state = "fail"; failures.push(`action[${i}] doorState ${m.doorState} != ${a.expect.doorState}`);
      }
      if (a.expect.doorYawDeg !== undefined && (m.doorYawDeg === null || Math.abs(m.doorYawDeg - a.expect.doorYawDeg) > 3)) {
        state = "fail"; failures.push(`action[${i}] doorYaw ${m.doorYawDeg} != ${a.expect.doorYawDeg}`);
      }
      if (m.obsDoorYawDeg === undefined || m.obsDoorYawDeg === null) {
        if (state === "pass") state = "fail";
        failures.push(`action[${i}] observed door yaw missing: commanded rotation is unverified`);
      } else if (m.doorYawDeg !== null && Math.abs(m.obsDoorYawDeg - m.doorYawDeg) > 8) {
        if (state === "pass") state = "fail";
        failures.push(`action[${i}] observed door yaw ${m.obsDoorYawDeg} diverges from commanded ${m.doorYawDeg}: rotation not applied`);
      }
    });
    const metrics: Record<string, unknown> = {
      samples: Array.isArray(rep.samples) ? rep.samples.length : 0,
      door: rep.door ?? {},
      failures,
      errors: rep.errors ?? [],
    };
    return { ...result, state, scriptPath: req.scriptPath, metrics, actionMetrics };
  }
}

/**
 * Game-world interaction driver: same proven boot path as the traversal script
 * (world via find_object, pawn sweep, summon Character, MOVE_WALKING + physics-without-
 * controller) plus a door leaf actor — found by level label or summoned — whose yaw is
 * stepped toward a target every tick with live collision.
 */
const INTERACTION_SCRIPT = `import unreal, json, math
spec = json.loads("__FORGEAAA_SPEC__")
report = {"kind": "interaction", "level": spec["level"], "runId": spec["runId"], "executed": False,
          "samples": [], "actions": [], "door": {"interactions": 0}, "errors": [], "trace": []}
state = {"phase": "boot", "world": None, "pc": None, "char": None, "leaf": None,
         "action_idx": 0, "action_t": 0.0, "action_start": None, "moved": False,
         "t": 0.0, "last_sample_t": -1.0, "handle": None, "ticks": 0, "wait": 0}
door = {"closed_yaw": spec["door"]["closedYawDeg"],
        "open_yaw": spec["door"]["closedYawDeg"] + spec["door"]["openAngleDeg"],
        "rate": abs(spec["door"]["openAngleDeg"]) / spec["door"]["transitionS"]}
door["cur"] = door["open_yaw"] if spec["door"].get("initiallyOpen") else door["closed_yaw"]
door["target"] = door["cur"]

def door_state():
    if abs(door["cur"] - door["open_yaw"]) < 1.0: return "open"
    if abs(door["cur"] - door["closed_yaw"]) < 1.0: return "closed"
    return "opening" if abs(door["cur"] - door["open_yaw"]) < abs(door["cur"] - door["closed_yaw"]) else "closing"

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

def setup_door(ctx):
    # Prefer a persisted level actor (label or proximity match) — that is the
    # level-persistence path; otherwise summon a leaf and assign the mesh.
    hp = spec["door"]["hingeLocation"]
    leaf = None
    label = spec["door"].get("leafActorLabel")
    for a in unreal.GameplayStatics.get_all_actors_of_class(ctx, unreal.StaticMeshActor):
        try:
            if label and a.get_actor_label() == label:
                leaf = a; break
        except Exception:
            pass
    if leaf is None and label:
        report["errors"].append("leafActorLabel not found: " + label)
        return None
    if leaf is None:
        best = None; bestd = 50.0
        for a in unreal.GameplayStatics.get_all_actors_of_class(ctx, unreal.StaticMeshActor):
            try:
                p = a.get_actor_location()
                d = math.sqrt((p.x - hp[0])**2 + (p.y - hp[1])**2 + (p.z - hp[2])**2)
                if d < bestd: best, bestd = a, d
            except Exception:
                pass
        leaf = best
    if leaf is None:
        unreal.SystemLibrary.execute_console_command(ctx, "summon Engine.StaticMeshActor", state["pc"])
        actors = unreal.GameplayStatics.get_all_actors_of_class(ctx, unreal.StaticMeshActor)
        leaf = actors[len(actors) - 1] if len(actors) else None
        if leaf is not None:
            try:
                mesh = unreal.load_asset(spec["door"]["leafAsset"])
                leaf.static_mesh_component.set_static_mesh(mesh)
            except Exception as e:
                report["errors"].append("leaf mesh: " + str(e))
    if leaf is None:
        report["errors"].append("no door leaf actor")
        return None
    try:
        leaf.static_mesh_component.set_mobility(unreal.ComponentMobility.MOVABLE)
    except Exception as e:
        report["trace"].append("set_mobility_warn:" + str(e))
    leaf.set_actor_location(unreal.Vector(hp[0], hp[1], hp[2]), False, True)
    leaf.set_actor_rotation(unreal.Rotator(0, 0, door["cur"]), False)
    try:
        mob = leaf.static_mesh_component.mobility
        report["trace"].append("leaf_mobility:%s" % mob)
        if "STATIC" in str(mob):
            report["errors"].append("leaf mobility STATIC: rotation commands will be dropped")
    except Exception:
        pass
    return leaf

def door_tick(dt):
    leaf = state.get("leaf")
    if leaf is None or not unreal.SystemLibrary.is_valid(leaf):
        return
    diff = door["target"] - door["cur"]
    if abs(diff) > 0.05:
        step = door["rate"] * dt
        door["cur"] += step if diff > 0 else -step
        if abs(door["target"] - door["cur"]) < step:
            door["cur"] = door["target"]
        try:
            # Sweep-style rotation — never teleport; the observed yaw (sampled back
            # from the actor below) is the evidence, this call is only the command.
            leaf.set_actor_rotation(unreal.Rotator(0, 0, door["cur"]), False)
        except Exception as e:
            report["errors"].append("door rotate: " + str(e))

def begin_action():
    acts = spec["actions"]
    if state["action_idx"] >= len(acts):
        state["phase"] = "done"
        finish()
        return
    a = acts[state["action_idx"]]
    state["action_t"] = 0.0
    state["moved"] = False
    p = state["char"].get_actor_location()
    state["action_start"] = (p.x, p.y, p.z)
    if a["op"] == "interact":
        door["target"] = door["open_yaw"] if door_state() != "open" and door["target"] != door["open_yaw"] else door["closed_yaw"]
        report["door"]["interactions"] += 1
        report["trace"].append("interact:target=%s" % round(door["target"], 1))

def end_action():
    a = spec["actions"][state["action_idx"]]
    c = state["char"]
    p = c.get_actor_location()
    s = state["action_start"]
    m = {"op": a["op"], "displacementCm": round(math.hypot(p.x - s[0], p.y - s[1]), 2),
         "doorYawDeg": round(door["cur"], 2), "doorState": door_state(),
         "start": [round(v, 2) for v in s], "end": [round(p.x, 2), round(p.y, 2), round(p.z, 2)]}
    leaf = state.get("leaf")
    if leaf is not None and unreal.SystemLibrary.is_valid(leaf):
        try:
            m["obsDoorYawDeg"] = round(leaf.get_actor_rotation().yaw, 2)
        except Exception:
            pass
    pc = spec["door"].get("probeCenter")
    if pc is not None:
        try:
            rad = math.radians(door["closed_yaw"])
            nx, ny = -math.sin(rad), math.cos(rad)
            chan = getattr(getattr(unreal, "TraceChannel", None), "VISIBILITY", None)
            if chan is None:
                raise RuntimeError("visibility trace channel unavailable in this engine's python binding")
            hit = unreal.SystemLibrary.line_trace_single(state["world"],
                unreal.Vector(pc[0] - nx * 90, pc[1] - ny * 90, pc[2]), unreal.Vector(pc[0] + nx * 90, pc[1] + ny * 90, pc[2]),
                chan, False, [], unreal.DrawDebugTrace.NONE, True)
            out = unreal.SystemLibrary.break_hit_result(hit)
            m["probeHit"] = bool(out.blocking_hit)
            m["probeHitActor"] = out.hit_actor.get_actor_label() if out.hit_actor else None
        except Exception as e:
            m["probeError"] = str(e)
    report["actions"].append(m)
    state["action_idx"] += 1
    begin_action()

def tick(dt):
    state["ticks"] += 1
    if state["ticks"] > 30000:
        report["errors"].append("tick watchdog")
        finish()
        return
    try:
        door_tick(dt)
        if state["phase"] == "boot":
            ctx = resolve_context()
            if ctx is not None:
                state["world"] = ctx
                state["pc"] = unreal.GameplayStatics.get_player_controller(ctx, 0)
                report["trace"].append("world_ready:" + ctx.get_name())
                for p in unreal.GameplayStatics.get_all_actors_of_class(ctx, unreal.Pawn):
                    p.destroy_actor()
                state["leaf"] = setup_door(ctx)
                unreal.SystemLibrary.execute_console_command(ctx, "summon Engine.Character", state["pc"])
                state["phase"] = "spawn_wait"
        elif state["phase"] == "spawn_wait":
            chars = unreal.GameplayStatics.get_all_actors_of_class(state["world"], unreal.Character)
            if len(chars):
                c = chars[0]
                sp = spec["spawn"]
                c.set_actor_location(unreal.Vector(sp[0], sp[1], sp[2]), False, False)
                d0 = spec["actions"][0].get("direction") or [1, 0, 0]
                yaw = math.degrees(math.atan2(d0[1], d0[0]))
                c.set_actor_rotation(unreal.Rotator(0, 0, yaw), False)
                try:
                    c.character_movement.stop_movement_immediately()
                    c.character_movement.velocity = unreal.Vector(0, 0, 0)
                except Exception:
                    pass
                prep_char(c)
                state["char"] = c
                state["phase"] = "settle"
                state["settle"] = 0.0
            else:
                state["wait"] += 1
                if state["wait"] > 600:
                    report["errors"].append("spawn produced no Character")
                    finish()
        elif state["phase"] == "settle":
            state["settle"] += dt
            if state["settle"] >= 0.5:
                state["phase"] = "run"
                report["executed"] = True
                begin_action()
        elif state["phase"] == "run":
            c = state.get("char")
            if c is None or not unreal.SystemLibrary.is_valid(c):
                report["errors"].append("character lost mid-run")
                finish()
                return
            a = spec["actions"][state["action_idx"]]
            if a["op"] == "move":
                d = a["direction"]
                c.add_movement_input(unreal.Vector(d[0], d[1], d[2]), 1.0, True)
                state["moved"] = True
            state["action_t"] += dt
            state["t"] += dt
            if state["t"] - state["last_sample_t"] >= spec["samplePeriod"]:
                state["last_sample_t"] = state["t"]
                p = c.get_actor_location()
                v = c.get_velocity()
                leaf = state.get("leaf")
                obs_yaw = None
                if leaf is not None and unreal.SystemLibrary.is_valid(leaf):
                    try:
                        obs_yaw = round(leaf.get_actor_rotation().yaw, 2)
                    except Exception:
                        pass
                report["samples"].append({"t": round(state["t"], 2),
                    "x": round(p.x, 2), "y": round(p.y, 2), "z": round(p.z, 2),
                    "yaw": round(door["cur"], 2), "obsYaw": obs_yaw, "state": door_state(),
                    "v": round(math.sqrt(v.x*v.x + v.y*v.y + v.z*v.z), 2)})
            if state["action_t"] >= a["durationS"]:
                end_action()
    except Exception as e:
        report["errors"].append("tick: " + str(e))
        state["phase"] = "done"
        finish()

state["handle"] = unreal.register_slate_post_tick_callback(tick)
`;

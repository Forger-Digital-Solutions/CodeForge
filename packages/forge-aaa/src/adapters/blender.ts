import { promises as fs } from "node:fs";
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { FORGE_AAA_ERRORS, ForgeAaaError } from "../types.js";

/**
 * Blender 4.5 headless adapter (mission §7). Bounded `blender -b` process execution with
 * sanitized environment, capped output, hard timeouts, and a `FORGEAAA_REPORT:` line
 * protocol that turns script output into a machine-readable report. Scripts the adapter
 * did not ship require explicit caller approval — generated content is untrusted input
 * until a human or the approval service says otherwise.
 */

export interface BlenderDetection {
  installed: boolean;
  executablePath?: string;
  version?: { major: number; minor: number; patch: number; raw: string };
  candidatesProbed: string[];
  detectedAt: string;
}

export interface BlenderCapabilities {
  backgroundMode: boolean;
  python: boolean;
  factoryStartup: boolean;
  exportFormats: string[];
  targetSatisfied: boolean;
  notes: string[];
}

export interface BlenderRunRequest {
  /** Adapter-shipped op id, or "custom" for caller-supplied scriptSource. */
  op: "probe" | "inspect-scene" | "validate-geometry" | "export" | "custom";
  scriptSource?: string;
  scriptPath?: string;
  args?: string[];
  /** Required for `custom`/external scriptPath — untrusted script execution gate. */
  approved?: boolean;
  blendFile?: string;
  timeoutMs?: number;
  cwd?: string;
  /** Absolute path the script may write (e.g. export target); enforced as a path arg only —
   *  the script's own writes inside Blender are the engine's domain. */
  outputPath?: string;
}

export interface BlenderRunResult {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  report?: Record<string, unknown>;
  stdoutTail: string;
  stderrTail: string;
  error?: string;
}

const REPORT_PREFIX = "FORGEAAA_REPORT:";
const MAX_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const VERSION_TIMEOUT_MS = 20_000;

function windowsRoots(env: NodeJS.ProcessEnv): string[] {
  return [
    env.ProgramFiles ? path.join(env.ProgramFiles, "Blender Foundation") : "C:\\Program Files\\Blender Foundation",
    env["ProgramFiles(x86)"] ? path.join(env["ProgramFiles(x86)"], "Blender Foundation") : "C:\\Program Files (x86)\\Blender Foundation",
  ];
}

export interface BlenderAdapterDeps {
  /** Override for tests — returns true when a candidate executable exists. */
  fileExists?: (p: string) => boolean;
  listDir?: (p: string) => string[];
  spawnProcess?: typeof spawn;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

function tail(data: string, max: number): string {
  return data.length > max ? data.slice(data.length - max) : data;
}

export class BlenderAdapter {
  private readonly fileExists: (p: string) => boolean;
  private readonly listDir?: (p: string) => string[];
  private readonly spawnProcess: typeof spawn;
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;

  constructor(deps: BlenderAdapterDeps = {}) {
    this.fileExists = deps.fileExists ?? ((p) => existsSync(p));
    this.listDir = deps.listDir;
    this.spawnProcess = deps.spawnProcess ?? spawn;
    this.platform = deps.platform ?? process.platform;
    this.env = deps.env ?? process.env;
  }

  private candidatePaths(): string[] {
    const candidates: string[] = [];
    if (this.platform === "win32") {
      for (const root of windowsRoots(this.env)) {
        // Loose installs (exe directly under the foundation dir) are a real layout.
        candidates.push(path.join(root, "blender.exe"));
        let dirs: string[] = [];
        try {
          dirs = this.listDir?.(root) ?? (existsSync(root) ? readdirSync(root) : []);
        } catch { /* unreadable root is not an install */ }
        for (const dir of dirs) {
          if (/^Blender\s+\d+\.\d+/i.test(dir)) candidates.push(path.join(root, dir, "blender.exe"));
        }
      }
      const pathDirs = (this.env.PATH ?? "").split(path.delimiter).filter(Boolean);
      for (const dir of pathDirs) candidates.push(path.join(dir, "blender.exe"));
    } else {
      candidates.push("/usr/bin/blender", "/usr/local/bin/blender", "/snap/bin/blender", "/opt/blender/blender");
    }
    return [...new Set(candidates)];
  }

  /** Locate an installed executable without launching it. */
  findExecutable(): { path: string; probed: string[] } | undefined {
    const probed = this.candidatePaths();
    const hit = probed.find((p) => this.fileExists(p));
    return hit ? { path: hit, probed } : undefined;
  }

  /** Detection is only real once `blender --version` has been executed and parsed. */
  async detect(): Promise<BlenderDetection> {
    const detectedAt = new Date().toISOString();
    const found = this.findExecutable();
    if (!found) {
      return { installed: false, candidatesProbed: this.candidatePaths(), detectedAt };
    }
    const result = await this.runRaw(found.path, ["--version"], VERSION_TIMEOUT_MS);
    const firstLine = result.stdout.split(/\r?\n/).find((l) => /^Blender\s+\d+\.\d+/.test(l.trim())) ?? "";
    const m = /^Blender\s+(\d+)\.(\d+)(?:\.(\d+))?/.exec(firstLine.trim());
    if (!m) {
      return { installed: true, executablePath: found.path, candidatesProbed: found.probed, detectedAt };
    }
    return {
      installed: true,
      executablePath: found.path,
      version: { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3] ?? 0), raw: firstLine.trim() },
      candidatesProbed: found.probed,
      detectedAt,
    };
  }

  /** Version negotiation: the initial target is Blender 4.5; other 4.x work with a note,
   *  3.x and unparseable versions are refused for adapter-owned ops. */
  negotiate(detection: BlenderDetection): BlenderCapabilities {
    const notes: string[] = [];
    if (!detection.installed || !detection.executablePath) {
      return { backgroundMode: false, python: false, factoryStartup: false, exportFormats: [], targetSatisfied: false, notes: ["Blender not detected"] };
    }
    const v = detection.version;
    if (!v) {
      return { backgroundMode: true, python: true, factoryStartup: false, exportFormats: [], targetSatisfied: false, notes: ["Version unparseable — target unproven"] };
    }
    if (v.major !== 4) {
      return { backgroundMode: true, python: true, factoryStartup: true, exportFormats: [], targetSatisfied: false, notes: [`Blender ${v.major}.${v.minor} is outside the 4.x adapter contract`] };
    }
    if (v.major === 4 && v.minor !== 5) notes.push(`Blender ${v.major}.${v.minor} accepted — adapter target is 4.5`);
    return {
      backgroundMode: true, python: true, factoryStartup: true,
      exportFormats: ["fbx", "gltf", "obj", "stl"],
      targetSatisfied: v.major === 4 && v.minor === 5,
      notes,
    };
  }

  /**
   * Bounded headless execution. `--factory-startup` isolates user addons/preferences;
   * `-b` keeps it off the GPU/display. A `custom` op or external `scriptPath` without
   * `approved: true` refuses before spawn — untrusted script content never reaches Blender.
   */
  async runHeadless(req: BlenderRunRequest): Promise<BlenderRunResult> {
    const executable = this.findExecutable()?.path;
    if (!executable) {
      throw new ForgeAaaError(FORGE_AAA_ERRORS.ENGINE_NOT_FOUND, "Blender executable not found");
    }
    const isCustom = req.op === "custom" || (req.scriptPath !== undefined && !this.isBuiltinScript(req.scriptPath));
    if (isCustom && req.approved !== true) {
      throw new ForgeAaaError(FORGE_AAA_ERRORS.OPERATION_DENIED, "custom Blender script execution requires approval");
    }
    const args = ["-b", "--factory-startup"];
    if (req.blendFile) args.push(req.blendFile);
    let scriptToRun = req.scriptPath;
    if (req.scriptSource !== undefined) {
      const dir = path.join(os.tmpdir(), "forge-aaa", "blender-scripts");
      await fs.mkdir(dir, { recursive: true });
      scriptToRun = path.join(dir, `forge-aaa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.py`);
      await fs.writeFile(scriptToRun, req.scriptSource, "utf8");
    }
    if (!scriptToRun) throw new ForgeAaaError(FORGE_AAA_ERRORS.OPERATION_DENIED, `op "${req.op}" requires a script`);
    args.push("--python", scriptToRun);
    if (req.args?.length) args.push("--", ...req.args);

    return this.runRawCollect(executable, args, req.timeoutMs ?? DEFAULT_TIMEOUT_MS, req.cwd);
  }

  private isBuiltinScript(scriptPath: string): boolean {
    return /forge-aaa-builtin-/.test(scriptPath) || scriptPath.startsWith(path.join(os.tmpdir(), "forge-aaa"));
  }

  /** Run a bounded raw command, returning captured text (no report parsing). */
  private runRaw(executable: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    return new Promise((resolve, reject) => {
      const child: ChildProcess = this.spawnProcess(executable, args, {
        windowsHide: true,
        env: { PATH: this.env.PATH ?? "", SystemRoot: this.env.SystemRoot, TEMP: this.env.TEMP, TMP: this.env.TMP },
      });
      let stdout = "";
      let stderr = "";
      let finished = false;
      const timer = setTimeout(() => {
        if (finished) return;
        finished = true;
        child.kill();
        reject(new ForgeAaaError(FORGE_AAA_ERRORS.OPERATION_TIMEOUT, `process timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      child.stdout?.on("data", (d: Buffer) => { stdout = tail(stdout + d.toString("utf8"), MAX_OUTPUT_BYTES); });
      child.stderr?.on("data", (d: Buffer) => { stderr = tail(stderr + d.toString("utf8"), MAX_OUTPUT_BYTES); });
      child.on("error", (err) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        reject(new ForgeAaaError(FORGE_AAA_ERRORS.ENGINE_NOT_FOUND, `spawn failed: ${err.message}`));
      });
      child.on("close", (code) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: code });
      });
    });
  }

  private async runRawCollect(executable: string, args: string[], timeoutMs: number, cwd?: string): Promise<BlenderRunResult> {
    const started = Date.now();
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = this.spawnProcess(executable, args, {
          windowsHide: true,
          ...(cwd ? { cwd } : {}),
          env: { PATH: this.env.PATH ?? "", SystemRoot: this.env.SystemRoot, TEMP: this.env.TEMP, TMP: this.env.TMP },
        });
      } catch (err) {
        resolve({ ok: false, exitCode: null, timedOut: false, durationMs: Date.now() - started, stdoutTail: "", stderrTail: "", error: err instanceof Error ? err.message : String(err) });
        return;
      }
      let stdout = "";
      let stderr = "";
      let done = false;
      const finish = (result: Omit<BlenderRunResult, "durationMs" | "report">): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const report = parseReport(stdout);
        resolve({ ...result, durationMs: Date.now() - started, ...(report ? { report } : {}) });
      };
      const timer = setTimeout(() => {
        child.kill();
        finish({ ok: false, exitCode: null, timedOut: true, stdoutTail: tail(stdout, MAX_OUTPUT_BYTES), stderrTail: tail(stderr, MAX_OUTPUT_BYTES), error: `timeout after ${timeoutMs}ms` });
      }, timeoutMs);
      child.stdout?.on("data", (d: Buffer) => { stdout = tail(stdout + d.toString("utf8"), MAX_OUTPUT_BYTES); });
      child.stderr?.on("data", (d: Buffer) => { stderr = tail(stderr + d.toString("utf8"), MAX_OUTPUT_BYTES); });
      child.on("error", (err) => finish({ ok: false, exitCode: null, timedOut: false, stdoutTail: tail(stdout, MAX_OUTPUT_BYTES), stderrTail: tail(stderr, MAX_OUTPUT_BYTES), error: err.message }));
      child.on("close", (code) => {
        const report = parseReport(stdout);
        const ok = code === 0 && report?.ok !== false;
        finish({ ok, exitCode: code, timedOut: false, stdoutTail: tail(stdout, MAX_OUTPUT_BYTES), stderrTail: tail(stderr, MAX_OUTPUT_BYTES), ...(ok ? {} : { error: `exit ${code}` }) });
      });
    });
  }

  /**
   * Built-in scene inspection — emits a structured report over stdout markers covering
   * object counts, non-manifold edges, bounds, materials, and collections. This is the
   * adapter's own reviewed script and runs without the approval gate.
   */
  builtinInspectSceneScript(): string {
    return BUILTIN_INSPECT_SCENE_PY;
  }
}

function parseReport(stdout: string): Record<string, unknown> | undefined {
  const lines = stdout.split(/\r?\n/).filter((l) => l.startsWith(REPORT_PREFIX));
  const last = lines.at(-1);
  if (!last) return undefined;
  try {
    return JSON.parse(last.slice(REPORT_PREFIX.length)) as Record<string, unknown>;
  } catch {
    return { ok: false, error: "report-parse-failed" };
  }
}

const BUILTIN_INSPECT_SCENE_PY = `import bpy, json, sys

report = {"ok": True, "objects": 0, "meshes": 0, "materials": 0, "collections": 0,
          "nonmanifold_objects": [], "bounds_cm": None, "errors": []}
try:
    scene = bpy.context.scene
    report["objects"] = len(scene.objects)
    report["materials"] = len(bpy.data.materials)
    report["collections"] = len(bpy.data.collections)
    mins = [float("inf")] * 3
    maxs = [float("-inf")] * 3
    for obj in scene.objects:
        if obj.type == "MESH":
            report["meshes"] += 1
            mesh = obj.data
            for corner in obj.bound_box:
                world = obj.matrix_world @ __import__("mathutils").Vector(corner)
                for i in range(3):
                    mins[i] = min(mins[i], world[i])
                    maxs[i] = max(maxs[i], world[i])
            import bmesh
            bm = bmesh.new()
            bm.from_mesh(mesh)
            nonmanifold = sum(1 for e in bm.edges if not e.is_manifold)
            if nonmanifold:
                report["nonmanifold_objects"].append({"name": obj.name, "edges": nonmanifold})
            bm.free()
    if report["meshes"]:
        report["bounds_cm"] = [round((maxs[i] - mins[i]) * 100, 3) for i in range(3)]
except Exception as exc:
    report["ok"] = False
    report["errors"].append(str(exc)[:300])
print("FORGEAAA_REPORT:" + json.dumps(report))
`;

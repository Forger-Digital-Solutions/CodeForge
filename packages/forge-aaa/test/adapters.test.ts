import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ChildProcess } from "node:child_process";
import { BlenderAdapter, UnrealAdapter } from "../src/index.js";

function fakeSpawn(stdout: string, stderr = "", code = 0, recordArgs?: (args: string[]) => void) {
  return (_cmd: string, args?: readonly string[]) => {
    recordArgs?.([...(args ?? [])]);
    const child = new EventEmitter() as unknown as ChildProcess;
    const out = new EventEmitter();
    const err = new EventEmitter();
    Object.assign(child, { stdout: out, stderr: err, kill: () => true });
    setImmediate(() => {
      if (stdout) out.emit("data", Buffer.from(stdout));
      if (stderr) err.emit("data", Buffer.from(stderr));
      child.emit("close", code);
    });
    return child;
  };
}

describe("BlenderAdapter", () => {
  const blenderDir = "C:\\Program Files\\Blender Foundation";
  const exe = path.join(blenderDir, "Blender 4.5", "blender.exe");

  it("detects a real install layout and parses --version output", async () => {
    const adapter = new BlenderAdapter({
      platform: "win32",
      fileExists: (p) => p === exe,
      listDir: (p) => (p === blenderDir ? ["Blender 4.5"] : []),
      spawnProcess: fakeSpawn("Blender 4.5.3\n\tbuild hash: abc\n") as never,
      env: { ProgramFiles: blenderDir.replace("\\Blender Foundation", ""), PATH: "" },
    });
    const detection = await adapter.detect();
    expect(detection.installed).toBe(true);
    expect(detection.executablePath).toBe(exe);
    expect(detection.version).toMatchObject({ major: 4, minor: 5 });
  });

  it("reports not-installed without inventing a path", async () => {
    const adapter = new BlenderAdapter({ platform: "win32", fileExists: () => false, listDir: () => [], env: { PATH: "" } });
    const detection = await adapter.detect();
    expect(detection.installed).toBe(false);
    expect(detection.candidatesProbed.length).toBeGreaterThan(0);
  });

  it("negotiates capability by parsed version — 4.5 satisfies the target, 3.x is refused", async () => {
    const mk = (version: string) => new BlenderAdapter({
      platform: "win32",
      fileExists: () => true,
      listDir: () => ["Blender 4.5"],
      spawnProcess: fakeSpawn(`Blender ${version}\n`) as never,
      env: { ProgramFiles: blenderDir.replace("\\Blender Foundation", ""), PATH: "" },
    });
    const ok = await mk("4.5.0").detect();
    expect(mk("4.5.0").negotiate(ok).targetSatisfied).toBe(true);
    const old = await mk("3.6.0").detect();
    expect(mk("3.6.0").negotiate(old).targetSatisfied).toBe(false);
  });

  it("runs a bounded headless script and parses the FORGEAAA_REPORT marker", async () => {
    const report = JSON.stringify({ ok: true, objects: 3, meshes: 2, nonmanifold_objects: [], bounds_cm: [100, 50, 30] });
    const adapter = new BlenderAdapter({
      platform: "win32",
      fileExists: (p) => p === exe,
      listDir: () => ["Blender 4.5"],
      spawnProcess: fakeSpawn(`Blender 4.5.3\nFORGEAAA_REPORT:${report}\n`) as never,
      env: { ProgramFiles: blenderDir.replace("\\Blender Foundation", ""), PATH: "" },
    });
    const script = path.join(os.tmpdir(), "forge-aaa", "blender-scripts", "test-builtin.py");
    const result = await adapter.runHeadless({ op: "inspect-scene", scriptPath: script, approved: true });
    expect(result.ok).toBe(true);
    expect(result.report?.meshes).toBe(2);
  });

  it("refuses unapproved custom scripts before spawning", async () => {
    const adapter = new BlenderAdapter({ platform: "win32", fileExists: () => true, listDir: () => ["Blender 4.5"], env: { PATH: "" } });
    await expect(adapter.runHeadless({ op: "custom", scriptSource: "print(1)" })).rejects.toThrowError(/OPERATION_DENIED|approval/i);
  });
});

describe("UnrealAdapter", () => {
  it("parses Build.version and locates editor binaries", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "forge-aaa-ue-"));
    const root = path.join(dir, "UE_4.27");
    await fs.mkdir(path.join(root, "Engine", "Build"), { recursive: true });
    await fs.mkdir(path.join(root, "Engine", "Binaries", "Win64"), { recursive: true });
    await fs.writeFile(path.join(root, "Engine", "Build", "Build.version"), JSON.stringify({ MajorVersion: 4, MinorVersion: 27, PatchVersion: 2, Changelist: 18319896, BranchName: "++UE4+Release-4.27" }));
    await fs.writeFile(path.join(root, "Engine", "Binaries", "Win64", "UE4Editor-Cmd.exe"), "bin");
    const adapter = new UnrealAdapter({ platform: "linux", extraRoots: [dir] });
    const detection = await adapter.detect();
    expect(detection.installed).toBe(true);
    expect(detection.installs[0]?.version).toMatchObject({ major: 4, minor: 27, patch: 2 });
    expect(detection.installs[0]?.editorCmdPath).toContain("UE4Editor-Cmd.exe");
  });

  it("negotiates the 4.27 capability contract and refuses UE5", () => {
    const adapter = new UnrealAdapter();
    const caps = adapter.negotiate({ root: "/x", version: { major: 4, minor: 27, patch: 2 }, editorCmdPath: "/x/UE4Editor-Cmd.exe" });
    expect(caps.supported).toBe(true);
    expect(caps.pythonScripting).toBe("plugin_required");
    const ue5 = adapter.negotiate({ root: "/y", version: { major: 5, minor: 4, patch: 0 } });
    expect(ue5.supported).toBe(false);
    expect(ue5.pythonScripting).toBe("unavailable");
  });

  it("inspects .uproject files — association, plugins, targets", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "forge-aaa-uproj-"));
    const up = path.join(dir, "DeadTrailsWest.uproject");
    await fs.writeFile(up, JSON.stringify({
      FileVersion: 3, EngineAssociation: "4.27", Category: "Games",
      Plugins: [{ Name: "RemoteControl", Enabled: true }],
      Targets: [{ Name: "DeadTrailsWest" }],
    }));
    const info = await new UnrealAdapter().inspectProject(up);
    expect(info.engineAssociation).toBe("4.27");
    expect(info.plugins).toEqual([{ name: "RemoteControl", enabled: true }]);
    expect(info.targets).toEqual(["DeadTrailsWest"]);
  });

  it("rejects unsafe commandlet names before spawning", async () => {
    const adapter = new UnrealAdapter();
    await expect(adapter.runCommandlet({
      projectPath: "p.uproject", commandlet: "evil; rm -rf",
      install: { root: "/x", version: { major: 4, minor: 27, patch: 2 }, editorCmdPath: "/x/bin" },
    })).rejects.toThrowError(/OPERATION_DENIED|safe token/i);
  });

  it("ensurePlugins adds missing plugins additively and preserves existing entries", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "forge-aaa-plug-"));
    const up = path.join(dir, "Pilot.uproject");
    await fs.writeFile(up, JSON.stringify({
      FileVersion: 3, EngineAssociation: "4.27",
      Plugins: [{ Name: "RemoteControl", Enabled: true }],
    }));
    const r = await new UnrealAdapter().ensurePlugins(up, ["PythonScriptPlugin", "EditorScriptingUtilities"]);
    expect(r.added.sort()).toEqual(["EditorScriptingUtilities", "PythonScriptPlugin"]);
    expect(r.plugins).toContainEqual({ name: "RemoteControl", enabled: true });
    const saved = JSON.parse(await fs.readFile(up, "utf8")) as { Plugins: { Name: string; Enabled: boolean }[] };
    expect(saved.Plugins.map((p) => p.Name)).toEqual(["RemoteControl", "PythonScriptPlugin", "EditorScriptingUtilities"]);
    const again = await new UnrealAdapter().ensurePlugins(up, ["PythonScriptPlugin"]);
    expect(again.added).toEqual([]);
  });

  it("runPythonScript rejects missing scripts and non-.py files before spawning", async () => {
    const adapter = new UnrealAdapter();
    await expect(adapter.runPythonScript({ projectPath: "p.uproject", scriptPath: "C:\\nope.py" }))
      .rejects.toThrowError(/MANIFEST_INVALID|missing/);
    await expect(adapter.runPythonScript({ projectPath: "p.uproject", scriptPath: "C:\\real.txt" }))
      .rejects.toThrowError();
  });

  it("placeAssets enforces /Game paths and safe actor names before spawning", async () => {
    const adapter = new UnrealAdapter({ fileExists: () => true });
    const base = { projectPath: "p.uproject", scriptPath: "C:\\s.py" };
    await expect(adapter.placeAssets({ ...base, levelPath: "/Engine/Bad", placements: [] }))
      .rejects.toThrowError(/under \/Game/);
    await expect(adapter.placeAssets({ ...base, levelPath: "/Game/L", placements: [{ assetPath: "C:\\evil.fbx", name: "A", location: [0, 0, 0] }] }))
      .rejects.toThrowError(/under \/Game/);
    await expect(adapter.placeAssets({ ...base, levelPath: "/Game/L", placements: [{ assetPath: "/Game/A", name: "bad name!", location: [0, 0, 0] }] }))
      .rejects.toThrowError(/invalid placement name/);
  });

  it("placeAssets writes a reviewed script, invokes PythonScript commandlet, and parses the report", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "forge-aaa-place-"));
    const scriptPath = path.join(dir, "placement.py");
    const report = JSON.stringify({ ok: true, level: "/Game/ForgeAAA/Maps/L_Test", placed: [{ name: "Stair", actor: "Stair", action: "spawned" }] });
    const adapter = new UnrealAdapter({
      platform: "win32",
      fileExists: () => true,
      spawnProcess: fakeSpawn(`log lines\nFORGEAAA_REPORT:${report}\n`) as never,
      env: { PATH: "" },
    });
    const result = await adapter.placeAssets({
      projectPath: "p.uproject",
      levelPath: "/Game/ForgeAAA/Maps/L_Test",
      placements: [{ assetPath: "/Game/ForgeAAA/SM_Stair", name: "Stair", location: [0, 0, 0], rotation: [0, 0, 90] }],
      scriptPath,
      install: { root: "/x", version: { major: 4, minor: 27, patch: 2 }, editorCmdPath: "/x/bin" },
    });
    const script = await fs.readFile(scriptPath, "utf8");
    expect(script).toContain("unreal");
    expect(script).toContain("/Game/ForgeAAA/Maps/L_Test");
    expect(script).toContain("SM_Stair");
    expect(result.placed).toEqual([{ name: "Stair", actor: "Stair", action: "spawned" }]);
    expect(result.report?.ok).toBe(true);
  });

  describe("runFunctionalTest", () => {
    const install = { root: "/x", version: { major: 4, minor: 27, patch: 2 }, editorCmdPath: "/x/cmd", editorPath: "/x/editor" };
    const traversal = { spawn: [-160, 0, 100] as [number, number, number], inputDirection: [1, 0, 0] as [number, number, number], durationS: 5 };

    const mkProject = async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "forge-aaa-ft-"));
      const projectPath = path.join(dir, "Pilot.uproject");
      await fs.writeFile(projectPath, "{}");
      return { dir, projectPath };
    };

    it("rejects unsafe levels, non-unit input, and absurd durations before spawning", async () => {
      const adapter = new UnrealAdapter({ fileExists: () => true });
      const base = { projectPath: "p.uproject", scriptPath: "C:\\s.py" };
      await expect(adapter.runFunctionalTest({ ...base, levelPath: "/Engine/X", traversal }))
        .rejects.toThrowError(/under \/Game/);
      await expect(adapter.runFunctionalTest({ ...base, levelPath: "/Game/L", traversal: { ...traversal, inputDirection: [2, 0, 0] } }))
        .rejects.toThrowError(/unit vector/);
      await expect(adapter.runFunctionalTest({ ...base, levelPath: "/Game/L", traversal: { ...traversal, durationS: 0 } }))
        .rejects.toThrowError(/durationS/);
    });

    it("injects the StartupScripts setting into DefaultEngine.ini and restores it after the run", async () => {
      const { dir, projectPath } = await mkProject();
      const iniPath = path.join(dir, "Config", "DefaultEngine.ini");
      await fs.mkdir(path.dirname(iniPath), { recursive: true });
      await fs.writeFile(iniPath, "[/Script/Engine.Engine]\nSentinel=1\n");
      let seenIni = "";
      const adapter = new UnrealAdapter({
        platform: "win32",
        fileExists: () => true,
        spawnProcess: ((_cmd: string, args?: readonly string[]) => {
          const child = new EventEmitter() as unknown as ChildProcess;
          Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true });
          setImmediate(async () => {
            seenIni = await fs.readFile(iniPath, "utf8");
            child.emit("close", 0);
          });
          return child;
        }) as never,
      });
      await adapter.runFunctionalTest({
        projectPath, levelPath: "/Game/L", scriptPath: path.join(dir, "ft.py"), traversal, install,
      });
      expect(seenIni).toContain("[/Script/PythonScriptPlugin.PythonScriptPluginSettings]");
      expect(seenIni).toContain("+StartupScripts=");
      expect(seenIni).toContain("Sentinel=1");
      expect(await fs.readFile(iniPath, "utf8")).toBe("[/Script/Engine.Engine]\nSentinel=1\n");
    });

    it("launches the editor in -game mode on the test map", async () => {
      const { dir, projectPath } = await mkProject();
      let captured: string[] = [];
      let capturedCmd = "";
      const adapter = new UnrealAdapter({
        platform: "win32",
        fileExists: () => true,
        spawnProcess: ((cmd: string, args?: readonly string[]) => {
          capturedCmd = cmd; captured = [...(args ?? [])];
          const child = new EventEmitter() as unknown as ChildProcess;
          Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true });
          setImmediate(() => child.emit("close", 0));
          return child;
        }) as never,
      });
      await adapter.runFunctionalTest({
        projectPath, levelPath: "/Game/ForgeAAA/Maps/FAAA_Traversal", scriptPath: path.join(dir, "ft.py"), traversal, install,
      });
      expect(capturedCmd).toBe("/x/editor");
      expect(captured).toContain("-game");
      expect(captured).toContain("/Game/ForgeAAA/Maps/FAAA_Traversal");
      expect(captured).not.toContain("-ExecutePythonScript=");
    });

    it("parses a fresh runId-matched report file into pass metrics", async () => {
      const { dir, projectPath } = await mkProject();
      const scriptPath = path.join(dir, "ft.py");
      const adapter = new UnrealAdapter({
        platform: "win32",
        fileExists: () => true,
        spawnProcess: (() => {
          const child = new EventEmitter() as unknown as ChildProcess;
          Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true });
          setImmediate(async () => {
            const src = await fs.readFile(scriptPath, "utf8");
            const specJson = src.match(/json\.loads\("(.+)"\)/)![1]!.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
            const spec = JSON.parse(specJson) as { reportPath: string; runId: string };
            await fs.writeFile(spec.reportPath, JSON.stringify({
              runId: spec.runId, executed: true, errors: [],
              samples: [
                { t: 0, x: -160, y: 0, z: 90 }, { t: 0.1, x: -120, y: 0, z: 90 },
                { t: 0.5, x: 60, y: 0, z: 160 }, { t: 1, x: 118, y: 0, z: 198 },
              ],
            }));
            child.emit("close", 0);
          });
          return child;
        }) as never,
      });
      const r = await adapter.runFunctionalTest({
        projectPath, levelPath: "/Game/L", scriptPath, traversal,
        install, timeoutMs: 5000,
      });
      expect(r.state).toBe("pass");
      const m = r.metrics as { samples: number; zGain: number; displacementCm: number };
      expect(m.samples).toBe(4);
      expect(m.zGain).toBeCloseTo(108);
    });

    it("rejects stale reports whose runId does not match this run", async () => {
      const { dir, projectPath } = await mkProject();
      const scriptPath = path.join(dir, "ft.py");
      const stalePath = scriptPath.replace(/\.py$/i, ".report.json");
      await fs.writeFile(stalePath, JSON.stringify({ runId: "old-run", executed: true, samples: [{ t: 0, x: 0, y: 0, z: 0 }] }));
      const adapter = new UnrealAdapter({
        platform: "win32",
        fileExists: () => true,
        spawnProcess: fakeSpawn("") as never,
      });
      const r = await adapter.runFunctionalTest({
        projectPath, levelPath: "/Game/L", scriptPath, traversal, install, timeoutMs: 5000,
      });
      expect(r.state).toBe("blocked");
    });

    it("maps no-report process exit to blocked, never pass", async () => {
      const { dir, projectPath } = await mkProject();
      const adapter = new UnrealAdapter({
        platform: "win32",
        fileExists: () => true,
        spawnProcess: fakeSpawn("") as never,
      });
      const r = await adapter.runFunctionalTest({
        projectPath, levelPath: "/Game/L", scriptPath: path.join(dir, "ft.py"), traversal, install, timeoutMs: 5000,
      });
      expect(r.state).toBe("blocked");
    });

    it("maps engine timeout to timeout state", async () => {
      const { dir, projectPath } = await mkProject();
      const adapter = new UnrealAdapter({
        platform: "win32",
        fileExists: () => true,
        spawnProcess: (() => {
          const child = new EventEmitter() as unknown as ChildProcess;
          // kill() must not emit "close" synchronously — the real child exits after the
          // timer's finish() has already claimed the timedOut result.
          Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true });
          return child;
        }) as never,
      });
      const r = await adapter.runFunctionalTest({
        projectPath, levelPath: "/Game/L", scriptPath: path.join(dir, "ft.py"), traversal, install, timeoutMs: 60,
      });
      expect(r.state).toBe("timeout");
    });

    // Snapshot the lock/backup/injected-ini artifacts mid-run, let the normal restore
    // finish, then replay them to stand in for a process that died before restoring.
    const replayAbandonedState = async (dir: string) => {
      const snap = await fs.readFile(path.join(dir, "snap.json"), "utf8");
      const { ini, iniPath, lock, backup, backupPath } = JSON.parse(snap) as {
        ini: string; iniPath: string; lock: string; backup: string | null; backupPath: string | null;
      };
      await fs.mkdir(path.dirname(iniPath), { recursive: true });
      await fs.writeFile(iniPath, ini);
      await fs.writeFile(`${iniPath}.forgeaaa.lock`, lock);
      if (backup !== null && backupPath) await fs.writeFile(backupPath, backup);
      return { iniPath, backupPath, lockPath: `${iniPath}.forgeaaa.lock` };
    };

    const snapshottingSpawn = (dir: string, iniPath: string) => ((() => {
      const child = new EventEmitter() as unknown as ChildProcess;
      Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true });
      setImmediate(async () => {
        const ini = await fs.readFile(iniPath, "utf8");
        const lock = await fs.readFile(`${iniPath}.forgeaaa.lock`, "utf8");
        const { backupPath } = JSON.parse(lock) as { backupPath: string | null };
        const backup = backupPath ? await fs.readFile(backupPath, "utf8") : null;
        await fs.writeFile(path.join(dir, "snap.json"), JSON.stringify({ ini, iniPath, lock, backup, backupPath }));
        child.emit("close", 0);
      });
      return child;
    }) as never);

    it("recovers an abandoned lock+backup left by a crashed run and still owns the ini", async () => {
      const { dir, projectPath } = await mkProject();
      const iniPath = path.join(dir, "Config", "DefaultEngine.ini");
      const sentinel = "[/Script/Engine.Engine]\nSentinel=1\n";
      await fs.mkdir(path.dirname(iniPath), { recursive: true });
      await fs.writeFile(iniPath, sentinel);
      const adapter = new UnrealAdapter({
        platform: "win32", fileExists: () => true,
        spawnProcess: snapshottingSpawn(dir, iniPath),
      });
      await adapter.runFunctionalTest({
        projectPath, levelPath: "/Game/L", scriptPath: path.join(dir, "ft.py"), traversal, install,
      });
      const { backupPath, lockPath } = await replayAbandonedState(dir);
      await adapter.runFunctionalTest({
        projectPath, levelPath: "/Game/L", scriptPath: path.join(dir, "ft2.py"), traversal, install,
      });
      expect(await fs.readFile(iniPath, "utf8")).toBe(sentinel);
      await expect(fs.access(lockPath)).rejects.toThrow();
      if (backupPath) await expect(fs.access(backupPath)).rejects.toThrow();
    });

    it("fails closed when an abandoned lock's ini no longer matches the recorded bytes", async () => {
      const { dir, projectPath } = await mkProject();
      const iniPath = path.join(dir, "Config", "DefaultEngine.ini");
      await fs.mkdir(path.dirname(iniPath), { recursive: true });
      await fs.writeFile(iniPath, "[/Script/Engine.Engine]\nSentinel=1\n");
      const adapter = new UnrealAdapter({
        platform: "win32", fileExists: () => true,
        spawnProcess: snapshottingSpawn(dir, iniPath),
      });
      await adapter.runFunctionalTest({
        projectPath, levelPath: "/Game/L", scriptPath: path.join(dir, "ft.py"), traversal, install,
      });
      const { lockPath } = await replayAbandonedState(dir);
      const userEdited = await fs.readFile(iniPath, "utf8") + "\nUserEdit=1\n";
      await fs.writeFile(iniPath, userEdited);
      await expect(adapter.runFunctionalTest({
        projectPath, levelPath: "/Game/L", scriptPath: path.join(dir, "ft2.py"), traversal, install,
      })).rejects.toThrowError(/abandoned config lock/);
      expect(await fs.readFile(iniPath, "utf8")).toBe(userEdited);
      await expect(fs.access(lockPath)).resolves.toBeUndefined();
    });

    it("does not clobber an ini edited mid-test — reports configRestored=false and keeps the backup", async () => {
      const { dir, projectPath } = await mkProject();
      const iniPath = path.join(dir, "Config", "DefaultEngine.ini");
      const sentinel = "[/Script/Engine.Engine]\nSentinel=1\n";
      await fs.mkdir(path.dirname(iniPath), { recursive: true });
      await fs.writeFile(iniPath, sentinel);
      const adapter = new UnrealAdapter({
        platform: "win32", fileExists: () => true,
        spawnProcess: ((() => {
          const child = new EventEmitter() as unknown as ChildProcess;
          Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true });
          setImmediate(async () => {
            await fs.appendFile(iniPath, "\nMidTestEdit=1\n");
            child.emit("close", 0);
          });
          return child;
        }) as never),
      });
      const r = await adapter.runFunctionalTest({
        projectPath, levelPath: "/Game/L", scriptPath: path.join(dir, "ft.py"), traversal, install,
      });
      expect(r.configRestored).toBe(false);
      expect(r.configRestoreDetail).toContain("ini changed during test");
      const current = await fs.readFile(iniPath, "utf8");
      expect(current).toContain("MidTestEdit=1");
      expect(current).toContain("PythonScriptPlugin");
      const lock = JSON.parse(await fs.readFile(`${iniPath}.forgeaaa.lock`, "utf8")) as { backupPath: string };
      expect(await fs.readFile(lock.backupPath, "utf8")).toBe(sentinel);
    });
  });
});

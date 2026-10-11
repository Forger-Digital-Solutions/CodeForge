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
});

import { describe, expect, it } from "vitest";
import {
  defaultDoorSpec, parseDoorSpecFromText, validateDoorSpec, doorBlenderScript,
  UnrealAdapter, parseReviewResult,
} from "../src/index.js";

describe("doorSpec validation", () => {
  it("accepts the default spec and preserves signed open angle", () => {
    const s = defaultDoorSpec();
    expect(s.motion.openAngleDeg).toBe(-95);
    expect(s.hinge.side).toBe("left");
  });

  it("rejects out-of-range dimensions and invalid hinge side", () => {
    const base = defaultDoorSpec() as unknown as Record<string, unknown>;
    expect(() => validateDoorSpec({ ...base, opening: { widthCm: 10, heightCm: 210 } })).toThrowError(/opening\.widthCm/);
    expect(() => validateDoorSpec({ ...base, hinge: { side: "middle", pivotOffsetCm: 2 } })).toThrowError(/hinge\.side/);
    expect(() => validateDoorSpec({ ...base, motion: { openAngleDeg: 0, transitionS: 1 } })).toThrowError(/openAngleDeg/);
    expect(() => validateDoorSpec({ ...base, motion: { openAngleDeg: 200, transitionS: 1 } })).toThrowError(/openAngleDeg/);
    expect(() => validateDoorSpec({ ...base, moduleId: "x" })).toThrowError(/moduleId/);
  });

  it("accepts a positive open angle and rounds battens to an integer", () => {
    const s = validateDoorSpec({ ...defaultDoorSpec(), motion: { openAngleDeg: 95, transitionS: 1 }, leaf: { thicknessCm: 5, clearanceCm: 1, battens: 2.6 } });
    expect(s.motion.openAngleDeg).toBe(95);
    expect(s.leaf.battens).toBe(3);
  });
});

describe("parseDoorSpecFromText", () => {
  it("extracts a valid spec from fenced model output", () => {
    const text = "Here is the spec:\n```json\n" + JSON.stringify(defaultDoorSpec()) + "\n```";
    const r = parseDoorSpecFromText(text);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.spec.opening.widthCm).toBe(100);
  });
  it("rejects empty and schema-invalid output", () => {
    expect(parseDoorSpecFromText("").ok).toBe(false);
    expect(parseDoorSpecFromText('{"opening":{"widthCm":5}}').ok).toBe(false);
  });
});

describe("doorBlenderScript", () => {
  it("embeds the spec JSON and emits both meshes with sockets and UCX", () => {
    const script = doorBlenderScript(defaultDoorSpec());
    expect(script).toContain('"opening":{"widthCm":100');
    expect(script).toContain("SM_DoorFrame");
    expect(script).toContain("SM_DoorLeaf");
    expect(script).toContain("UCX_");
    expect(script).toContain("SOCKET_");
    expect(script).toContain("ORIGIN_CURSOR");
  });
});

describe("parseReviewResult", () => {
  it("maps a clean pass verdict", () => {
    const r = parseReviewResult('{"verdict":"pass","findings":[{"severity":"advisory","category":"scope","message":"x"}],"summary":"ok"}');
    expect(r.ok).toBe(true);
    expect(r.verdict).toBe("pass");
    expect(r.findings).toHaveLength(1);
  });
  it("rejects pass-with-blocking-finding and revision-without-blocking", () => {
    expect(parseReviewResult('{"verdict":"pass","findings":[{"severity":"blocking","category":"x","message":"m"}],"summary":"s"}').ok).toBe(false);
    expect(parseReviewResult('{"verdict":"revision_required","findings":[],"summary":"s"}').ok).toBe(false);
  });
  it("rejects non-JSON and invalid verdicts", () => {
    expect(parseReviewResult("no json").ok).toBe(false);
    expect(parseReviewResult('{"verdict":"maybe","findings":[],"summary":"s"}').ok).toBe(false);
  });
});

describe("runInteractionTest validation", () => {
  const install = { root: "/x", version: { major: 4, minor: 27, patch: 2 }, editorCmdPath: "/x/cmd", editorPath: "/x/editor" };
  const door = { leafAsset: "/Game/ForgeAAA/SM_DoorLeaf", hingeLocation: [-48, 0, 0] as [number, number, number], closedYawDeg: 0, openAngleDeg: -95, transitionS: 0.8 };
  const base = { projectPath: "p.uproject", scriptPath: "C:\\i.py", levelPath: "/Game/Maps/Door", spawn: [0, -150, 92] as [number, number, number], install };

  it("rejects unsafe inputs before spawning", async () => {
    const adapter = new UnrealAdapter({ fileExists: () => true });
    const move = { op: "move" as const, direction: [0, 1, 0] as [number, number, number], durationS: 2 };
    await expect(adapter.runInteractionTest({ ...base, levelPath: "/Engine/X", door, actions: [move] })).rejects.toThrowError(/under \/Game/);
    await expect(adapter.runInteractionTest({ ...base, door: { ...door, leafAsset: "/Etc/SM" }, actions: [move] })).rejects.toThrowError(/leafAsset/);
    await expect(adapter.runInteractionTest({ ...base, door, actions: [] })).rejects.toThrowError(/actions/);
    await expect(adapter.runInteractionTest({ ...base, door: { ...door, openAngleDeg: 0 }, actions: [move] })).rejects.toThrowError(/openAngleDeg/);
    await expect(adapter.runInteractionTest({ ...base, door, actions: [{ op: "move", direction: [2, 0, 0], durationS: 1 }] })).rejects.toThrowError(/unit vector/);
    await expect(adapter.runInteractionTest({ ...base, door, actions: [{ op: "move", durationS: 1 }] })).rejects.toThrowError(/direction/);
    await expect(adapter.runInteractionTest({ ...base, door, actions: [{ op: "wait", durationS: 0 }] })).rejects.toThrowError(/durationS/);
  });

  it("maps an incomplete scenario to blocked, never pass", async () => {
    const { promises: fsp } = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { EventEmitter } = await import("node:events");
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "forge-aaa-it-"));
    const projectPath = path.join(dir, "P.uproject");
    await fsp.writeFile(projectPath, "{}");
    const scriptPath = path.join(dir, "it.py");
    const adapter = new UnrealAdapter({
      platform: "win32",
      fileExists: () => true,
      spawnProcess: (() => {
        const child = new EventEmitter() as unknown as import("node:child_process").ChildProcess;
        Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true });
        setImmediate(async () => {
          const src = await fsp.readFile(scriptPath, "utf8");
          const specJson = src.match(/json\.loads\("(.+)"\)/)![1]!.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
          const spec = JSON.parse(specJson) as { reportPath: string; runId: string };
          // Engine died after one action: executed but only 1 of 2 actions measured.
          await fsp.writeFile(spec.reportPath, JSON.stringify({
            runId: spec.runId, executed: true, errors: ["tick: crashed"],
            actions: [{ op: "move", displacementCm: 5, doorYawDeg: 0, doorState: "closed", start: [0, 0, 0], end: [0, 5, 90] }],
            samples: [],
          }));
          child.emit("close", 0);
        });
        return child;
      }) as never,
    });
    const r = await adapter.runInteractionTest({
      ...base, projectPath, scriptPath, door,
      actions: [
        { op: "move", direction: [0, 1, 0], durationS: 2, expect: { maxDisplacementCm: 10 } },
        { op: "interact", durationS: 1, expect: { doorState: "open" } },
      ],
    });
    expect(r.state).toBe("blocked");
    const failures = (r.metrics?.failures ?? []) as string[];
    expect(failures[0]).toContain("scenario incomplete");
  });
});

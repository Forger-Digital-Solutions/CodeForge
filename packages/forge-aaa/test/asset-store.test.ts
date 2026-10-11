import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ForgeAaaAssetStore } from "../src/index.js";

async function tmpStore(): Promise<{ store: ForgeAaaAssetStore; dir: string; src: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "forge-aaa-store-"));
  const src = path.join(dir, "input.fbx");
  await fs.writeFile(src, "mesh-v1");
  return { store: new ForgeAaaAssetStore(path.join(dir, "assets")), dir, src };
}

const base = {
  taskId: "t1",
  provenance: { generator: "test", tool: "blender" as const },
  license: { commercialUse: "yes" as const },
  units: { system: "metric" as const, scale: 1, upAxis: "Z" as const },
  engines: {},
  validation: { checks: [] },
};

describe("ForgeAaaAssetStore", () => {
  it("commits versioned revisions with hashes and supersedes chain", async () => {
    const { store, src } = await tmpStore();
    const r1 = await store.commit({ manifest: { ...base, assetId: "a/stairs" }, files: [{ src, path: "stairs.fbx", role: "output" }] });
    expect(r1.revision).toBe(1);
    const src2 = path.join((await fs.mkdtemp(path.join(os.tmpdir(), "forge-aaa-src-"))), "v2.fbx");
    await fs.writeFile(src2, "mesh-v2");
    const r2 = await store.commit({ manifest: { ...base, assetId: "a/stairs" }, files: [{ src: src2, path: "stairs.fbx", role: "output" }] });
    expect(r2.revision).toBe(2);
    expect(r2.supersedes).toBe("a/stairs@rev-1");
    const head = await store.head("a/stairs");
    expect(head?.revision).toBe(2);
  });

  it("refuses to replace an approved head without explicit authorization", async () => {
    const { store, src } = await tmpStore();
    await store.commit({ manifest: { ...base, assetId: "a/door" }, files: [{ src, path: "door.fbx", role: "output" }], approvedHead: true });
    await expect(store.commit({ manifest: { ...base, assetId: "a/door" }, files: [{ src, path: "door.fbx", role: "output" }] }))
      .rejects.toThrowError(/ASSET_PROTECTED|approved/);
    const forced = await store.commit({ manifest: { ...base, assetId: "a/door" }, files: [{ src, path: "door.fbx", role: "output" }], replaceApproved: { reason: "user approved replacement" } });
    expect(forced.dependencies?.some((d) => d.startsWith("replaced-approved:"))).toBe(true);
  });

  it("rolls back by writing a new revision with verified content", async () => {
    const { store, src, dir } = await tmpStore();
    await store.commit({ manifest: { ...base, assetId: "a/wall" }, files: [{ src, path: "wall.fbx", role: "output" }] });
    const src2 = path.join(dir, "v2.fbx");
    await fs.writeFile(src2, "mesh-v2-broken");
    await store.commit({ manifest: { ...base, assetId: "a/wall" }, files: [{ src: src2, path: "wall.fbx", role: "output" }] });
    const rolled = await store.rollback("a/wall", 1, { taskId: "repair", reason: "v2 broke collision" });
    expect(rolled.revision).toBe(3);
    expect(rolled.dependencies?.some((d) => d.startsWith("rollback-from-rev-1"))).toBe(true);
    const headFile = await fs.readFile(path.join((await store.revisionDir("a/wall", 3)), "wall.fbx"), "utf8");
    expect(headFile).toBe("mesh-v1");
  });
});

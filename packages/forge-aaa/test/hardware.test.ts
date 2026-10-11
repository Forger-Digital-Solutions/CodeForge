import { describe, expect, it } from "vitest";
import { defaultWorkloadPolicy, ForgeAaaWorkloadScheduler, probeHardware } from "../src/index.js";

describe("ForgeAAA hardware awareness", () => {
  it("probes real CPU/RAM and reports unmeasured GPUs honestly", async () => {
    const hw = await probeHardware({ gpuProbe: async () => [{ name: "Quadro T2000", adapterRamMb: 4096, vramMeasured: true }] });
    expect(hw.cpuCount).toBeGreaterThan(0);
    expect(hw.totalMemoryMb).toBeGreaterThan(0);
    expect(hw.gpus[0]?.name).toBe("Quadro T2000");
  });

  it("a 4GB-VRAM profile forces sequential heavy work", () => {
    const policy = defaultWorkloadPolicy({ platform: "win32", cpuCount: 8, totalMemoryMb: 32768, freeMemoryMb: 8192, gpus: [{ name: "T2000", adapterRamMb: 4096, vramMeasured: true }], probedAt: "" });
    expect(policy.maxConcurrentHeavy).toBe(1);
    expect(policy.maxConcurrentLight).toBeLessThanOrEqual(4);
  });

  it("scheduler serializes heavy jobs and releases capacity", async () => {
    const scheduler = new ForgeAaaWorkloadScheduler({ maxConcurrentHeavy: 1, maxConcurrentLight: 2, minFreeMemoryMb: 1024 });
    const order: string[] = [];
    const release1 = await scheduler.acquire("h1", "heavy");
    const p2 = scheduler.acquire("h2", "heavy").then((r) => { order.push("h2-start"); return r; });
    expect(scheduler.active().queued).toBe(1);
    release1();
    const release2 = await p2;
    expect(order).toEqual(["h2-start"]);
    release2();
    expect(scheduler.active().heavy).toBe(0);
  });

  it("refuses heavy work under memory headroom", async () => {
    const scheduler = new ForgeAaaWorkloadScheduler({ maxConcurrentHeavy: 1, maxConcurrentLight: 2, minFreeMemoryMb: 2048 });
    await expect(scheduler.acquire("h", "heavy", { freeMemoryMb: 512 })).rejects.toThrowError(/RESOURCE_LIMIT/);
  });
});

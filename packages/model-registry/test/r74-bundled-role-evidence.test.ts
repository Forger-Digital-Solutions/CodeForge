import { describe, expect, it } from "vitest";
import { ForgeZero } from "@codeforge/forge-zero";
import { InMemoryProviderCatalog } from "@codeforge/providers";
import { InMemoryQualificationPersistence } from "@codeforge/eight-bit";
import { bundledFreeRoleReceipts } from "../src/bundled-role-evidence.js";
import { FreeCloudService } from "../src/free-cloud-service.js";
import { NormalizedModelRegistry } from "../src/registry.js";

const at = Date.parse("2026-10-10T12:00:00Z");
const make = (enabled: boolean, store = new InMemoryQualificationPersistence()) => new FreeCloudService({ firewall: new ForgeZero(), providerCatalog: new InMemoryProviderCatalog(), registry: new NormalizedModelRegistry(), qualificationStore: store, useBundledRoleEvidence: enabled, now: () => new Date(at) });

describe("R74 packaged live role bootstrap", () => {
  it("restores measured roles durably without granting catalog, account, privacy or policy authority", async () => {
    const store = new InMemoryQualificationPersistence();
    const service = make(true, store);
    const receipts = bundledFreeRoleReceipts(at);
    expect(await service.loadQualification()).toBe(3);
    expect((await store.loadAll()).map(receipt => receipt.modelId).sort()).toEqual(receipts.map(receipt => receipt.modelId).sort());
    for (const receipt of receipts) expect(service.isForgeAutoEligible(receipt.providerId, receipt.modelId)).toBe(false);
    expect(service.getReceipt("kilo-free-direct", "nvidia/nemotron-3-ultra-550b-a55b:free")?.roleResults.REVIEWER?.overallScore).toBe(0.875);
    expect(service.getReceipt("kilo-free-direct", "cohere/north-mini-code:free")?.roleResults.REVIEWER?.status).toBe("HARD_FAILURE");
  });

  it("does not overwrite a local denial or newer qualification at startup", async () => {
    const receipt = bundledFreeRoleReceipts(at).find(row => row.roleResults.REVIEWER?.status === "QUALIFIED")!;
    const original = structuredClone(receipt);
    receipt.roleResults.REVIEWER!.status = "HARD_FAILURE";
    receipt.roleResults.REVIEWER!.hardFailures = ["runtime-regression"];
    const store = new InMemoryQualificationPersistence();
    await store.save(receipt);
    const service = make(true, store);
    await service.loadQualification();
    expect(service.getReceipt(receipt.providerId, receipt.modelId)?.roleResults.REVIEWER?.status).toBe("HARD_FAILURE");
    expect(bundledFreeRoleReceipts(at).find(row => row.modelId === receipt.modelId)).toEqual(original);
  });

  it("expires measured evidence and rejects future timestamps without rewriting them", () => {
    expect(bundledFreeRoleReceipts(Date.parse("2026-11-11T00:00:00Z"))).toEqual([]);
    expect(bundledFreeRoleReceipts(Date.parse("2026-10-01T00:00:00Z"))).toEqual([]);
  });

  it("keeps hosted and fixture services unseeded unless the installed host opts in", async () => {
    const service = make(false);
    expect(await service.loadQualification()).toBe(0);
    expect(service.getReceipt("kilo-free-direct", "nvidia/nemotron-3-ultra-550b-a55b:free")).toBeUndefined();
  });
});

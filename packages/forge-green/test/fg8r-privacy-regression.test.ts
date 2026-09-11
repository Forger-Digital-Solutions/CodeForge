import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRepositoryIntelligence } from "@codeforge/repo-intelligence";
import {
  computeLiveContextPopulation,
  createSustainabilityReceipt,
  finalizeSustainabilityReceipt,
  normalizeMeasurementInput,
  type NormalizedIdentity,
} from "../src/index.js";

const cleanups: string[] = [];
const intelligences: Array<ReturnType<typeof createRepositoryIntelligence>> = [];

afterEach(async () => {
  await Promise.all(intelligences.splice(0).map((i) => i.closeWorkspace().catch(() => undefined)));
  await Promise.all(cleanups.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

function id(overrides: Partial<NormalizedIdentity> = {}): NormalizedIdentity {
  return { runId: "run-1", sessionId: "session-1", namespace: "ws-1", ...overrides };
}

describe("FG-8R privacy regression (§14) — the new live context/routing adapters never persist content, paths, or credentials", () => {
  it("the live context population from a REAL indexed workspace containing source content and env-like files never carries file paths or file contents — only counts/sizes/classifications", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fg8r-privacy-"));
    const cache = await fs.mkdtemp(path.join(os.tmpdir(), "fg8r-privacy-cache-"));
    cleanups.push(root, cache);
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }));
    const secretToken = "sk-live-VERY-SECRET-TOKEN-ABC123";
    await fs.writeFile(path.join(root, "config.ts"), `export const SECRET_API_KEY = "${secretToken}";\n`);
    await fs.writeFile(path.join(root, ".env"), `API_KEY=${secretToken}\n`);

    const intelligence = createRepositoryIntelligence({ cacheRoot: cache });
    intelligences.push(intelligence);
    await intelligence.openWorkspace(root);
    await intelligence.indexWorkspace();

    const population = await computeLiveContextPopulation(intelligence, { actualTransmittedBytes: 1, actualTransmittedTokens: 1 });
    expect(population).toBeDefined();
    const serialized = JSON.stringify(population);
    expect(serialized).not.toContain(secretToken);
    expect(serialized).not.toContain("config.ts");
    expect(serialized).not.toContain(".env");
    expect(serialized).not.toContain("SECRET_API_KEY");
    // Only counts/bytes/classification survive.
    expect(typeof population!.eligibleFileCount).toBe("number");
    expect(typeof population!.eligibleBytes === "number" || population!.eligibleBytes === undefined).toBe(true);
  });

  it("a full receipt built with live routing/financial + live context evidence never leaks a secret-shaped extra field injected on the raw inputs", async () => {
    const identity = id();
    const normalized = normalizeMeasurementInput({ identity, usage: { inputTokens: 5, outputTokens: 5, requestCount: 1 } });
    const secret = "sk-should-never-appear-anywhere-in-a-receipt";
    const receipt = finalizeSustainabilityReceipt(
      createSustainabilityReceipt({
        identity,
        normalized,
        live: {
          freeModelRecord: {
            providerId: "openrouter",
            modelId: "m1",
            costProfile: { isFree: true, paidFallbackPossible: false, paidFallbackDisabled: true, source: "s" },
            // Extra, unexpected field — normalization only ever reads named fields.
            apiKey: secret,
          } as Record<string, unknown>,
          decisionReceipts: [
            { receiptId: "d1", runId: "run-1", action: "rotate", selected: { providerId: "openrouter", modelId: "m1" }, evidence: { token: secret } } as Record<string, unknown>,
          ],
        },
      }),
    );
    expect(JSON.stringify(receipt)).not.toContain(secret);
  });

  it("computeLiveContextPopulation degrading to undefined (no intelligence, or a broken instance) never throws and never partially leaks internal state", async () => {
    await expect(computeLiveContextPopulation(undefined)).resolves.toBeUndefined();
    const brokenIntelligence = { getCompleteness: async () => { throw new Error("boom"); } } as unknown as Parameters<typeof computeLiveContextPopulation>[0];
    await expect(computeLiveContextPopulation(brokenIntelligence)).resolves.toBeUndefined();
  });
});

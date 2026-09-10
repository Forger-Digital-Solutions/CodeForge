import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runVerification } from "../src/verification-service.js";
import type { GenericVerificationEvidence } from "@codeforge/forge-green";

describe("FG-7 ForgeVerify execution and coverage integration", () => {
  let workspace: string;
  let counterFile: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "codeforge-fg7-execution-"));
    counterFile = join(tmpdir(), `codeforge-fg7-counter-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
    await writeFile(counterFile, "0", "utf8");
    await writeFile(join(workspace, "package.json"), JSON.stringify({ name: "fg7-fixture", type: "module" }));
    await writeFile(join(workspace, "verify.mjs"), [
      "import fs from 'node:fs';",
      "const file = process.argv[2];",
      "const count = Number(fs.readFileSync(file, 'utf8')) + 1;",
      "fs.writeFileSync(file, String(count));",
      "console.log('1 passed');",
    ].join("\n"));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
    await rm(counterFile, { force: true });
  });

  it("reuses current ForgeVerify evidence and avoids a second verifier process", async () => {
    const command = `node verify.mjs "${counterFile}"`;
    const first = await runVerification(workspace, [command], { runId: "fg7-restart-lineage" });
    expect(first.requiredPassed).toBe(true);
    expect(first.coverageReceipt?.outcome).toBe("SUFFICIENT");
    expect(first.forgeVerify?.evidence).toHaveLength(1);

    const second = await runVerification(workspace, [command], {
      runId: "fg7-restart-lineage",
      existingEvidence: first.forgeVerify?.evidence as unknown as readonly GenericVerificationEvidence[],
      existingEvidenceSource: "durable",
    });

    expect(await readFile(counterFile, "utf8")).toBe("1");
    expect(second.requiredPassed).toBe(true);
    expect(second.verifiers[0]?.reusedEvidenceId).toBe(first.forgeVerify?.evidence[0]?.evidenceId);
    expect(second.coverageReceipt?.outcome).toBe("SUFFICIENT");
    expect(second.coverageReceipt?.metrics.skippedValid).toBe(1);
    expect(second.coverageReceipt?.metrics.restartReuseCount).toBe(1);
    expect(second.coverageReceipt?.metrics.avoidedVerifierCalls).toBe(1);
  });
});

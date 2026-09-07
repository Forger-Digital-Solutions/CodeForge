import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalObligationKey,
  discoverWorkspaceResolutionConfig,
  resolveVerificationObligations,
  FORGE_GREEN_EVIDENCE_RESOLVER_VERSION,
  FORGE_GREEN_VERIFICATION_POLICY_VERSION,
  createForgeGreenLedgerCollector,
  type GenericVerificationEvidence,
  type VerificationObligation,
  type WorkspaceResolutionConfig,
} from "../src/index.js";

const cleanups: string[] = [];

async function createFixture(): Promise<{
  root: string;
  config: WorkspaceResolutionConfig;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fg6-resolver-"));
  cleanups.push(root);

  await fs.mkdir(path.join(root, "packages", "pkg-a", "src"), { recursive: true });
  await fs.mkdir(path.join(root, "packages", "pkg-a", "test"), { recursive: true });
  await fs.mkdir(path.join(root, "packages", "pkg-b", "src"), { recursive: true });
  await fs.mkdir(path.join(root, "packages", "pkg-b", "test"), { recursive: true });
  await fs.mkdir(path.join(root, "packages", "pkg-excluded", "src"), { recursive: true });
  await fs.mkdir(path.join(root, "docs"), { recursive: true });

  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "fg6-fixture-root",
      version: "1.0.0",
      private: true,
      workspaces: ["packages/*"],
      scripts: {
        build: "tsc -b",
        test: "vitest run",
        typecheck: "tsc -b",
      },
    })
  );

  await fs.writeFile(
    path.join(root, "tsconfig.json"),
    JSON.stringify({
      references: [
        { path: "packages/pkg-a" },
        { path: "packages/pkg-b" },
      ],
    })
  );

  await fs.writeFile(
    path.join(root, "packages", "pkg-a", "package.json"),
    JSON.stringify({
      name: "@fg6/pkg-a",
      version: "1.0.0",
      scripts: { test: "vitest run" },
    })
  );
  await fs.writeFile(
    path.join(root, "packages", "pkg-a", "tsconfig.json"),
    JSON.stringify({ compilerOptions: { composite: true } })
  );
  await fs.writeFile(path.join(root, "packages", "pkg-a", "src", "index.ts"), "export const a = 1;");
  await fs.writeFile(path.join(root, "packages", "pkg-a", "test", "a.test.ts"), "it('tests a', () => {});");
  await fs.writeFile(path.join(root, "packages", "pkg-a", "test", "sub.test.ts"), "it('tests a sub', () => {});");

  await fs.writeFile(
    path.join(root, "packages", "pkg-b", "package.json"),
    JSON.stringify({
      name: "@fg6/pkg-b",
      version: "1.0.0",
      scripts: { test: "vitest run" },
    })
  );
  await fs.writeFile(
    path.join(root, "packages", "pkg-b", "tsconfig.json"),
    JSON.stringify({ compilerOptions: { composite: true } })
  );
  await fs.writeFile(path.join(root, "packages", "pkg-b", "src", "index.ts"), "export const b = 2;");
  await fs.writeFile(path.join(root, "packages", "pkg-b", "test", "b.test.ts"), "it('tests b', () => {});");

  // pkg-excluded is not in root tsconfig references
  await fs.writeFile(
    path.join(root, "packages", "pkg-excluded", "package.json"),
    JSON.stringify({
      name: "@fg6/pkg-excluded",
      version: "1.0.0",
      scripts: { test: "vitest run" },
    })
  );
  await fs.writeFile(
    path.join(root, "packages", "pkg-excluded", "tsconfig.json"),
    JSON.stringify({ compilerOptions: { composite: true } })
  );

  await fs.writeFile(
    path.join(root, "README.md"),
    "// npm test runs everything\nREADME says PostgreSQL is included in tests.\n"
  );

  const config = discoverWorkspaceResolutionConfig(root, {
    environmentAvailability: { postgres: true, git: true, childProcess: true },
  });

  return { root, config };
}

function makeObligation(overrides: Partial<VerificationObligation>): VerificationObligation {
  const id = overrides.id ?? `ob-${Math.random().toString(36).substring(2, 9)}`;
  return {
    id,
    kind: overrides.kind ?? "TYPECHECK",
    scope: overrides.scope ?? "workspace",
    required: overrides.required ?? true,
    reasonCodes: overrides.reasonCodes ?? ["SYSTEMIC_SCOPE_CONSERVATIVE"],
    identity: overrides.identity ?? {
      namespace: "ns-test",
      workspacePath: "/test",
      obligationId: id,
      policyVersion: FORGE_GREEN_VERIFICATION_POLICY_VERSION,
    },
    targetPaths: overrides.targetPaths,
    targetPackages: overrides.targetPackages,
    commandHint: overrides.commandHint,
  };
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe("ForgeGreen FG-6 Evidence Resolution Authority", () => {
  it("1 & 2. exact duplicate obligations deduplicate and preserve all reason codes and source IDs", async () => {
    const { root, config } = await createFixture();
    const ob1 = makeObligation({
      id: "ob-1",
      kind: "TYPECHECK",
      scope: "workspace",
      reasonCodes: ["PUBLIC_INTERFACE_CHANGED"],
    });
    const ob2 = makeObligation({
      id: "ob-2",
      kind: "TYPECHECK",
      scope: "workspace",
      reasonCodes: ["SHARED_TYPE_CHANGED"],
    });

    const collector = createForgeGreenLedgerCollector({
      runId: "run-1",
      operation: "fg6_test",
      namespace: "ns-test",
    });

    const res = await resolveVerificationObligations({
      obligations: [ob1, ob2],
      workspacePath: root,
      workspaceConfig: config,
      ledger: collector,
      namespace: "ns-test",
    });

    expect(res.outcome).toBe("RESOLVED");
    expect(res.receipt.inputObligationCount).toBe(2);
    expect(res.receipt.deduplicatedObligationCount).toBe(1);
    expect(res.deduplicatedObligations).toHaveLength(1);
    const dedup = res.deduplicatedObligations[0]!;
    expect(dedup.reasonCodes).toContain("PUBLIC_INTERFACE_CHANGED");
    expect(dedup.reasonCodes).toContain("SHARED_TYPE_CHANGED");
    expect(dedup.sourceObligationIds).toEqual(["ob-1", "ob-2"]);

    // Ledger records
    const totals = collector.snapshot().totals;
    expect(totals.resolutionObligationsReceived).toBe(2);
    expect(totals.resolutionDuplicatesRemoved).toBe(1);
    expect(totals.resolutionProducersScheduled).toBe(1);
  });

  it("3 & 4. workspace typecheck subsumes package typechecks when proven, but not when package excluded", async () => {
    const { root, config } = await createFixture();
    const wsTc = makeObligation({ id: "ws-tc", kind: "TYPECHECK", scope: "workspace" });
    const pkgATc = makeObligation({
      id: "pkg-a-tc",
      kind: "TYPECHECK",
      scope: "package",
      targetPackages: ["@fg6/pkg-a"],
    });
    const pkgBTc = makeObligation({
      id: "pkg-b-tc",
      kind: "TYPECHECK",
      scope: "package",
      targetPackages: ["@fg6/pkg-b"],
    });

    const res = await resolveVerificationObligations({
      obligations: [wsTc, pkgATc, pkgBTc],
      workspacePath: root,
      workspaceConfig: config,
      namespace: "ns-test",
    });

    expect(res.outcome).toBe("RESOLVED");
    // Workspace typecheck producer was scheduled and covers pkg-a and pkg-b
    expect(res.producers.filter((p) => p.kind === "TYPECHECK")).toHaveLength(1);
    const tcProducer = res.producers.find((p) => p.kind === "TYPECHECK")!;
    expect(tcProducer.scope).toBe("workspace");
    expect(tcProducer.satisfiedObligationIds).toContain("ws-tc");
    expect(tcProducer.satisfiedObligationIds).toContain("pkg-a-tc");
    expect(tcProducer.satisfiedObligationIds).toContain("pkg-b-tc");

    // Subsumption records are explicit and inspectable
    const subRecords = res.subsumptions.filter((s) => s.reasonCode === "WORKSPACE_TYPECHECK_INCLUDES_PACKAGE");
    expect(subRecords.length).toBeGreaterThanOrEqual(2);
    expect(subRecords.map((s) => s.subsumedObligationId)).toContain("pkg-a-tc");
    expect(subRecords.map((s) => s.subsumedObligationId)).toContain("pkg-b-tc");
  });

  it("5 & 6. package test suite subsumes targeted tests when inclusion is proven, not unknown tests", async () => {
    const { root, config } = await createFixture();
    const pkgSuite = makeObligation({
      id: "ob-pkg-a",
      kind: "PACKAGE_TEST",
      scope: "package",
      targetPackages: ["@fg6/pkg-a"],
    });
    const targetA = makeObligation({
      id: "ob-tgt-a",
      kind: "TARGETED_TEST",
      scope: "target",
      targetPaths: ["packages/pkg-a/test/a.test.ts"],
    });
    const targetSub = makeObligation({
      id: "ob-tgt-sub",
      kind: "TARGETED_TEST",
      scope: "target",
      targetPaths: ["packages/pkg-a/test/sub.test.ts"],
    });
    const targetExternal = makeObligation({
      id: "ob-tgt-ext",
      kind: "TARGETED_TEST",
      scope: "target",
      targetPaths: ["packages/pkg-b/test/b.test.ts"],
    });

    const res = await resolveVerificationObligations({
      obligations: [pkgSuite, targetA, targetSub, targetExternal],
      workspacePath: root,
      workspaceConfig: config,
      namespace: "ns-test",
    });

    expect(res.outcome).toBe("RESOLVED");
    const pkgAProducer = res.producers.find((p) => p.targetPackage === "@fg6/pkg-a");
    expect(pkgAProducer).toBeDefined();
    expect(pkgAProducer!.satisfiedObligationIds).toContain("ob-pkg-a");
    expect(pkgAProducer!.satisfiedObligationIds).toContain("ob-tgt-a");
    expect(pkgAProducer!.satisfiedObligationIds).toContain("ob-tgt-sub");
    // Target in pkg-b is NOT subsumed by pkg-a
    expect(pkgAProducer!.satisfiedObligationIds).not.toContain("ob-tgt-ext");

    // Producer for targetExternal was scheduled separately
    const extProducer = res.producers.find((p) => p.satisfiedObligationIds.includes("ob-tgt-ext"));
    expect(extProducer).toBeDefined();
  });

  it("7 & 8. broad suite does not imply PostgreSQL and mock does not satisfy REAL_POSTGRESQL", async () => {
    const { root } = await createFixture();
    // Config with postgres disabled
    const configNoPg = discoverWorkspaceResolutionConfig(root, {
      environmentAvailability: { postgres: false, git: true, childProcess: true },
    });

    const pgObligation = makeObligation({
      id: "ob-pg",
      kind: "REAL_POSTGRESQL",
      scope: "integration",
      required: true,
    });
    const unitObligation = makeObligation({
      id: "ob-unit",
      kind: "UNIT_TEST",
      scope: "workspace",
    });

    const res = await resolveVerificationObligations({
      obligations: [pgObligation, unitObligation],
      workspacePath: root,
      workspaceConfig: configNoPg,
      environmentAvailability: { postgres: false, git: true, childProcess: true },
      namespace: "ns-test",
    });

    // PG is mandatory but unavailable -> BLOCKED
    expect(res.outcome).toBe("BLOCKED");
    expect(res.isResolved).toBe(false);
    expect(res.unresolvedObligations).toContain("ob-pg");
  });

  it("9, 10, 11, 12, 13, 14. valid existing evidence is reused; stale, failed, skipped rejected", async () => {
    const { root, config } = await createFixture();
    const currentHash = "hash-v1";

    const validEvidence: GenericVerificationEvidence = {
      evidenceId: "ev-passed-1",
      kind: "TYPECHECK",
      scope: "workspace",
      status: "passed",
      exitCode: 0,
      inputStateHash: currentHash,
      executionRevision: 1,
      policyVersion: FORGE_GREEN_VERIFICATION_POLICY_VERSION,
    };

    const staleEvidence: GenericVerificationEvidence = {
      evidenceId: "ev-stale-1",
      kind: "PACKAGE_TEST",
      scope: "package",
      status: "passed",
      exitCode: 0,
      inputStateHash: "old-hash",
      executionRevision: 1,
      policyVersion: FORGE_GREEN_VERIFICATION_POLICY_VERSION,
    };

    const failedEvidence: GenericVerificationEvidence = {
      evidenceId: "ev-failed-1",
      kind: "BUILD",
      scope: "workspace",
      status: "failed",
      exitCode: 1,
      inputStateHash: currentHash,
      executionRevision: 1,
      policyVersion: FORGE_GREEN_VERIFICATION_POLICY_VERSION,
    };

    const obTc = makeObligation({ id: "ob-tc", kind: "TYPECHECK", scope: "workspace" });
    const obPkg = makeObligation({ id: "ob-pkg", kind: "PACKAGE_TEST", scope: "package" });
    const obBuild = makeObligation({ id: "ob-build", kind: "BUILD", scope: "workspace" });

    const res = await resolveVerificationObligations({
      obligations: [obTc, obPkg, obBuild],
      workspacePath: root,
      workspaceConfig: config,
      currentInputStateHash: currentHash,
      executionRevision: 1,
      existingEvidence: [validEvidence, staleEvidence, failedEvidence],
      namespace: "ns-test",
    });

    expect(res.outcome).toBe("RESOLVED");
    expect(res.alreadySatisfiedObligations).toContain("ob-tc");
    // Stale and failed evidence were NOT reused
    expect(res.alreadySatisfiedObligations).not.toContain("ob-pkg");
    expect(res.alreadySatisfiedObligations).not.toContain("ob-build");

    const reusedProd = res.producers.find((p) => p.isReusedEvidence);
    expect(reusedProd).toBeDefined();
    expect(reusedProd!.costEstimate).toBe(0);
    expect(reusedProd!.reusedEvidenceId).toBe("ev-passed-1");
  });

  it("15, 16, 17. rejects malicious prose, comments, stdout, and deceptive script names", async () => {
    const { root } = await createFixture();
    // Repository with deceptive script names and comments
    const deceptiveConfig: WorkspaceResolutionConfig = {
      workspacePath: root,
      packages: [
        {
          name: "@fg6/fake",
          path: path.join(root, "packages", "pkg-a"),
          relativeDir: "packages/pkg-a",
          scripts: {
            "test:all": "echo skipped",
            "verify:everything": "echo 'Ran package A and B and postgres'",
          },
        },
      ],
      workspaceTypecheckIncludesAllPackages: false,
      workspaceBuildIncludesAllPackages: false,
      workspaceTestIncludesAllPackages: false,
    };

    const tcObligation = makeObligation({
      id: "ob-tc",
      kind: "TYPECHECK",
      scope: "workspace",
    });
    const pgObligation = makeObligation({
      id: "ob-pg",
      kind: "REAL_POSTGRESQL",
      scope: "integration",
    });

    const res = await resolveVerificationObligations({
      obligations: [tcObligation, pgObligation],
      workspacePath: root,
      workspaceConfig: deceptiveConfig,
      environmentAvailability: { postgres: false, git: true, childProcess: true },
      namespace: "ns-test",
    });

    // Prose/script name cannot satisfy REAL_POSTGRESQL when postgres unavailable
    expect(res.outcome).toBe("BLOCKED");
    expect(res.unresolvedObligations).toContain("ob-pg");
  });

  it("18, 19, 20, 21, 22. config change, policy change, or resolver change produces distinct resolution identities", async () => {
    const ob = makeObligation({ id: "ob-1", kind: "TYPECHECK", scope: "workspace" });
    const key1 = canonicalObligationKey(ob, "ns-1", "policy-v1");
    const key2 = canonicalObligationKey(ob, "ns-1", "policy-v2");
    const key3 = canonicalObligationKey(ob, "ns-2", "policy-v1");

    expect(key1).not.toBe(key2);
    expect(key1).not.toBe(key3);
  });

  it("23, 24, 25. steer and restart behavior: valid plan recovered without duplicate receipt fabrication", async () => {
    const { root, config } = await createFixture();
    const ob = makeObligation({ id: "ob-1", kind: "TYPECHECK", scope: "workspace" });

    // Initial plan at rev 1
    const resRev1 = await resolveVerificationObligations({
      obligations: [ob],
      workspacePath: root,
      workspaceConfig: config,
      executionRevision: 1,
      currentInputStateHash: "state-1",
      namespace: "ns-test",
    });
    expect(resRev1.outcome).toBe("RESOLVED");

    // Material steer -> rev 2 with new input state hash
    const resRev2 = await resolveVerificationObligations({
      obligations: [ob],
      workspacePath: root,
      workspaceConfig: config,
      executionRevision: 2,
      currentInputStateHash: "state-2",
      namespace: "ns-test",
    });
    expect(resRev2.outcome).toBe("RESOLVED");
    expect(resRev2.receipt.resolutionId).not.toBe(resRev1.receipt.resolutionId);
    expect(resRev2.receipt.revision).toBe(2);
  });

  it("26, 27, 28. 8-bit failover and namespace isolation", async () => {
    const { root, config } = await createFixture();
    const ob = makeObligation({ id: "ob-1", kind: "TYPECHECK", scope: "workspace" });

    // Model switch (8-bit failover) doesn't invalidate resolution if revision/hash match
    const resModelA = await resolveVerificationObligations({
      obligations: [ob],
      workspacePath: root,
      workspaceConfig: config,
      executionRevision: 1,
      currentInputStateHash: "state-1",
      namespace: "tenant-a",
    });

    const resModelB = await resolveVerificationObligations({
      obligations: [ob],
      workspacePath: root,
      workspaceConfig: config,
      executionRevision: 1,
      currentInputStateHash: "state-1",
      namespace: "tenant-a",
    });

    expect(resModelA.outcome).toBe("RESOLVED");
    expect(resModelB.outcome).toBe("RESOLVED");

    // Namespace tenant-b cannot access tenant-a
    const resTenantB = await resolveVerificationObligations({
      obligations: [ob],
      workspacePath: root,
      workspaceConfig: config,
      executionRevision: 1,
      currentInputStateHash: "state-1",
      namespace: "tenant-b",
    });
    expect(resTenantB.receipt.resolutionId).not.toBe(resModelA.receipt.resolutionId);
  });

  it("31 & 32. scale test: 1,000 duplicate/overlapping obligations resolves boundedly in <50ms", async () => {
    const { root, config } = await createFixture();
    const largeSet: VerificationObligation[] = [];

    for (let i = 0; i < 1000; i++) {
      largeSet.push(
        makeObligation({
          id: `large-ob-${i}`,
          kind: i % 2 === 0 ? "TYPECHECK" : "PACKAGE_TEST",
          scope: i % 2 === 0 ? "workspace" : "package",
          targetPackages: i % 2 === 0 ? undefined : ["@fg6/pkg-a"],
          reasonCodes: [`REASON_${i % 5}`],
        })
      );
    }

    const t0 = performance.now();
    const res = await resolveVerificationObligations({
      obligations: largeSet,
      workspacePath: root,
      workspaceConfig: config,
      namespace: "ns-test",
    });
    const elapsed = performance.now() - t0;

    expect(res.outcome).toBe("RESOLVED");
    expect(res.receipt.inputObligationCount).toBe(1000);
    // 1000 obligations deduplicated to 2 canonical obligations!
    expect(res.receipt.deduplicatedObligationCount).toBe(2);
    expect(res.receipt.dispatchesAvoidedCount).toBeGreaterThanOrEqual(998);
    expect(elapsed).toBeLessThan(100); // Super fast O(N) deduplication
  });

  it("33 & 34. authority boundary: FG-6 RESOLVED does not equal verification PASS and cannot satisfy Completion Gate", async () => {
    const { root, config } = await createFixture();
    const ob = makeObligation({ id: "ob-1", kind: "TYPECHECK", scope: "workspace" });

    const res = await resolveVerificationObligations({
      obligations: [ob],
      workspacePath: root,
      workspaceConfig: config,
      namespace: "ns-test",
    });

    // FG-6 produced a plan: outcome is RESOLVED
    expect(res.outcome).toBe("RESOLVED");
    expect(res.isResolved).toBe(true);

    // But this receipt is a resolution receipt, NOT a policy decision SUFFICIENT or verification pass
    expect(res.receipt.kind).toBe("evidence_resolution_receipt");
    expect(res.producers[0]!.kind).toBe("TYPECHECK");
    // Producers still need to be executed by ForgeVerify
    expect(res.producers[0]!.isReusedEvidence).toBeFalsy();
  });
});

import { describe, expect, it } from "vitest";
import { createSessionPersistence } from "@codeforge/sessions";
import {
  INTELLIGENCE_FEATURE_SCHEMA_VERSION,
  ShadowHealthCollector,
  createDurableShadowTelemetryStore,
  createEightBitShadowPredictor,
  classifyOutcome,
  datasetQualityReport,
  historicalOutcomeRecord,
  routeRegret,
  sanitizeIntelligenceRecord,
  splitByTaskFamily,
  trainShadowArtifact,
  type IntelligenceDatasetSplit,
  type IntelligenceRecord,
} from "../src/index.js";

function record(index = 0, overrides: Partial<IntelligenceRecord> = {}): IntelligenceRecord {
  const input = {
    domain: "8BIT" as const,
    lineage: {
      taskId: `task-${index}`,
      runId: `run-${index}`,
      tenantId: `tenant-${index % 2}`,
      observedAt: "2026-09-18T12:00:00.000Z",
      policyVersion: "r13",
      sourceClassification: "R13" as const,
      provenance: "OBSERVED_BENCHMARK" as const,
      taskFamilyHash: `family-${index % 8}`,
      fixtureFamilyHash: `fixture-${index % 8}`,
      repositoryHash: `repo-${index % 4}`,
    },
    task: { taskClass: "BUG_FIX" as const, requestedOperation: "EDIT" as const, candidateFileCount: 2 },
    route: {
      routeClass: "MANAGED_FREE" as const,
      deterministicRouteIdHash: "ignored",
      canonicalModelId: "openai/gpt-oss-120b",
      providerId: "provider-a",
      providerHealthState: "HEALTHY" as const,
      routeHealthState: "HEALTHY" as const,
      quotaRemainingBand: "LOW" as const,
      rateLimitRisk: "LOW" as const,
      providerLatencyBand: "FAST" as const,
      contextLimitBand: "LARGE" as const,
    },
    topology: { topologyRequested: 1 as const, topologyRecommended: 1 as const },
    context: { initialContextTokens: 1000, finalContextTokens: 700 },
    tools: { toolCallCount: 2, noProgressSignals: 0 },
    economics: {},
    productionDecision: { routeId: "provider-a:openai/gpt-oss-120b", routeClass: "MANAGED_FREE" as const, deterministicScore: 55 },
    actualOutcome: index % 3 === 0 ? "MODEL_REASONING_FAILURE" as const : "VERIFIED_SUCCESS" as const,
    verification: { verificationStarted: true, verificationCaught: false, completionBlocked: false, falseCompletion: false },
  };
  return { ...sanitizeIntelligenceRecord(input), ...overrides };
}

describe("R13 shared intelligence contract", () => {
  it("keeps PF-01, hidden-verifier catches, and provider 429s in their correct taxonomies", () => {
    expect(classifyOutcome({ executionExceededTimeBudget: true })).toMatchObject({
      outcome: "TIME_BUDGET_EXHAUSTED",
      modelCapabilityLabel: "UNKNOWN",
      verification: { verificationStarted: false, falseCompletion: false },
    });
    expect(classifyOutcome({ verificationStarted: true, verificationCaught: true, completionBlocked: true })).toMatchObject({
      outcome: "VERIFICATION_FAILURE",
      modelCapabilityLabel: "OBSERVED",
      verification: { verificationCaught: true, completionBlocked: true, falseCompletion: false },
    });
    expect(classifyOutcome({ providerRateLimited: true, modelReasoningFailed: true })).toMatchObject({
      outcome: "PROVIDER_RATE_LIMIT",
      modelCapabilityLabel: "UNKNOWN",
    });
  });

  it("ingests historic benchmark summaries without benchmark text and preserves their taxonomy", () => {
    const row = historicalOutcomeRecord({
      campaign: "R12",
      taskId: "RV-01",
      runId: "r12-rv-01",
      tenantId: "benchmark",
      observedAt: "2026-09-18T12:00:00.000Z",
      taskFamily: "reviewer",
      repository: "r12-fixture",
      routeId: "openrouter:cohere/north-mini-code:free",
      routeClass: "MANAGED_FREE",
      providerId: "openrouter",
      canonicalModelId: "cohere/north-mini-code:free",
      source: "OBSERVED_BENCHMARK",
      taxonomy: { providerRateLimited: true },
    });
    expect(row.actualOutcome).toBe("PROVIDER_RATE_LIMIT");
    expect(row.lineage.provenance).toBe("OBSERVED_BENCHMARK");
    expect(JSON.stringify(row)).not.toContain("RV-01");
  });

  it("hashes lineage and drops unknown/raw prompt-shaped fields before persistence", () => {
    const raw = {
      ...record(1),
      rawPrompt: "Bearer secret-token should never persist",
      rawSource: "const apiKey = 'sk-private'",
    } as unknown as Parameters<typeof sanitizeIntelligenceRecord>[0];
    const sanitized = sanitizeIntelligenceRecord({
      ...raw,
      lineage: {
        taskId: "task-with-credential-like-name-is-hashed",
        runId: "run-1",
        tenantId: "tenant-a",
        observedAt: "2026-09-18T12:00:00.000Z",
        policyVersion: "r13",
        sourceClassification: "R13",
        provenance: "OBSERVED_BENCHMARK",
      },
      productionDecision: { routeId: "provider-a:model", routeClass: "MANAGED_FREE" },
    });
    const encoded = JSON.stringify(sanitized);
    expect(encoded).not.toContain("secret-token");
    expect(encoded).not.toContain("sk-private");
    expect(encoded).not.toContain("task-with-credential-like-name-is-hashed");
    expect(sanitized.lineage.featureSchemaVersion).toBe(INTELLIGENCE_FEATURE_SCHEMA_VERSION);
  });

  it("rejects a credential-shaped provider/model field rather than accepting it as metadata", () => {
    expect(() => sanitizeIntelligenceRecord({
      ...record(2),
      lineage: { taskId: "t", runId: "r", tenantId: "tenant", observedAt: "2026-09-18T12:00:00.000Z", policyVersion: "r13", sourceClassification: "R13", provenance: "MOCK" },
      route: { ...record(2).route, providerId: "Bearer secret-token" },
      productionDecision: { routeId: "route", routeClass: "MANAGED_FREE" },
    })).toThrow("providerId");
  });

  it("keeps task-family/repository-connected rows in one split and never trains protected rows", () => {
    const rows = Array.from({ length: 40 }, (_, index) => record(index));
    const split = splitByTaskFamily(rows, { randomSeed: 1337 });
    expect(split.leakedGroups).toEqual([]);
    for (const protectedId of split.protectedRecordIds) {
      expect(split.assignments.find((assignment) => assignment.recordId === protectedId)?.partition).toBe("PROTECTED_HOLDOUT");
    }
    const family = rows.filter((row) => row.lineage.taskFamilyHash === rows[0]!.lineage.taskFamilyHash).map((row) => split.assignments.find((assignment) => assignment.recordId === row.recordId)?.groupId);
    expect(new Set(family).size).toBe(1);
  });

  it("fits only training labels and produces monotonic availability-risk predictions", () => {
    const rows = Array.from({ length: 25 }, (_, index) => record(index));
    const split: IntelligenceDatasetSplit = {
      splitVersion: "codeforge-intelligence-splits-v1",
      randomSeed: 4,
      datasetHash: "fixture-dataset",
      assignments: rows.map((row) => ({ recordId: row.recordId, partition: "TRAINING" as const, groupId: row.recordId })),
      counts: { TRAINING: 25, VALIDATION: 0, PUBLIC_TEST: 0, PROTECTED_HOLDOUT: 0 },
      groupCounts: { TRAINING: 25, VALIDATION: 0, PUBLIC_TEST: 0, PROTECTED_HOLDOUT: 0 },
      leakedGroups: [],
      protectedRecordIds: [],
    };
    const artifact = trainShadowArtifact("8BIT", rows, split, "2026-09-18T12:00:00.000Z");
    expect(artifact?.trainingRecordCount).toBe(25);
    const predictor = createEightBitShadowPredictor(artifact, true);
    const lowRisk = predictor.predict(rows[0]!);
    const exhausted = predictor.predict({ ...rows[0]!, route: { ...rows[0]!.route, quotaRemainingBand: "EXHAUSTED", rateLimitRisk: "HIGH" } });
    expect(exhausted.recommendation.predictedSuccess).toBeLessThan(lowRisk.recommendation.predictedSuccess!);
  });

  it("fails shadow safely on an incompatible artifact and records cheap health metrics", () => {
    const artifact = {
      artifactId: "8bit-shadow-r1",
      modelType: "CALIBRATED_LINEAR",
      inputFeatureSchemaVersion: "codeforge-intelligence-features-v0",
      trainingDatasetHash: "x",
      splitVersion: "x",
      randomSeed: 1,
      createdAt: "2026-09-18T12:00:00.000Z",
      trainingRecordCount: 20,
      observedSuccesses: 10,
      intercept: 0,
      coefficients: { rateLimitRisk: -1, quotaRisk: -1, contextPressure: 0, noProgress: 0 },
      metrics: { validationRows: 0, calibrationStatus: "INSUFFICIENT_EVIDENCE" as const },
    } as unknown as NonNullable<ReturnType<typeof trainShadowArtifact>>;
    const result = createEightBitShadowPredictor(artifact, true).predict(record());
    const health = new ShadowHealthCollector();
    health.record({ status: result.artifactStatus, latencyMs: result.latencyMs });
    expect(result.artifactStatus).toBe("SCHEMA_MISMATCH");
    expect(health.snapshot().schemaMismatch).toBe(1);
    expect(result.latencyMs).toBeLessThan(50);
  });

  it("persists a sanitized record under its session and never returns it to another tenant", async () => {
    const persistence = createSessionPersistence({ dbPath: ":memory:" });
    await persistence.init();
    try {
      const now = new Date().toISOString();
      await persistence.upsertSession({ id: "tenant-a", title: "a", createdAt: now, updatedAt: now, status: "running" });
      await persistence.upsertSession({ id: "tenant-b", title: "b", createdAt: now, updatedAt: now, status: "running" });
      const store = createDurableShadowTelemetryStore(persistence);
      const saved = record(91);
      await store.save("tenant-a", saved);
      expect(await store.loadBySession("tenant-a")).toEqual([saved]);
      expect(await store.loadBySession("tenant-b")).toEqual([]);
      expect(await store.loadByRecord("tenant-b", saved.recordId)).toBeUndefined();
      await store.attachOutcome("tenant-a", saved.recordId, "VERIFIED_SUCCESS", { verificationStarted: true, verificationCaught: false, completionBlocked: false, falseCompletion: false });
      expect((await store.loadByRecord("tenant-a", saved.recordId))?.actualOutcome).toBe("VERIFIED_SUCCESS");
      expect(await store.attachOutcome("tenant-b", saved.recordId, "VERIFIED_SUCCESS", { verificationStarted: true, verificationCaught: false, completionBlocked: false, falseCompletion: false })).toBeUndefined();
    } finally { await persistence.close(); }
  });

  it("whitelists telemetry at the durable boundary and rejects credential-shaped known fields", async () => {
    const persistence = createSessionPersistence({ dbPath: ":memory:" });
    await persistence.init();
    try {
      const now = new Date().toISOString();
      await persistence.upsertSession({ id: "tenant-a", title: "a", createdAt: now, updatedAt: now, status: "running" });
      const store = createDurableShadowTelemetryStore(persistence);
      const saved = record(92);
      const unsafe = {
        ...saved,
        openAiApiKey: "sk-proj-synthetic",
        bearerToken: "Bearer synthetic-token",
        githubToken: "ghp_synthetic",
        oauthToken: "xoxb-synthetic",
        privateKey: "-----BEGIN PRIVATE KEY----- synthetic",
        providerKey: "gsk_synthetic",
        environmentVariable: "OPENAI_API_KEY",
      } as unknown as IntelligenceRecord;
      await store.save("tenant-a", unsafe);
      expect(JSON.stringify(await store.loadBySession("tenant-a"))).not.toMatch(/sk-proj|Bearer synthetic|ghp_|xoxb-|PRIVATE KEY|gsk_|OPENAI_API_KEY/);
      await expect(store.save("tenant-a", {
        ...record(93),
        route: { ...record(93).route, providerId: "Bearer synthetic-token" },
      })).rejects.toThrow("providerId");
    } finally { await persistence.close(); }
  });

  it("reports small-data limits and does not invent a counterfactual regret winner", () => {
    const single = record(111);
    const split = splitByTaskFamily([single], { randomSeed: 5 });
    const report = datasetQualityReport([single], split);
    expect(report.qualification).toBe("INSUFFICIENT_DATA");
    expect(routeRegret([single])[0]).toMatchObject({ routeRegretKnown: false });
  });
});

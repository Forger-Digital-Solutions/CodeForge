import { createHash } from "node:crypto";
import { canonicalIdentityFor } from "@codeforge/forge-zero";
import type {
  DatasetFeatures,
  EightBitDatasetRow,
  RouteOutcomeLabel,
} from "./schema.js";
import { DATASET_SCHEMA_VERSION } from "./schema.js";
import { structuredMetadataProvenance } from "./provenance.js";

/**
 * Builds the 8-Bit specialist dataset from CodeForge-owned structured evidence. Every extractor
 * records its evidence path so any row can be reproduced from the repository. Labels describe
 * observed outcomes only — no row is synthesized from what SHOULD have happened; the single
 * derived-simulation source (capacity-model trajectories over certified constants) is marked
 * DERIVED_SIMULATION and can never enter an evaluation split (enforced by freezeSplits).
 */

export interface CorpusTaskRecord {
  task_id: string;
  category?: string;
  status?: string;
  failure_class?: string;
  notes?: string[];
  started_at?: string;
  finished_at?: string;
  requests?: number;
  provider_routes?: Record<string, { requests: number; inputTokens: number; outputTokens: number }>;
}

export interface SmokeWorkerRecord {
  role: string;
  status: string;
  model: { providerId: string; modelId: string } | null;
  telemetry: {
    wallTimeMs: number;
    modelRequests: number;
    inputTokens: number;
    outputTokens: number;
    toolCalls: number;
    retryCount: number;
    providerFailures: number;
  };
  startedAt: string;
  completedAt?: string;
}

export interface FleetQualificationRecord {
  schemaVersion: number;
  generatedAt: string;
  providers: Array<{
    providerId: string;
    status: string;
    auth?: { ok: boolean; elapsedMs?: number };
    catalog?: { ok: boolean; modelCount?: number };
    qualifications?: Array<{
      modelId: string;
      elapsedMs?: number;
      qualificationState: string;
      roleStatuses?: Record<string, string>;
      caseDetails?: Record<string, { passed: boolean; latencyMs?: number; error?: string | null }>;
    }>;
    error?: unknown;
  }>;
}

export interface RouteCandidateRecord {
  modelId: string;
  family?: string;
  freeStatus?: string;
  contextWindow?: number;
  toolCalling?: boolean;
  structuredOutput?: boolean;
}

function rowIdFor(kind: string, key: string): string {
  const hash = createHash("sha256").update(`${kind}::${key}`).digest("hex").slice(0, 16);
  return `${kind.toLowerCase()}-${hash}`;
}

function familyOf(providerId: string, providerModelId: string): {
  canonicalModelId: string;
  modelFamily: string;
} {
  const identity = canonicalIdentityFor(providerId, providerModelId);
  return { canonicalModelId: identity.canonicalId, modelFamily: identity.family };
}

function completenessOf(features: DatasetFeatures): number {
  const applicable: Array<keyof DatasetFeatures> = [
    "contextLimitTokens",
    "toolSupport",
    "observedRpm",
    "observedTpm",
    "requestsInObservation",
    "latencyP50Ms",
    "recentSuccessRate",
  ];
  const present = applicable.filter((k) => features[k] !== undefined).length;
  return Math.round((present / applicable.length) * 100) / 100;
}

function textQuotaSignal(notes: string[] | undefined, extra?: string): boolean {
  const text = `${(notes ?? []).join(" ")} ${extra ?? ""}`.toUpperCase();
  return text.includes("TPD") || text.includes("TOKENS PER DAY") || text.includes("NEURON") || text.includes("LIMIT 200000");
}

function corpusFailureToOutcome(record: CorpusTaskRecord): RouteOutcomeLabel | undefined {
  const failed = (record.failure_class ?? "").toUpperCase();
  if (record.status === "PASSED" || record.status === "RECOVERED_PASS") return "SUCCESS";
  if (failed.includes("PROVIDER_RATE_LIMITED")) {
    return textQuotaSignal(record.notes) ? "QUOTA_EXHAUSTED" : "RATE_LIMITED";
  }
  if (failed.includes("HEALTH_MARKED") || failed.includes("PROVIDER_HEALTH")) return "HEALTH_MARKED_UNAVAILABLE";
  if (failed.includes("AUTH") || failed.includes("EXTERNAL_AUTHORIZATION")) return "AUTH_REQUIRED";
  if (failed.includes("CAPACITY")) return textQuotaSignal(record.notes) ? "QUOTA_EXHAUSTED" : "RATE_LIMITED";
  if (record.status === "CAPACITY_BLOCKED") {
    return textQuotaSignal(record.notes) ? "QUOTA_EXHAUSTED" : "RATE_LIMITED";
  }
  if (failed.includes("MODEL") || failed.includes("PROVIDER")) return "MODEL_ERROR";
  return undefined;
}

/** ROUTE_OUTCOME rows from the frozen R3 corpus task records (real dispatched attempts). */
export function rowsFromCorpusTasks(
  records: CorpusTaskRecord[],
  evidenceRoot: string,
): EightBitDatasetRow[] {
  const rows: EightBitDatasetRow[] = [];
  for (const record of records) {
    const outcome = corpusFailureToOutcome(record);
    if (!outcome) continue;
    const routeUsage = Object.entries(record.provider_routes ?? {}).filter(([key]) => key !== "unknown/unknown");
    const primaryUsage = routeUsage[0];
    if (!primaryUsage) continue;
    const [routeKey, usage] = primaryUsage;
    const [rawProviderId, ...modelParts] = routeKey.split("::");
    const providerModelId = modelParts.join("::") || routeKey.split("/").slice(1).join("/");
    const providerId = rawProviderId;
    if (!providerId || providerId === "unknown" || !providerModelId) continue;
    const { canonicalModelId, modelFamily } = familyOf(providerId, providerModelId);
    const started = record.started_at ? Date.parse(record.started_at) : NaN;
    const finished = record.finished_at ? Date.parse(record.finished_at) : NaN;
    const minutes = Number.isFinite(started) && Number.isFinite(finished) && finished > started
      ? (finished - started) / 60000
      : undefined;
    const features: DatasetFeatures = {
      observedRpm: minutes && minutes > 0 ? Math.round((usage.requests / minutes) * 100) / 100 : undefined,
      requestsInObservation: usage.requests,
      inputTokensInObservation: usage.inputTokens,
      outputTokensInObservation: usage.outputTokens,
      role: "AUTONOMOUS_RUN",
      taskType: record.category,
      errorRate: outcome === "SUCCESS" ? 0 : 1,
      observedEconomicsState: "FREE_LIMITED",
      observedPrivacyState: "PRIVACY_UNKNOWN",
      observedHealthState:
        outcome === "SUCCESS" ? "HEALTHY"
        : outcome === "QUOTA_EXHAUSTED" ? "QUOTA_EXHAUSTED"
        : outcome === "RATE_LIMITED" ? "RATE_LIMITED"
        : outcome === "HEALTH_MARKED_UNAVAILABLE" ? "UNAVAILABLE"
        : outcome === "AUTH_REQUIRED" ? "HEALTH_UNKNOWN"
        : "DEGRADED",
      evidenceCompleteness: 0,
    };
    features.evidenceCompleteness = completenessOf(features);
    rows.push({
      rowId: rowIdFor("route", `corpus:${record.task_id}:${record.started_at ?? ""}`),
      datasetSchemaVersion: DATASET_SCHEMA_VERSION,
      taskKind: "ROUTE_OUTCOME",
      providerId,
      providerModelId,
      canonicalModelId,
      modelFamily,
      features,
      label: { routeOutcome: outcome },
      provenance: structuredMetadataProvenance({
        sourceType: "R3_CORPUS_ATTEMPT",
        sourceRefs: [`${evidenceRoot}/tasks/${record.task_id}.json`],
        evidenceObservedAt: record.finished_at ?? record.started_at ?? new Date(0).toISOString(),
        originatingProvider: providerId,
      }),
    });
  }
  return rows;
}

/** ROUTE_OUTCOME rows from smoke-attempt worker telemetry (real per-worker serving outcomes). */
export function rowsFromSmokeWorkers(
  workers: SmokeWorkerRecord[],
  smokeId: string,
  evidenceRoot: string,
): EightBitDatasetRow[] {
  const rows: EightBitDatasetRow[] = [];
  for (const [index, worker] of workers.entries()) {
    if (!worker.model) continue;
    if (worker.telemetry.modelRequests === 0) continue;
    const routeServed = worker.telemetry.providerFailures === 0;
    const outcome: RouteOutcomeLabel = routeServed ? "SUCCESS" : "RATE_LIMITED";
    const { canonicalModelId, modelFamily } = familyOf(worker.model.providerId, worker.model.modelId);
    const wallMinutes = worker.telemetry.wallTimeMs / 60000;
    const features: DatasetFeatures = {
      observedRpm: Math.round((worker.telemetry.modelRequests / wallMinutes) * 100) / 100,
      observedTpm: Math.round((worker.telemetry.inputTokens / wallMinutes) * 100) / 100,
      requestsInObservation: worker.telemetry.modelRequests,
      inputTokensInObservation: worker.telemetry.inputTokens,
      outputTokensInObservation: worker.telemetry.outputTokens,
      role: worker.role,
      errorRate: worker.telemetry.retryCount > 0 ? Math.min(1, worker.telemetry.retryCount / worker.telemetry.modelRequests) : 0,
      latencyP50Ms: worker.telemetry.modelRequests > 0
        ? Math.round(worker.telemetry.wallTimeMs / worker.telemetry.modelRequests)
        : undefined,
      observedEconomicsState: "FREE_LIMITED",
      observedPrivacyState: "PRIVACY_UNKNOWN",
      observedHealthState: routeServed ? "HEALTHY" : "RATE_LIMITED",
      evidenceCompleteness: 0,
    };
    features.evidenceCompleteness = completenessOf(features);
    rows.push({
      rowId: rowIdFor("route", `smoke:${smokeId}:${index}`),
      datasetSchemaVersion: DATASET_SCHEMA_VERSION,
      taskKind: "ROUTE_OUTCOME",
      providerId: worker.model.providerId,
      providerModelId: worker.model.modelId,
      canonicalModelId,
      modelFamily,
      features,
      label: { routeOutcome: outcome },
      provenance: structuredMetadataProvenance({
        sourceType: "R3_CORPUS_ATTEMPT",
        sourceRefs: [`${evidenceRoot}/smoke-archive/${smokeId}/attempt-1/workers.json#${index}`],
        evidenceObservedAt: worker.completedAt ?? worker.startedAt,
        originatingProvider: worker.model.providerId,
      }),
    });
  }
  return rows;
}

/** ROLE_SUITABILITY rows from live managed-free fleet qualification evidence. */
export function rowsFromFleetQualification(
  record: FleetQualificationRecord,
  evidencePath: string,
): EightBitDatasetRow[] {
  const rows: EightBitDatasetRow[] = [];
  for (const provider of record.providers) {
    for (const qualification of provider.qualifications ?? []) {
      const caseLatencies = Object.values(qualification.caseDetails ?? {})
        .map((c) => c.latencyMs)
        .filter((v): v is number => typeof v === "number");
      const latencyP50 = caseLatencies.length > 0
        ? caseLatencies.slice().sort((a, b) => a - b)[Math.floor((caseLatencies.length - 1) / 2)]
        : undefined;
      for (const [role, status] of Object.entries(qualification.roleStatuses ?? {})) {
        const suitability = status === "QUALIFIED" ? "QUALIFIED" : status === "PROBATION" ? "PROBATION" : "NOT_QUALIFIED";
        const { canonicalModelId, modelFamily } = familyOf(provider.providerId, qualification.modelId);
        const features: DatasetFeatures = {
          role,
          latencyP50Ms: latencyP50,
          errorRate: suitability === "NOT_QUALIFIED" ? 1 : suitability === "PROBATION" ? 0.5 : 0,
          recentSuccessRate: suitability === "QUALIFIED" ? 1 : suitability === "PROBATION" ? 0.5 : 0,
          observedEconomicsState: provider.providerId === "zai" ? "ECONOMICS_UNKNOWN" : "FREE_LIMITED",
          observedPrivacyState: "PRIVACY_UNKNOWN",
          observedHealthState: provider.status === "CERTIFIED" ? "HEALTHY" : "HEALTH_UNKNOWN",
          evidenceCompleteness: 0,
        };
        features.evidenceCompleteness = completenessOf(features);
        rows.push({
          rowId: rowIdFor("role", `qual:${provider.providerId}:${qualification.modelId}:${role}`),
          datasetSchemaVersion: DATASET_SCHEMA_VERSION,
          taskKind: "ROLE_SUITABILITY",
          providerId: provider.providerId,
          providerModelId: qualification.modelId,
          canonicalModelId,
          modelFamily,
          features,
          label: { roleSuitability: suitability },
          provenance: structuredMetadataProvenance({
            sourceType: "QUALIFICATION_PROBE",
            sourceRefs: [`${evidencePath}#${provider.providerId}/${qualification.modelId}/${role}`],
            evidenceObservedAt: record.generatedAt,
            originatingProvider: provider.providerId,
          }),
        });
      }
    }
  }
  return rows;
}

/** ECONOMICS_STATE rows from live zero-unit discovery catalogs (verified-free metadata). */
export function rowsFromDiscoveryCatalog(
  candidates: RouteCandidateRecord[],
  providerId: string,
  observedAt: string,
  evidencePath: string,
): EightBitDatasetRow[] {
  const rows: EightBitDatasetRow[] = [];
  for (const candidate of candidates) {
    const verifiedFree = candidate.freeStatus === "verified_free";
    const { canonicalModelId, modelFamily } = familyOf(providerId, candidate.modelId);
    const features: DatasetFeatures = {
      contextLimitTokens: candidate.contextWindow,
      toolSupport: candidate.toolCalling,
      structuredOutputSupport: candidate.structuredOutput,
      observedEconomicsState: verifiedFree ? "FREE_LIMITED" : "ECONOMICS_UNKNOWN",
      observedPrivacyState: "PRIVACY_UNKNOWN",
      observedHealthState: "HEALTH_UNKNOWN",
      evidenceCompleteness: 0,
    };
    features.evidenceCompleteness = completenessOf(features);
    rows.push({
      rowId: rowIdFor("econ", `discovery:${providerId}:${candidate.modelId}`),
      datasetSchemaVersion: DATASET_SCHEMA_VERSION,
      taskKind: "ECONOMICS_STATE",
      providerId,
      providerModelId: candidate.modelId,
      canonicalModelId,
      modelFamily,
      features,
      label: { economicsState: verifiedFree ? "FREE_CONFIRMED" : "ECONOMICS_UNKNOWN" },
      provenance: structuredMetadataProvenance({
        sourceType: "DISCOVERY_CATALOG",
        sourceRefs: [`${evidencePath}#${candidate.modelId}`],
        evidenceObservedAt: observedAt,
        originatingProvider: providerId,
      }),
    });
  }
  return rows;
}

// --- Derived capacity-model trajectories (train-only by construction) ---------------------------

export interface CapacityModelConstants {
  providerId: string;
  tpm: number;
  tpd: number;
  rpm: number;
}

/** Certified observed constants from the R3-RC2 window-1 report (§6). */
export const OBSERVED_CAPACITY_CONSTANTS: CapacityModelConstants[] = [
  { providerId: "groq", tpm: 8000, tpd: 200000, rpm: 20 },
  { providerId: "cloudflare-workers-ai", tpm: 6000, tpd: 10000, rpm: 20 },
];

export interface SimulationSample {
  providerId: string;
  providerModelId: string;
  minuteTokensUsed: number;
  dailyTokensUsed: number;
  requestedTokens: number;
  minutesSinceReset: number;
  healthAlreadyMarked: boolean;
  outcome: RouteOutcomeLabel;
}

/**
 * Deterministic seeded PRNG (mulberry32) so the derived corpus is reproducible byte-for-byte
 * from the constants and the seed recorded in the dataset manifest.
 */
export function seededPrng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Real observed worker-turn token distributions (smoke telemetry) anchor the simulation. */
const SIMULATED_MODELS: Record<string, string[]> = {
  groq: ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.8-27b"],
  "cloudflare-workers-ai": ["@cf/openai/gpt-oss-120b", "@cf/qwen/qwen3.8-27b"],
};

export function simulateCapacityTrajectories(
  constants: CapacityModelConstants[],
  samples: number,
  seed: number,
): SimulationSample[] {
  const random = seededPrng(seed);
  const output: SimulationSample[] = [];
  for (let i = 0; i < samples; i++) {
    const model = constants[i % constants.length];
    if (!model) continue;
    const modelIds = SIMULATED_MODELS[model.providerId] ?? [];
    const providerModelId = modelIds[i % modelIds.length];
    if (!providerModelId) continue;
    const requestedTokens = Math.round(800 + random() * 17000);
    const dailyTokensUsed = Math.round(random() * model.tpd * 1.05);
    const minuteTokensUsed = Math.round(random() * model.tpm * 1.05);
    const minutesSinceReset = Math.round(random() * 1440);
    const dailyWillExhaust = dailyTokensUsed + requestedTokens > model.tpd;
    const minuteWillLimit = !dailyWillExhaust && minuteTokensUsed + requestedTokens > model.tpm;
    const healthAlreadyMarked = random() < 0.15;
    const outcome: RouteOutcomeLabel = healthAlreadyMarked
      ? "HEALTH_MARKED_UNAVAILABLE"
      : dailyWillExhaust
        ? "QUOTA_EXHAUSTED"
        : minuteWillLimit
          ? "RATE_LIMITED"
          : "SUCCESS";
    output.push({
      providerId: model.providerId,
      providerModelId,
      minuteTokensUsed,
      dailyTokensUsed,
      requestedTokens,
      minutesSinceReset,
      healthAlreadyMarked,
      outcome,
    });
  }
  return output;
}

export function rowsFromCapacitySimulation(
  samples: SimulationSample[],
  derivedFromRowIds: string[],
  observedAt: string,
): EightBitDatasetRow[] {
  const rows: EightBitDatasetRow[] = [];
  for (const [index, sample] of samples.entries()) {
    const { canonicalModelId, modelFamily } = familyOf(sample.providerId, sample.providerModelId);
    const features: DatasetFeatures = {
      observedTpm: sample.minuteTokensUsed,
      dailyBudgetUsedRatio: Math.round((sample.dailyTokensUsed / (OBSERVED_CAPACITY_CONSTANTS.find((c) => c.providerId === sample.providerId)?.tpd ?? 1)) * 1000) / 1000,
      minutesSinceDailyReset: sample.minutesSinceReset,
      inputTokensInObservation: sample.requestedTokens,
      taskType: "CAPACITY_TRAJECTORY",
      observedEconomicsState: "FREE_LIMITED",
      observedPrivacyState: "PRIVACY_UNKNOWN",
      observedHealthState: sample.healthAlreadyMarked ? "UNAVAILABLE" : "HEALTHY",
      evidenceCompleteness: 0,
    };
    features.evidenceCompleteness = completenessOf(features);
    rows.push({
      rowId: rowIdFor("route", `sim:${index}`),
      datasetSchemaVersion: DATASET_SCHEMA_VERSION,
      taskKind: "ROUTE_OUTCOME",
      providerId: sample.providerId,
      providerModelId: sample.providerModelId,
      canonicalModelId,
      modelFamily,
      features,
      label: { routeOutcome: sample.outcome },
      provenance: {
        ...structuredMetadataProvenance({
          sourceType: "DERIVED_SIMULATION",
          sourceRefs: ["tests/evidence/r3/corpus-runs/campaign-1/WINDOW-1-REPORT.md#6-capacity-findings"],
          evidenceObservedAt: observedAt,
          originatingProvider: sample.providerId,
          derivedFrom: derivedFromRowIds,
        }),
        trainingUseRationale:
          "Derived from CodeForge's own certified capacity-governor semantics and observed provider constants (window-1 report); CodeForge-owned derived data, train-only by construction.",
      },
    });
  }
  return rows;
}

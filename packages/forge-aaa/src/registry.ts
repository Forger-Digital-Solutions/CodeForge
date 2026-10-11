import type { ForgeAaaCandidate } from "./candidates.js";
import { FORGE_AAA_SEED_CANDIDATES } from "./candidates.js";
import { FORGE_AAA_ERRORS, ForgeAaaError, type ForgeAaaCandidateClass, type ForgeAaaSpecialtyId } from "./types.js";

/**
 * Qualification evidence — the only authority that may move a candidate past EXPERIMENTAL.
 * `executed: true` means a real operation ran (headless Blender script, provider probe,
 * MCP handshake + tool call); a synthetic or planned outcome can never promote.
 */
export interface ForgeAaaQualification {
  candidateId: string;
  at: string;
  executed: boolean;
  passed: boolean;
  /** Operation that produced the evidence (e.g. "blender-headless-probe"). */
  operation: string;
  /** Promotion target — INTEGRATED additionally asserts the op ran through the
   *  orchestration pipeline rather than a standalone probe. */
  outcome: "VERIFIED_AVAILABLE" | "INTEGRATED" | "INCOMPATIBLE" | "REJECTED";
  detail: string;
  /** Durable pointer to evidence (file hash, log path, receipt id) — never prose alone. */
  evidenceRef?: string;
}

export interface ForgeAaaRegistryEntry {
  candidate: ForgeAaaCandidate;
  classification: ForgeAaaCandidateClass;
  qualifications: readonly ForgeAaaQualification[];
  statusDetail: string;
}

const PROMOTABLE = new Set<ForgeAaaCandidateClass>(["VERIFIED_AVAILABLE", "INTEGRATED"]);
const DEMOTABLE = new Set<ForgeAaaCandidateClass>(["INCOMPATIBLE", "REJECTED"]);

function appliesPromotion(base: ForgeAaaCandidateClass, q: ForgeAaaQualification): ForgeAaaCandidateClass {
  if (!q.executed || !q.passed) return base;
  if (q.outcome === "INTEGRATED") return "INTEGRATED";
  if (q.outcome === "VERIFIED_AVAILABLE" && base !== "INTEGRATED") return "VERIFIED_AVAILABLE";
  return base;
}

/**
 * Candidate registry. Classification is derived — the newest executed evidence wins, with
 * INCOMPATIBLE/REJECTED sticky until a subsequent passing executed qualification exists.
 * Nothing in here asserts a capability that no execution proved.
 */
export class ForgeAaaRegistry {
  private readonly candidates = new Map<string, ForgeAaaCandidate>();
  private readonly qualifications = new Map<string, ForgeAaaQualification[]>();

  constructor(seed: readonly ForgeAaaCandidate[] = FORGE_AAA_SEED_CANDIDATES) {
    for (const candidate of seed) this.candidates.set(candidate.id, candidate);
  }

  register(candidate: ForgeAaaCandidate): void {
    if (!candidate.id.trim()) throw new ForgeAaaError(FORGE_AAA_ERRORS.MANIFEST_INVALID, "candidate id required");
    const existing = this.candidates.get(candidate.id);
    // A re-registration may refine metadata but may never silently lift a REJECTED marker.
    if (existing?.classification === "REJECTED" && candidate.classification !== "REJECTED") {
      this.candidates.set(candidate.id, { ...candidate, classification: "REJECTED" });
      return;
    }
    this.candidates.set(candidate.id, candidate);
  }

  candidate(id: string): ForgeAaaCandidate | undefined {
    return this.candidates.get(id);
  }

  recordQualification(q: ForgeAaaQualification): void {
    const candidate = this.candidates.get(q.candidateId);
    if (!candidate) throw new ForgeAaaError(FORGE_AAA_ERRORS.POLICY_UNRESOLVED, `unknown candidate ${q.candidateId}`);
    if (PROMOTABLE.has(q.outcome) && (!q.executed || !q.passed)) {
      throw new ForgeAaaError(FORGE_AAA_ERRORS.POLICY_UNRESOLVED, "promotion requires executed+passed evidence");
    }
    const list = this.qualifications.get(q.candidateId) ?? [];
    list.push(q);
    this.qualifications.set(q.candidateId, list);
  }

  qualificationsFor(candidateId: string): readonly ForgeAaaQualification[] {
    return this.qualifications.get(candidateId) ?? [];
  }

  effectiveClassification(candidateId: string): ForgeAaaCandidateClass {
    const candidate = this.candidates.get(candidateId);
    if (!candidate) return "UNAVAILABLE";
    let cls = candidate.classification;
    for (const q of this.qualificationsFor(candidateId)) {
      if (DEMOTABLE.has(q.outcome) && q.executed) cls = q.outcome;
      else cls = appliesPromotion(cls, q);
    }
    return cls;
  }

  entry(candidateId: string): ForgeAaaRegistryEntry | undefined {
    const candidate = this.candidates.get(candidateId);
    if (!candidate) return undefined;
    const classification = this.effectiveClassification(candidateId);
    const latest = this.qualificationsFor(candidateId).at(-1);
    return {
      candidate,
      classification,
      qualifications: this.qualificationsFor(candidateId),
      statusDetail: latest ? `${candidate.statusDetail} [${latest.operation}: ${latest.detail}]` : candidate.statusDetail,
    };
  }

  entries(): ForgeAaaRegistryEntry[] {
    return [...this.candidates.keys()].map((id) => this.entry(id)!);
  }

  /** Candidates eligible to serve a specialty right now — VERIFIED_AVAILABLE or
   *  INTEGRATED only. EXPERIMENTAL supply is visible but never dispatched. */
  eligibleFor(specialty: ForgeAaaSpecialtyId): ForgeAaaRegistryEntry[] {
    return this.entries().filter((entry) =>
      (entry.classification === "VERIFIED_AVAILABLE" || entry.classification === "INTEGRATED")
      && entry.candidate.serves.includes(specialty));
  }

  eligibleLeads(): ForgeAaaRegistryEntry[] {
    return this.entries().filter((entry) =>
      (entry.classification === "VERIFIED_AVAILABLE" || entry.classification === "INTEGRATED")
      && entry.candidate.kind === "lead_model");
  }

  /** Persistable snapshot — candidates live in code; only evidence + overrides persist. */
  snapshot(): { qualifications: Record<string, ForgeAaaQualification[]>; registered: ForgeAaaCandidate[] } {
    return {
      qualifications: Object.fromEntries(this.qualifications),
      registered: [...this.candidates.values()].filter(
        (c) => !FORGE_AAA_SEED_CANDIDATES.some((s) => s.id === c.id)),
    };
  }

  restore(snapshot: { qualifications?: Record<string, ForgeAaaQualification[]>; registered?: ForgeAaaCandidate[] }): void {
    for (const candidate of snapshot.registered ?? []) this.register(candidate);
    for (const [id, list] of Object.entries(snapshot.qualifications ?? {})) {
      if (!this.candidates.has(id)) continue;
      this.qualifications.set(id, [...list]);
    }
  }
}

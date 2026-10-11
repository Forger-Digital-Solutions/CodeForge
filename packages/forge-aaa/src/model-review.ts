import type { ForgeAaaRun } from "./orchestrator.js";
import { createHash } from "node:crypto";
import type { Usage } from "@codeforge/providers";

/**
 * Model-backed independent review for ForgeAAA runs.
 *
 * `reviewRun` in the Director only records what it is given — the honesty contract lives
 * here: `independent: true` is reported only when the review actually went to an
 * inference model that took no part in the implementation (R79's staircase was built by
 * deterministic adapters, so any qualified reviewer model is independent of it), and the
 * caller must supply the qualification receipt fields so the run evidence can carry the
 * reviewer's real identity rather than a logical agent name.
 */

export interface ModelChatRequest {
  model: string;
  messages: { role: "system" | "user"; content: string }[];
  temperature?: number;
  maxTokens?: number;
}

export interface ModelReviewerQualification {
  providerId: string;
  suiteVersion: string;
  protocolVersion: string;
  status: string;
  completedAt: string;
}

export interface ModelReviewer {
  modelId: string;
  qualification: ModelReviewerQualification;
  /** Text-only callbacks remain callable, but cannot prove completion for certification. */
  chat: (req: ModelChatRequest) => Promise<string | ModelReviewResponse>;
  /** Bounded evidence packet builder — must not exceed packetMaxChars. */
  packetOf: (run: ForgeAaaRun) => string;
  packetMaxChars?: number;
  outputMaxTokens?: number;
}

export interface ModelReviewResponse {
  text: string;
  finishReason?: string;
  modelId?: string;
  requestId?: string;
  quotaDomain?: string;
  usage?: Usage;
}

export interface ModelReviewOutcome {
  approved: boolean;
  findings: string[];
  independent: boolean;
  reviewer?: { providerId: string; modelId: string };
  verdict?: "pass" | "revision_required";
  rawResponse?: string;
  receipt?: {
    packetSha256: string;
    packetChars: number;
    outputMaxTokens: number;
    completionSignal: string;
    schemaValid: boolean;
    requestId?: string;
    quotaDomain?: string;
    usage?: Usage;
  };
}

const REVIEWER_SCHEMA = `{"verdict":"pass"|"revision_required","findings":[{"id":string,"severity":"blocking"|"advisory","category":string,"message":string,"evidence"?:string}],"summary":string}`;

const SYSTEM_PROMPT = [
  "You are an independent evidence reviewer for a game-development milestone. You did not implement, run, or author any of the work under review — judge only the supplied evidence packet.",
  "Review the evidence against the declared functional requirements. Check for false-positive paths: tests that cannot fail, thresholds that ignore the measured data, missing evidence replaced by executor claims, and unsupported capabilities presented as supported.",
  "A pass verdict requires that every declared requirement is backed by actual evidence; advisory findings are permitted. revision_required requires at least one blocking finding.",
  `Respond with only one JSON object: ${REVIEWER_SCHEMA}`,
].join("\n");

const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Extracts the reviewer JSON from raw model text (tolerates fences/preamble). */
export function parseReviewResult(raw: string): { ok: boolean; verdict?: "pass" | "revision_required"; findings: string[]; error?: string } {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return { ok: false, findings: [], error: "no JSON object in reviewer response" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]) as unknown;
  } catch {
    return { ok: false, findings: [], error: "reviewer response is not valid JSON" };
  }
  if (!object(parsed) || (parsed.verdict !== "pass" && parsed.verdict !== "revision_required")) {
    return { ok: false, findings: [], error: "invalid reviewer verdict" };
  }
  if (!nonempty(parsed.summary) || !Array.isArray(parsed.findings) || parsed.findings.some((f: unknown) => !object(f)
    || !nonempty(f.id) || (f.severity !== "blocking" && f.severity !== "advisory")
    || !nonempty(f.category) || !nonempty(f.message) || (f.evidence !== undefined && !nonempty(f.evidence)))) {
    return { ok: false, findings: [], error: "incomplete reviewer schema" };
  }
  const entries = parsed.findings as Record<string, unknown>[];
  if (new Set(entries.map((f) => f.id)).size !== entries.length) return { ok: false, findings: [], error: "duplicate finding identity" };
  const findings = entries.map((f) => `[${String(f.severity)}] ${String(f.category)}: ${String(f.message)}${f.evidence ? ` (${String(f.evidence)})` : ""}`);
  if (parsed.verdict === "pass" && findings.some((f) => f.startsWith("[blocking]"))) {
    return { ok: false, findings, error: "pass verdict carried blocking findings" };
  }
  if (parsed.verdict === "revision_required" && !findings.some((f) => f.startsWith("[blocking]"))) {
    return { ok: false, findings, error: "revision_required without a blocking finding" };
  }
  return { ok: true, verdict: parsed.verdict, findings };
}

/**
 * Builds the Director's `reviewRun` dep for a genuinely independent reviewer. Returns
 * `independent: true` only when the model call completed and produced a schema-valid
 * verdict — unreachable or malformed reviewers degrade to independent:false, never to a
 * fabricated approval.
 */
export function createModelReviewer(opts: ModelReviewer) {
  const maxChars = opts.packetMaxChars ?? 48_000;
  const outputMaxTokens = opts.outputMaxTokens ?? 2_000;
  if (!Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > 84_000
    || !Number.isSafeInteger(outputMaxTokens) || outputMaxTokens < 1 || outputMaxTokens > 8_000) throw new Error("Invalid review budget");
  return async (run: ForgeAaaRun): Promise<ModelReviewOutcome> => {
    const identity = `reviewer: ${opts.qualification.providerId}/${opts.modelId} (${opts.qualification.status}, suite ${opts.qualification.suiteVersion}, protocol ${opts.qualification.protocolVersion}, qualified ${opts.qualification.completedAt})`;
    const reviewer = { providerId: opts.qualification.providerId, modelId: opts.modelId };
    const blocked = (reason: string): ModelReviewOutcome => ({ approved: false, independent: false, reviewer, findings: [`${identity} — ${reason}`] });
    if (opts.qualification.status !== "QUALIFIED" || !nonempty(opts.modelId)
      || !nonempty(opts.qualification.providerId) || !nonempty(opts.qualification.suiteVersion)
      || !nonempty(opts.qualification.protocolVersion) || !Number.isFinite(Date.parse(opts.qualification.completedAt))) return blocked("reviewer qualification unavailable");
    let packet: string;
    try { packet = opts.packetOf(run); } catch (error) { return blocked(`packet construction failed: ${String(error)}`); }
    if (typeof packet !== "string" || !packet.trim() || packet.length > maxChars) return blocked("review packet empty or exceeds bounded budget; evidence was not clipped or dispatched");
    const receipt: NonNullable<ModelReviewOutcome["receipt"]> = {
      packetSha256: createHash("sha256").update(packet).digest("hex"), packetChars: packet.length,
      outputMaxTokens, completionSignal: "call-failed", schemaValid: false,
    };
    let raw: string;
    let response: ModelReviewResponse | undefined;
    try {
      const result = await opts.chat({
        model: opts.modelId,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: packet },
        ],
        temperature: 0,
        maxTokens: outputMaxTokens,
      });
      response = typeof result === "string" ? undefined : result;
      raw = typeof result === "string" ? result : result.text;
    } catch (err) {
      return {
        approved: false,
        findings: [`${identity} — review call failed: ${err instanceof Error ? err.message : String(err)}`],
        independent: false,
        reviewer: { providerId: opts.qualification.providerId, modelId: opts.modelId },
        receipt,
      };
    }
    Object.assign(receipt, { completionSignal: response?.finishReason ?? "legacy-text-unreported",
      requestId: response?.requestId, quotaDomain: response?.quotaDomain, usage: response?.usage });
    if (!response || response.finishReason !== "stop" || response.modelId !== opts.modelId) {
      return { ...blocked("review response incomplete or served model unverified"), rawResponse: raw, receipt };
    }
    if (raw.length > outputMaxTokens * 16) return { ...blocked("review response exceeds bounded output budget"), rawResponse: raw, receipt };
    const parsed = parseReviewResult(raw);
    if (!parsed.ok) {
      return {
        approved: false,
        findings: [`${identity} — malformed review: ${parsed.error ?? "unknown"}`, ...parsed.findings],
        independent: false,
        reviewer: { providerId: opts.qualification.providerId, modelId: opts.modelId },
        rawResponse: raw,
        receipt,
      };
    }
    return {
      approved: parsed.verdict === "pass",
      findings: [identity, ...parsed.findings],
      independent: true,
      reviewer: { providerId: opts.qualification.providerId, modelId: opts.modelId },
      verdict: parsed.verdict,
      rawResponse: raw,
      receipt: { ...receipt, schemaValid: true },
    };
  };
}

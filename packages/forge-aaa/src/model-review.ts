import type { ForgeAaaRun } from "./orchestrator.js";

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
  /** Executes one bounded inference call and returns raw text. */
  chat: (req: ModelChatRequest) => Promise<string>;
  /** Bounded evidence packet builder — must not exceed packetMaxChars. */
  packetOf: (run: ForgeAaaRun) => string;
  packetMaxChars?: number;
}

export interface ModelReviewOutcome {
  approved: boolean;
  findings: string[];
  independent: boolean;
  reviewer?: { providerId: string; modelId: string };
  verdict?: "pass" | "revision_required";
  rawResponse?: string;
}

const REVIEWER_SCHEMA = `{"verdict":"pass"|"revision_required","findings":[{"id":string,"severity":"blocking"|"advisory","category":string,"message":string,"evidence"?:string}],"summary":string}`;

const SYSTEM_PROMPT = [
  "You are an independent evidence reviewer for a game-development milestone. You did not implement, run, or author any of the work under review — judge only the supplied evidence packet.",
  "Review the evidence against the declared functional requirements. Check for false-positive paths: tests that cannot fail, thresholds that ignore the measured data, missing evidence replaced by executor claims, and unsupported capabilities presented as supported.",
  "A pass verdict requires that every declared requirement is backed by actual evidence; advisory findings are permitted. revision_required requires at least one blocking finding.",
  `Respond with only one JSON object: ${REVIEWER_SCHEMA}`,
].join("\n");

interface ReviewResultShape {
  verdict?: string;
  findings?: { id?: string; severity?: string; category?: string; message?: string; evidence?: string }[];
  summary?: string;
}

/** Extracts the reviewer JSON from raw model text (tolerates fences/preamble). */
export function parseReviewResult(raw: string): { ok: boolean; verdict?: "pass" | "revision_required"; findings: string[]; error?: string } {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return { ok: false, findings: [], error: "no JSON object in reviewer response" };
  let parsed: ReviewResultShape;
  try {
    parsed = JSON.parse(match[0]) as ReviewResultShape;
  } catch {
    return { ok: false, findings: [], error: "reviewer response is not valid JSON" };
  }
  if (parsed.verdict !== "pass" && parsed.verdict !== "revision_required") {
    return { ok: false, findings: [], error: `invalid verdict "${String(parsed.verdict)}"` };
  }
  const findings = Array.isArray(parsed.findings)
    ? parsed.findings.map((f) => `[${f.severity ?? "?"}] ${f.category ?? "general"}: ${f.message ?? "unspecified"}${f.evidence ? ` (${f.evidence})` : ""}`)
    : [];
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
  return async (run: ForgeAaaRun): Promise<ModelReviewOutcome> => {
    const identity = `reviewer: ${opts.qualification.providerId}/${opts.modelId} (${opts.qualification.status}, suite ${opts.qualification.suiteVersion}, protocol ${opts.qualification.protocolVersion}, qualified ${opts.qualification.completedAt})`;
    let packet = opts.packetOf(run);
    if (packet.length > maxChars) packet = `${packet.slice(0, maxChars)}\n…[packet truncated at ${maxChars} chars]`;
    let raw: string;
    try {
      raw = await opts.chat({
        model: opts.modelId,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: packet },
        ],
        temperature: 0,
        maxTokens: 2_000,
      });
    } catch (err) {
      return {
        approved: false,
        findings: [`${identity} — review call failed: ${err instanceof Error ? err.message : String(err)}`],
        independent: false,
        reviewer: { providerId: opts.qualification.providerId, modelId: opts.modelId },
      };
    }
    const parsed = parseReviewResult(raw);
    if (!parsed.ok) {
      return {
        approved: false,
        findings: [`${identity} — malformed review: ${parsed.error ?? "unknown"}`, ...parsed.findings],
        independent: false,
        reviewer: { providerId: opts.qualification.providerId, modelId: opts.modelId },
        rawResponse: raw,
      };
    }
    return {
      approved: parsed.verdict === "pass",
      findings: [identity, ...parsed.findings],
      independent: true,
      reviewer: { providerId: opts.qualification.providerId, modelId: opts.modelId },
      verdict: parsed.verdict,
      rawResponse: raw,
    };
  };
}

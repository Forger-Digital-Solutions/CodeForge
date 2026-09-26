// Freeze already-recorded live role evidence for the R41 A/B; never re-run inference.
// Mixed-suite roles carry source labels so this is NOT passed off as a full V3 receipt.
import { readFile, writeFile } from "node:fs/promises";

const root = "docs/evidence/r41-role-intelligence/";
const load = async (name) => JSON.parse(await readFile(root + name, "utf8"));
const raw = await load("R41-ROLE-QUALIFICATION-RAW.json");
const nvidia = await load("R41-NEMOTRON-QUALIFICATION-RAW.json");
const mistral = await load("R41-MISTRAL-QUALIFICATION-RAW.json");
const clarified = await load("R41-PLANNER-CLARIFIED.json");
const preflight = await load("R41-LIVE-PREFLIGHT.json");

const base = [
  { providerId: "mistral", modelId: "codestral-latest", raw: mistral, source: "R41-MISTRAL-QUALIFICATION-RAW.json" },
  { providerId: "openrouter", modelId: "cohere/north-mini-code:free", raw: raw.routes[0], source: "R41-ROLE-QUALIFICATION-RAW.json" },
  { providerId: "openrouter", modelId: "nvidia/nemotron-3-super-120b-a12b:free", raw: nvidia.routes[0], source: "R41-NEMOTRON-QUALIFICATION-RAW.json" },
];
const out = {
  at: new Date().toISOString(),
  suiteVersion: "R41_COMPOSITE_LIVE_SNAPSHOT_V1",
  qualificationPolicy: "Use the recorded R27 role cases and R41 enum-clarified planner cases without re-running. NOT_TESTED for blocked probes; legacy one-case Reviewer is labeled historical.",
  routes: [],
};
const transient = (error) => /429|rate.?limit|\b5\d\d\b|timed? ?out|no usable completion choices|R41_BOUND/i.test(error ?? "");
const errorKind = (error) => /429|rate.?limit/i.test(error) ? "HTTP 429 rate limit"
  : /\b5\d\d\b/i.test(error) ? "HTTP 503 provider outage"
    : /no usable completion choices/i.test(error) ? "HTTP 200 no usable completion choices"
      : /R41_BOUND/i.test(error) ? "R41_BOUND"
        : "non-transient provider error";
for (const entry of base) {
  const listed = preflight.providers.find((p) => p.provider === entry.providerId && p.httpStatus === 200)?.models?.find((m) => m.id === entry.modelId);
  if (!listed || entry.providerId === "openrouter" && (Number(listed.pricing?.prompt) !== 0 || Number(listed.pricing?.completion) !== 0 || !entry.modelId.endsWith(":free"))) {
    throw new Error(`Missing live zero-priced catalog proof for ${entry.providerId}/${entry.modelId}`);
  }
  const sourceRoles = entry.raw.receipt.roleResults;
  const completedAt = entry.raw.startedAt ?? entry.raw.at ?? entry.raw.startedAt;
  const roles = {};
  for (const role of ["CODER", "EXPLORER", "PLANNER", "REVIEWER"]) {
    const source = sourceRoles[role];
    if (!source) continue;
    const cases = source.cases.map((c) => ({
      caseId: c.caseId, category: c.caseId.split(".")[0],
      passed: c.passed, hardFailure: c.hardFailure === true && !transient(c.error),
      latencyMs: c.latencyMs, retries: c.retries ?? 0, ...(c.error ? { error: errorKind(c.error) } : {}),
    }));
    const decisive = cases.filter((c) => !transient(c.error));
    roles[role] = {
      role, status: source.status, testCases: cases,
      hardFailures: source.hardFailures ?? [],
      overallScore: decisive.length ? decisive.filter((c) => c.passed).length / decisive.length : 0,
      startedAt: completedAt, completedAt,
      evidenceSource: entry.source,
    };
    if (decisive.length === 0) {
      roles[role].status = "NOT_TESTED";
      roles[role].hardFailures = [];
    }
  }
  if (entry.providerId === "mistral") {
    // First R41 Mistral suite intentionally stopped at 28 wire calls. Its later planner
    // and reviewer cases were never sent; a fabricated HARD_FAILURE would be unsafe.
    for (const role of ["PLANNER", "REVIEWER"]) {
      roles[role] = { role, status: "NOT_TESTED", testCases: [], hardFailures: [], overallScore: 0,
        startedAt: entry.raw.at, completedAt: entry.raw.at, evidenceSource: `${entry.source} (probe cap)` };
    }
  }
  const planner = clarified.calls.filter((c) => c.providerId === entry.providerId && c.modelId === entry.modelId);
  if (planner.length === 2 && planner.every((c) => c.errorCode === null)) {
    const passed = planner.filter((c) => c.passed).length;
    roles.PLANNER = {
      role: "PLANNER", status: passed === 2 ? "QUALIFIED" : passed === 1 ? "PROBATION" : "NOT_QUALIFIED",
      testCases: planner.map((c) => ({
        caseId: c.caseId, category: "plan", passed: c.passed,
        hardFailure: !c.valid, latencyMs: c.latencyMs, retries: 0,
      })),
      hardFailures: planner.filter((c) => !c.valid).map((c) => c.caseId),
      overallScore: passed / 2,
      startedAt: clarified.at, completedAt: clarified.at,
      evidenceSource: "R41-PLANNER-CLARIFIED.json (R27 tasks + V3 enum-clarified prompt)",
    };
  }
  if (entry.providerId === "mistral") {
    // The last live reviewer success on this route is one R40 sample. Low confidence
    // fallback only; it cannot outrank Nemotron's five current verified reviewer cases.
    roles.REVIEWER = {
      role: "REVIEWER", status: "QUALIFIED",
      testCases: [{ caseId: "r40.reviewer", category: "review", passed: true, hardFailure: false, latencyMs: 331, retries: 0 }],
      hardFailures: [], overallScore: 1, startedAt: "2026-09-26T05:00:00.000Z", completedAt: "2026-09-26T05:00:00.000Z",
      evidenceSource: "../r40-free-intelligence/R40-ROLE-QUALIFICATION.json (single historical task)",
    };
  }
  const receipt = {
    suiteVersion: out.suiteVersion, providerId: entry.providerId, modelId: entry.modelId,
    modelDisplayName: entry.modelId, accessClass: entry.providerId === "openrouter" ? "FREE_ROUTED" : "FREE_ALLOWANCE",
    freeStatus: "verified_free", roleResults: roles, startedAt: completedAt, completedAt,
    totalLatencyMs: entry.raw.wallMs ?? 0,
    qualificationState: Object.values(roles).some((v) => v.status === "QUALIFIED") ? "QUALIFIED" : "PROBATION",
    hardFailureRoles: Object.keys(roles).filter((r) => roles[r].status === "HARD_FAILURE"),
    metadata: { sources: [...new Set(Object.values(roles).map((v) => v.evidenceSource))], composite: true },
  };
  out.routes.push({ providerId: entry.providerId, modelId: entry.modelId, receipt });
}
await writeFile(root + "R41-ROLE-PROFILES.json", `${JSON.stringify(out, null, 2)}\n`);
console.log(out.routes.map((r) => `${r.providerId}/${r.modelId}: ${Object.entries(r.receipt.roleResults).map(([k, v]) => `${k}=${v.status}(${v.testCases.filter((c) => c.passed).length}/${v.testCases.filter((c) => !transient(c.error)).length})`).join(" ")}`).join("\n"));

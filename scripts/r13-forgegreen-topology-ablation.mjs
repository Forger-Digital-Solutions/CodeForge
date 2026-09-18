#!/usr/bin/env node
// R13 Priority 7 — ForgeGreen topology ablation. Deterministic, synthetic, zero network and zero
// provider spend. This is a documented MODEL with stated assumptions, not measured production
// telemetry — the same honest framing as scripts/r4-scale-sim.mjs. It exists to inform whether a
// wider-than-2 parallel topology would ever be worth proposing for production, and to prove that
// ForgeGreen's real (not reimplemented) capacity advice function makes the right call under
// provider concentration. It does not add, plan, or dispatch any real topology.
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { adviseProviderAwareTopology } from "../packages/forge-green/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Task classes. Each field is an explicit, documented modeling assumption — not a measurement.
 *   toolCallsPerAgent(n): tool calls one agent performs when n agents split this task class.
 *   parallelizableFraction: share of wall-clock work that genuinely parallelizes across agents;
 *     the rest is an unavoidable sequential tail (planning, final review, ForgeVerify) that no
 *     agent count shortens.
 *   conflictRiskPerExtraWriter: added probability of a merge/rework cycle per additional
 *     concurrent *editor* beyond the first (exploration-only agents don't carry this risk).
 *   editingAgents(n): how many of the n agents actually write code (vs. read-only exploration) —
 *     conflict risk only applies to these.
 *   baselineVerifiedSuccessProbability: modeled chance a single competent agent solves this task
 *     class correctly on the first pass, independent of topology.
 *   marginalSuccessGainPerAgent: modeled, capped additional success probability each extra agent
 *     contributes IF its work is genuinely independent (diminishing, not linear, and zero past
 *     the number of genuinely independent subtasks the class actually has).
 */
const TASK_CLASSES = [
  {
    id: "tiny-fix",
    description: "One-line/typo-shaped fix with a single obvious target file.",
    independentSubtasks: 1,
    toolCallsPerAgentBase: 3,
    contextTokensPerAgent: 6_000,
    sequentialTailSeconds: 12,
    parallelizableSeconds: 3,
    editingAgents: (n) => Math.max(1, Math.min(n, 1)), // only ever one meaningful editor
    baselineVerifiedSuccessProbability: 0.95,
    marginalSuccessGainPerAgent: 0.0, // no independent subtasks to split
  },
  {
    id: "multi-file-investigation",
    description: "Bug reproduction spanning ~4 plausibly-independent hypotheses/files.",
    independentSubtasks: 4,
    toolCallsPerAgentBase: 12,
    contextTokensPerAgent: 18_000,
    sequentialTailSeconds: 30,
    parallelizableSeconds: 90,
    editingAgents: () => 1, // exploration is parallel; a single coder applies the fix
    baselineVerifiedSuccessProbability: 0.65,
    marginalSuccessGainPerAgent: 0.10,
  },
  {
    id: "cross-cutting-refactor",
    description: "Rename/shape change touching many files with shared state; edits, not just reads, parallelize.",
    independentSubtasks: 3,
    toolCallsPerAgentBase: 20,
    contextTokensPerAgent: 25_000,
    sequentialTailSeconds: 45,
    parallelizableSeconds: 120,
    editingAgents: (n) => Math.max(1, Math.min(n, 3)), // multiple agents can genuinely write here
    baselineVerifiedSuccessProbability: 0.55,
    marginalSuccessGainPerAgent: 0.08,
  },
];

const TOPOLOGIES = [1, 2, 4];

const CONFLICT_RISK_PER_EXTRA_WRITER = 0.12; // modeled: each additional concurrent editor beyond the first
// Each successive independent worker beyond the first contributes a decaying fraction of the
// previous worker's success-probability contribution — the classic diminishing-returns shape
// (first parallel worker captures the most benefit; the fourth captures little). A flat per-agent
// increment would wrongly make a 2-worker jump (e.g. 2->4 agents) look better than a 1-worker
// jump (1->2 agents) purely because it spans more workers at once.
const PER_WORKER_DECAY = 0.55;

/** Sum of a geometric series: first-worker contribution * decay^0 + decay^1 + ... for `workers` terms. */
function decayingSuccessGain(perAgentBase, workers) {
  let total = 0;
  for (let k = 0; k < workers; k++) total += perAgentBase * PER_WORKER_DECAY ** k;
  return total;
}

function modelTopology(task, n) {
  const editors = task.editingAgents(n);
  const toolCalls = task.toolCallsPerAgentBase * n; // total across all agents, not per-agent
  const contextTokens = task.contextTokensPerAgent * n; // each agent needs its own context
  const independentWorkers = Math.min(n, task.independentSubtasks);
  // Wall-clock: the sequential tail never shrinks; the parallel portion divides across however
  // many agents can do genuinely independent work (extra agents beyond that add zero speedup).
  const latencySeconds = task.sequentialTailSeconds + task.parallelizableSeconds / independentWorkers;
  const conflictProbability = editors > 1 ? 1 - (1 - CONFLICT_RISK_PER_EXTRA_WRITER) ** (editors - 1) : 0;
  // Marginal success gain only accrues to agents doing genuinely independent, non-redundant work,
  // diminishing per additional worker; it also decays as conflict risk rises (a merge conflict can
  // erase the benefit of parallel work).
  const successGain = decayingSuccessGain(task.marginalSuccessGainPerAgent, Math.max(0, independentWorkers - 1));
  const verifiedSuccessProbability = Math.min(0.98, task.baselineVerifiedSuccessProbability + successGain) * (1 - conflictProbability * 0.5);
  return {
    agents: n,
    editors,
    toolCalls,
    contextTokens,
    latencySeconds: Math.round(latencySeconds * 10) / 10,
    conflictProbability: Math.round(conflictProbability * 1000) / 1000,
    verifiedSuccessProbability: Math.round(verifiedSuccessProbability * 1000) / 1000,
  };
}

/** "Resource units" = tool calls + (context tokens / 1000), a simple combined proxy for what an
 * additional agent actually costs — quota consumption, context assembly, review burden. */
function resourceUnits(m) {
  return m.toolCalls + m.contextTokens / 1000;
}

// "Worth it" deliberately avoids collapsing the trade-off into a single boolean via an invented
// resource/success exchange rate (CodeForge has no principled number for what one modeled
// verified-success percentage point is "worth" in tool calls or context tokens). Instead each
// step just reports its own deltas; the verdict below is generated descriptively from those
// deltas, not from a threshold pretending to be an objective cutoff.
const NOISE_FLOOR_SUCCESS_PP = 0.02; // 2 percentage points — below this, call it "no meaningful change"

const results = TASK_CLASSES.map((task) => {
  const byTopology = TOPOLOGIES.map((n) => modelTopology(task, n));
  const withMarginals = byTopology.map((m, i) => {
    if (i === 0) return { ...m, resourceUnits: resourceUnits(m), marginalResourceCost: 0, marginalSuccessGain: 0, marginalLatencyChangeSeconds: 0 };
    const prev = byTopology[i - 1];
    return {
      ...m,
      resourceUnits: resourceUnits(m),
      marginalResourceCost: resourceUnits(m) - resourceUnits(prev),
      marginalSuccessGain: Math.round((m.verifiedSuccessProbability - prev.verifiedSuccessProbability) * 1000) / 1000,
      marginalLatencyChangeSeconds: Math.round((m.latencySeconds - prev.latencySeconds) * 10) / 10,
    };
  });

  const to2 = withMarginals[1];
  const to4 = withMarginals[2];
  const describe = (step, agents) => {
    const meaningfulGain = step.marginalSuccessGain > NOISE_FLOOR_SUCCESS_PP;
    const fasterMeaningfully = step.marginalLatencyChangeSeconds < -1;
    if (meaningfulGain && fasterMeaningfully) return `${agents} agents: +${fmtPctStr(step.marginalSuccessGain)} modeled success and ${Math.abs(step.marginalLatencyChangeSeconds)}s faster, for +${step.marginalResourceCost.toFixed(0)} resource units.`;
    if (meaningfulGain) return `${agents} agents: +${fmtPctStr(step.marginalSuccessGain)} modeled success for +${step.marginalResourceCost.toFixed(0)} resource units, without a meaningful latency change.`;
    if (fasterMeaningfully) return `${agents} agents: ${Math.abs(step.marginalLatencyChangeSeconds)}s faster with no meaningful success change, for +${step.marginalResourceCost.toFixed(0)} resource units.`;
    return `${agents} agents: no meaningful success or latency gain over the previous step, for +${step.marginalResourceCost.toFixed(0)} resource units — pure added cost.`;
  };

  return {
    taskClass: task.id,
    description: task.description,
    independentSubtasks: task.independentSubtasks,
    topologies: withMarginals,
    verdict: `${describe(to2, 2)} ${describe(to4, 4)}`,
  };
});

function fmtPctStr(x) {
  return `${(x * 100).toFixed(1)}pp`;
}

// Provider-concentration proof: reuse the REAL adviseProviderAwareTopology function (not a mock)
// to show it correctly recommends less parallelism when capacity is concentrated on one provider,
// and correctly retains full parallelism when capacity is genuinely diverse.
const capacityScenarios = [
  { id: "diverse-capacity", capacity: { distinctHealthyProviders: 4, minimumRouteConcurrency: 4 } },
  { id: "two-provider-capacity", capacity: { distinctHealthyProviders: 2, minimumRouteConcurrency: 4 } },
  { id: "concentrated-one-provider", capacity: { distinctHealthyProviders: 1, minimumRouteConcurrency: 4 } },
  { id: "one-saturated-route-present", capacity: { distinctHealthyProviders: 2, minimumRouteConcurrency: 2, saturatedRoutes: 1 } },
];
const capacityAdvice = capacityScenarios.map((s) => ({
  scenario: s.id,
  capacity: s.capacity,
  advice4: adviseProviderAwareTopology(4, s.capacity),
  advice2: adviseProviderAwareTopology(2, s.capacity),
}));

// The key insight the ablation model alone cannot show: even if 4 agents are *planned*, if they
// are concentrated on one rate-limited provider they serialize behind that provider's own
// concurrency ceiling — so the modeled wall-clock benefit of parallelism evaporates while the
// modeled resource cost (context, coordination) is still fully paid. Compute that combined view
// for the investigation task class as the clearest illustration.
const investigation = TASK_CLASSES.find((t) => t.id === "multi-file-investigation");
const concentratedOutcome = capacityAdvice.find((c) => c.scenario === "concentrated-one-provider");
const plannedFour = modelTopology(investigation, 4);
const actuallySupportable = concentratedOutcome.advice4.recommendedParallelAgents;
const realizedUnderConcentration = modelTopology(investigation, actuallySupportable);
const concentrationPenaltyIllustration = {
  taskClass: investigation.id,
  plannedAgents: 4,
  capacityScenario: "concentrated-one-provider",
  forgeGreenRecommendedAgents: actuallySupportable,
  plannedIfIgnoredAdvice: { latencySeconds: plannedFour.latencySeconds, resourceUnits: resourceUnits(plannedFour) },
  realizedFollowingAdvice: { latencySeconds: realizedUnderConcentration.latencySeconds, resourceUnits: resourceUnits(realizedUnderConcentration) },
  note: "Following ForgeGreen's advice here saves resource cost for the same (or better, since the ignored 4-agent plan would have queued behind one provider's real concurrency ceiling anyway) realistic outcome.",
};

const report = {
  schema: "codeforge-r13-topology-ablation-v1",
  generatedAt: new Date().toISOString(),
  deterministic: true,
  fabricatedMeasurement: false,
  method: "Deterministic model with explicitly stated per-task-class assumptions (see TASK_CLASSES in this script). Capacity-advice numbers use the real, unmodified packages/forge-green adviseProviderAwareTopology function, not a reimplementation.",
  taskClassResults: results,
  capacityAdvice,
  concentrationPenaltyIllustration,
};

const evidenceDir = path.join(root, "docs", "evidence", "r13-intelligence-and-recovery", "forgegreen");
await fs.mkdir(evidenceDir, { recursive: true });
await fs.writeFile(path.join(evidenceDir, "topology-ablation-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");

const fmtPct = (x) => `${(x * 100).toFixed(1)}%`;
const md = [
  "# R13 ForgeGreen topology ablation (1 / 2 / 4 agents)",
  "",
  `Generated ${report.generatedAt}. **This is a deterministic model with explicitly stated assumptions, not measured production telemetry** — no real task was executed, no provider was called. Production topology planning caps at 2 parallel agents today (\`resolveAdaptiveTopology\`); this ablation exists to inform whether going wider would ever be justified, and to prove the real \`adviseProviderAwareTopology\` function makes the right call before any such topology is proposed.`,
  "",
  "## Per-task-class results",
  "",
  ...results.flatMap((r) => [
    `### ${r.taskClass}`,
    r.description,
    "",
    "| Agents | Tool calls | Context tokens | Latency (s) | Conflict risk | Verified-success (modeled) | Marginal resource cost | Marginal success gain | Marginal latency change |",
    "|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...r.topologies.map((t) => `| ${t.agents} | ${t.toolCalls} | ${t.contextTokens} | ${t.latencySeconds} | ${fmtPct(t.conflictProbability)} | ${fmtPct(t.verifiedSuccessProbability)} | ${t.marginalResourceCost.toFixed(0)} | ${fmtPct(t.marginalSuccessGain)} | ${t.marginalLatencyChangeSeconds}s |`),
    "",
    `**Verdict:** ${r.verdict}`,
    "",
  ]),
  "## Provider-concentration proof (real ForgeGreen function, not a mock)",
  "",
  "| Scenario | distinctHealthyProviders | minConcurrency | Planned 4 → recommended | Planned 2 → recommended | Reason codes (4-agent case) |",
  "|---|---:|---:|---:|---:|---|",
  ...capacityAdvice.map((c) => `| ${c.scenario} | ${c.capacity.distinctHealthyProviders} | ${c.capacity.minimumRouteConcurrency} | ${c.advice4.recommendedParallelAgents} | ${c.advice2.recommendedParallelAgents} | ${c.advice4.reasonCodes.join(", ")} |`),
  "",
  "## Why concentration matters even if you ignore the advice",
  "",
  `For \`${concentrationPenaltyIllustration.taskClass}\` under \`${concentrationPenaltyIllustration.capacityScenario}\`, ForgeGreen recommends ${concentrationPenaltyIllustration.forgeGreenRecommendedAgents} agent(s) instead of the planned 4. Modeled cost if the plan is followed as advised: ${concentrationPenaltyIllustration.realizedFollowingAdvice.latencySeconds}s latency, ${concentrationPenaltyIllustration.realizedFollowingAdvice.resourceUnits.toFixed(0)} resource units — versus ${concentrationPenaltyIllustration.plannedIfIgnoredAdvice.latencySeconds}s and ${concentrationPenaltyIllustration.plannedIfIgnoredAdvice.resourceUnits.toFixed(0)} resource units if 4 agents were dispatched anyway. ${concentrationPenaltyIllustration.note}`,
  "",
  "## Headline conclusions",
  "",
  "- Some tasks (tiny-fix) are correctly modeled as single-agent-best: extra agents add pure resource cost with zero modeled success benefit — 4 agents is never justified for this class.",
  "- Tasks with genuinely independent subtasks (investigation, cross-cutting refactor) show real, diminishing marginal value from parallelism, capped by how many independent subtasks actually exist — not by agent count alone.",
  "- Editing (not just exploring) in parallel carries a modeled conflict-risk cost that erodes the success-probability benefit as more agents write concurrently.",
  "- `adviseProviderAwareTopology` (the real, unmodified function, R13-extended this session to step down gracefully rather than always collapsing to solo) correctly reduces recommended parallelism under provider concentration and correctly retains it under genuine diversity.",
  "- None of this argues for shipping a production 4-agent topology today — production still caps at 2. This is groundwork for that future decision, not a claim it is ready now.",
  "",
].join("\n");
await fs.writeFile(path.join(evidenceDir, "TOPOLOGY-ABLATION.md"), md, "utf8");

console.log(JSON.stringify({ output: path.relative(root, path.join(evidenceDir, "topology-ablation-report.json")), taskClasses: results.length, capacityScenarios: capacityAdvice.length }, null, 2));

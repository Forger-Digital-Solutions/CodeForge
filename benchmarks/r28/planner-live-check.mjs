// R28 Planner live check — a real model turn with the production planner prompt,
// parsed through the real validateStructuredAgentResult + validatePlanningCompleteness
// pipeline exactly as autonomous-orchestrator consumes it.
//
//   node benchmarks/r28/planner-live-check.mjs
import fs from "node:fs";
import { createOpenRouterAdapter } from "@codeforge/providers";
import { ROLE_PROMPTS, renderAuthorityBoundaryContract, validateStructuredAgentResult, validatePlanningCompleteness } from "@codeforge/agent";

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + String(detail).slice(0, 170) : ""}`); };

const adapter = createOpenRouterAdapter();
const model = process.env.R28_PLANNER_MODEL ?? "nvidia/nemotron-3-super-120b-a12b:free";
const goal = "Add a rate-limit middleware to this Node.js Express API: 100 requests per minute per IP on /api/*, return 429 with Retry-After, cover it with tests.";

const system = `${ROLE_PROMPTS.planner.systemPromptTemplate}\n\n${renderAuthorityBoundaryContract("planner")}`;
const user = `GOAL: ${goal}\n\nProduce the plan now. Return only the JSON protocol object — no prose, no markdown fences.`;

console.log(`planner model: ${model}`);
const started = Date.now();
const resp = await adapter.chat({ model, system, messages: [{ role: "user", content: user }], temperature: 0.2, maxTokens: 4000 });
const text = resp.choices?.[0]?.message?.content ?? "";
check("planner produced output", typeof text === "string" && text.length > 50, `${text.length} chars, finish=${resp.choices?.[0]?.finishReason}, ${Date.now() - started}ms`);

const validated = validateStructuredAgentResult("planner", text);
check("output canonicalizes via validateStructuredAgentResult", validated.success === true, validated.success ? `${validated.data.tasks.length} tasks, sourceProtocol=${validated.data.sourceProtocol ?? "task_graph_v1"}` : validated.error);

if (validated.success) {
  const plan = validated.data;
  const completeness = validatePlanningCompleteness(goal, plan);
  check("planning completeness gate", completeness.valid === true, completeness.valid ? "" : JSON.stringify(completeness).slice(0, 150));
  const roles = new Set(plan.tasks.map((t) => t.assignedRole));
  check("plan has coder + reviewer (authorization requirement)", roles.has("coder") && roles.has("reviewer"), [...roles].join(","));
  const ids = new Set(plan.tasks.map((t) => t.id));
  const depsResolve = plan.tasks.every((t) => t.dependencies.every((d) => ids.has(d)));
  check("all dependencies resolve to real task ids", depsResolve, "");
  // Topological sanity: no task depends on itself or creates a cycle
  const visiting = new Set(); const done = new Set();
  const acyclic = (id) => { if (done.has(id)) return true; if (visiting.has(id)) return false; visiting.add(id); const t = plan.tasks.find((x) => x.id === id); const ok = t.dependencies.every(acyclic); visiting.delete(id); done.add(id); return ok; };
  check("dependency graph is acyclic", plan.tasks.every((t) => acyclic(t.id)), "");
  const hasVerification = plan.tasks.some((t) => t.assignedRole === "reviewer" || /verif|test|check/i.test(t.objective + " " + t.title));
  check("plan contains verification/review coverage", hasVerification, "");
  check("tasks carry real objectives", plan.tasks.every((t) => t.objective.length > 10), "");
}

const passed = results.filter((r) => r.ok).length;
console.log(`\nPLANNER_LIVE_CHECK ${passed}/${results.length} PASS`);
fs.writeFileSync("docs/evidence/r28-capability-completion/R28-PLANNER-LIVE-EVIDENCE.json", JSON.stringify({
  schema: "r28-planner-live-check-1",
  recordedAt: new Date().toISOString(),
  model, provider: "openrouter",
  surface: "real planner turn — ROLE_PROMPTS.planner + authority boundary → OpenRouter chat → validateStructuredAgentResult → validatePlanningCompleteness (same pipeline as autonomous-orchestrator)",
  results,
}, null, 2) + "\n");
process.exit(passed === results.length ? 0 : 1);

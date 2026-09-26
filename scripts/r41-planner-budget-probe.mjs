// Targeted R41 planner qualification under the actual role output cap.
// Uses the existing frozen R27 tasks and graph requirements without altering them.
import { readFile, writeFile } from "node:fs/promises";
import { createMistralAdapter, createOpenRouterAdapter, createGroqAdapter } from "../packages/providers/dist/index.js";
import { validateStructuredAgentResult } from "../packages/agent/dist/index.js";
import { EXPLORER_REPO, PLANNER_CASES } from "../packages/eight-bit/dist/qualification/role-protocols.js";
import { roleOutputBudget } from "../packages/server/dist/role-output-budget.js";

const out = process.argv[2] ?? "docs/evidence/r41-role-intelligence/R41-PLANNER-BUDGET.json";
const preflight = JSON.parse(await readFile("docs/evidence/r41-role-intelligence/R41-LIVE-PREFLIGHT.json", "utf8"));
const r40 = JSON.parse(await readFile("docs/evidence/r40-free-intelligence/R40-LIVE-FREE-INVENTORY.json", "utf8"));
const routes = [
  { providerId: "mistral", modelId: "codestral-latest", make: createMistralAdapter },
  { providerId: "openrouter", modelId: "nvidia/nemotron-3-super-120b-a12b:free", make: createOpenRouterAdapter },
  { providerId: "groq", modelId: "openai/gpt-oss-120b", make: createGroqAdapter },
];
const sys = "You are a task planner. Reply with exactly one JSON protocol. task_graph_v1 is {\"protocol\":\"task_graph_v1\",\"summary\",\"tasks\":[{\"id\",\"title\",\"objective\",\"dependencies\",\"assignedRole\"}]}; semantic_steps_v1 is {\"protocol\":\"semantic_steps_v1\",\"summary\",\"steps\":[{\"id\",\"intent\",\"phase\",\"after\"}]}, where phase is investigation, planning, implementation, or verification. Never mix protocols. Both forms are normalized to the same task graph: implementation must precede verification. Plan only what the task requires - no invented files, no rewrites.";
const result = { at: new Date().toISOString(), protocol: "R27 frozen planner cases; roleOutputBudget(PLANNER)", maxRequests: 6, calls: [] };
for (const route of routes) {
  const p = preflight.providers.find((item) => item.provider === route.providerId && item.httpStatus === 200);
  const listed = p?.models?.find((item) => item.id === route.modelId);
  const r40Listed = r40.byProvider?.[route.providerId]?.includes(route.modelId);
  const pricedZero = route.providerId !== "openrouter" || (route.modelId.endsWith(":free") && Number(listed?.pricing?.prompt) === 0 && Number(listed?.pricing?.completion) === 0);
  if (!listed || !r40Listed || !pricedZero) throw new Error(`Fail closed: ${route.providerId}/${route.modelId} lacks current catalog and R40 free proof.`);
  const adapter = route.make({ timeoutMs: 45_000 });
  const maxTokens = roleOutputBudget({ role: "planner", providerId: route.providerId, modelId: route.modelId }).maxTokens;
  for (const caze of PLANNER_CASES) {
    if (result.calls.length >= result.maxRequests) throw new Error("Planner probe request cap exceeded");
    const files = caze.findingsFiles.map((f) => `--- ${f} ---\n${EXPLORER_REPO.files[f] ?? "(missing)"}`).join("\n");
    const messages = [
      { role: "system", content: sys },
      { role: "user", content: `Task: ${caze.task}\n\nExplorer findings (the only repository files that exist for you):\n${files}` },
    ];
    const record = { providerId: route.providerId, modelId: route.modelId, caseId: caze.caseId, maxTokens, inputTokens: null, outputTokens: null, reasoningTokens: null, costUsd: null, visibleChars: 0, finishReason: null, valid: false, passed: false, errorCode: null, latencyMs: null };
    const started = Date.now();
    let text = "";
    try {
      for await (const ev of adapter.streamChat({ model: route.modelId, messages, temperature: 0, maxTokens })) {
        if (ev.type === "text_delta") text += ev.delta;
        if (ev.type === "usage") {
          record.inputTokens = ev.usage.inputTokens;
          record.outputTokens = ev.usage.outputTokens;
          record.reasoningTokens = ev.usage.reasoningTokens ?? null;
          record.costUsd = ev.usage.costUsd ?? null;
        }
        if (ev.type === "finish") record.finishReason = ev.finishReason;
        if (ev.type === "error") { record.errorCode = ev.code; break; }
      }
      record.visibleChars = text.length;
      const parsed = validateStructuredAgentResult("planner", text);
      record.valid = parsed.success;
      if (parsed.success) {
        const tasks = parsed.data.tasks ?? [];
        const byId = new Map(tasks.map((t) => [String(t.id), t]));
        const reaches = (task, role, seen = new Set()) => {
          for (const dep of task.dependencies ?? []) {
            if (seen.has(dep)) continue;
            seen.add(dep);
            const upstream = byId.get(dep);
            if (upstream && (String(upstream.assignedRole).toLowerCase() === role || reaches(upstream, role, seen))) return true;
          }
          return false;
        };
        const required = caze.requiredRoles.every((role) => tasks.some((t) => String(t.assignedRole).toLowerCase() === role));
        const ordered = caze.requiredOrder.every(([before, after]) =>
          tasks.filter((t) => String(t.assignedRole).toLowerCase() === after).every((t) => reaches(t, before)));
        const textOf = tasks.map((t) => `${t.title ?? ""} ${t.objective ?? ""}`).join(" ").toLowerCase();
        const paths = textOf.match(/(?:[\w.-]+\/)+[\w.-]+\.\w+/g) ?? [];
        const invented = paths.filter((f) => !caze.findingsFiles.includes(f) && !f.startsWith("http"));
        const verification = tasks.some((t) => /verif|test|review/i.test(`${t.title} ${t.objective}`) || String(t.assignedRole).toLowerCase() === "reviewer");
        record.passed = required && ordered && invented.length === 0 && verification && tasks.length <= caze.maxTasks;
      }
    } catch (error) {
      record.errorCode = error?.code ?? error?.name ?? "UNKNOWN";
    }
    record.latencyMs = Date.now() - started;
    result.calls.push(record);
    await writeFile(out, `${JSON.stringify(result, null, 2)}\n`);
    if (record.costUsd !== null && record.costUsd > 0) throw new Error("Unexpected positive cost: stop.");
    if (record.errorCode) break; // never hammer a blocked route in the same probe
  }
}
console.log(JSON.stringify(result.calls.map(({ providerId, modelId, caseId, maxTokens, reasoningTokens, outputTokens, visibleChars, valid, passed, errorCode }) => ({ providerId, modelId, caseId, maxTokens, reasoningTokens, outputTokens, visibleChars, valid, passed, errorCode }))));

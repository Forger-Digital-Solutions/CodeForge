import type { WorkspaceEvent } from "@codeforge/protocol";

function unifiedDiff(path: string, hunks: { line: number; type: "context" | "addition" | "removal"; text: string }[]): string {
  const header = `--- a/${path}\n+++ b/${path}\n`;
  const body = hunks.map((hunk) => {
    const prefix = hunk.type === "addition" ? "+" : hunk.type === "removal" ? "-" : " ";
    return `${prefix}${hunk.text}`;
  }).join("\n");
  return `${header}${body}`;
}

export interface RuntimeOptions {
  sessionId: string;
  turnId: string;
  emit: (event: WorkspaceEvent) => void;
  delayMs?: number;
}

export async function runDemoRuntime(options: RuntimeOptions): Promise<void> {
  const { sessionId, turnId, emit, delayMs = 600 } = options;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  emit({
    type: "status.changed",
    timestamp: new Date().toISOString(),
    seq: 0,
    sessionId,
    payload: { from: "idle", to: "running" },
  });

  emit({
    type: "agent.started",
    timestamp: new Date().toISOString(),
    seq: 0,
    sessionId,
    payload: { agentId: "lead", role: "Lead Agent", taskId: turnId },
  });

  emit({
    type: "subagent.started",
    timestamp: new Date().toISOString(),
    seq: 0,
    sessionId,
    payload: { agentId: "explorer", role: "Repository Explorer", parentAgentId: "lead", task: "Scan repository structure and identify key files" },
  });

  await sleep(delayMs);

  emit({
    type: "subagent.progress",
    timestamp: new Date().toISOString(),
    seq: 0,
    sessionId,
    payload: { agentId: "explorer", message: "Analyzing repository structure...", percent: 30 },
  });

  await sleep(delayMs);

  emit({
    type: "file.read",
    timestamp: new Date().toISOString(),
    seq: 0,
    sessionId,
    payload: { fileCallId: crypto.randomUUID(), path: "src/ForgeRouter.cs", lines: 245 },
  });

  await sleep(delayMs * 0.5);

  emit({
    type: "file.read",
    timestamp: new Date().toISOString(),
    seq: 0,
    sessionId,
    payload: { fileCallId: crypto.randomUUID(), path: "src/ProviderCatalogService.cs", lines: 180 },
  });

  await sleep(delayMs * 0.5);

  emit({
    type: "subagent.completed",
    timestamp: new Date().toISOString(),
    seq: 0,
    sessionId,
    payload: { agentId: "explorer", result: "Found 18 relevant files across 3 routing paths" },
  });

  emit({
    type: "subagent.started",
    timestamp: new Date().toISOString(),
    seq: 0,
    sessionId,
    payload: { agentId: "architect", role: "Architect", parentAgentId: "lead", task: "Design provider routing extension" },
  });

  await sleep(delayMs);

  emit({
    type: "plan.started",
    timestamp: new Date().toISOString(),
    seq: 0,
    sessionId,
    payload: { planId: crypto.randomUUID(), turnId, title: "Implement dynamic free-model routing" },
  });

  await sleep(delayMs * 0.5);

  const planId = "plan-" + turnId.slice(0, 8);
  emit({
    type: "plan.updated",
    timestamp: new Date().toISOString(),
    seq: 0,
    sessionId,
    payload: {
      planId,
      steps: [
        { id: "s1", description: "Extend ProviderDescriptor with capability scoring", status: "completed" },
        { id: "s2", description: "Update ProviderCatalogService to expose scoring", status: "completed" },
        { id: "s3", description: "Modify ForgeRouter to use scoring pipeline", status: "active" },
        { id: "s4", description: "Add fallback routing logic", status: "queued" },
        { id: "s5", description: "Add regression tests", status: "queued" },
      ],
    },
  });

  emit({
    type: "plan.status_changed",
    timestamp: new Date().toISOString(),
    seq: 0,
    sessionId,
    payload: { planId, status: "review" },
  });

  await sleep(delayMs);

  emit({
    type: "file.change_proposed",
    timestamp: new Date().toISOString(),
    seq: 0,
    sessionId,
    payload: {
      changeId: crypto.randomUUID(),
      path: "src/ProviderDescriptor.cs",
      changeType: "modified",
      additions: 23,
      deletions: 4,
      description: "Add scoring fields to descriptor",
      diff: unifiedDiff("src/ProviderDescriptor.cs", [
        { line: 42, type: "context", text: "public class ProviderDescriptor" },
        { line: 43, type: "context", text: "{" },
        { line: 44, type: "removal", text: "    public string ProviderId { get; set; }" },
        { line: 45, type: "addition", text: "    public string ProviderId { get; set; }" },
        { line: 46, type: "addition", text: "    public int CapabilityScore { get; set; }" },
        { line: 47, type: "addition", text: "    public int ReliabilityScore { get; set; }" },
        { line: 48, type: "context", text: "    public bool IsFree { get; set; }" },
        { line: 49, type: "context", text: "}" },
      ]),
    },
  });

  emit({
    type: "file.change_applied",
    timestamp: new Date().toISOString(),
    seq: 0,
    sessionId,
    payload: { changeId: crypto.randomUUID(), path: "src/ProviderDescriptor.cs" },
  });

  await sleep(delayMs * 0.5);

  emit({
    type: "file.change_proposed",
    timestamp: new Date().toISOString(),
    seq: 0,
    sessionId,
    payload: {
      changeId: crypto.randomUUID(),
      path: "src/ForgeRouter.cs",
      changeType: "modified",
      additions: 41,
      deletions: 8,
      description: "Integrate scoring into routing",
      diff: unifiedDiff("src/ForgeRouter.cs", [
        { line: 128, type: "context", text: "public async Task<RouteResult> RouteAsync(Task task)" },
        { line: 129, type: "context", text: "{" },
        { line: 130, type: "removal", text: "    var provider = await _catalog.GetBestAsync(task);" },
        { line: 131, type: "removal", text: "    return await provider.ExecuteAsync(task);" },
        { line: 132, type: "addition", text: "    var scored = await _catalog.GetScoredAsync(task);" },
        { line: 133, type: "addition", text: "    var provider = scored.FirstOrDefault() ?? fallback;" },
        { line: 134, type: "addition", text: "    if (provider == null) throw new NoRouteException();" },
        { line: 135, type: "addition", text: "    return await provider.ExecuteAsync(task);" },
        { line: 136, type: "context", text: "}" },
      ]),
    },
  });

  emit({
    type: "file.change_applied",
    timestamp: new Date().toISOString(),
    seq: 0,
    sessionId,
    payload: { changeId: crypto.randomUUID(), path: "src/ForgeRouter.cs" },
  });

  await sleep(delayMs);

  emit({
    type: "command.started",
    timestamp: new Date().toISOString(),
    seq: 0,
    sessionId,
    payload: { commandId: crypto.randomUUID(), command: "dotnet test CodeForge.sln", workingDirectory: "E:\\CodeForge" },
  });

  await sleep(delayMs * 2);

  emit({
    type: "command.completed",
    timestamp: new Date().toISOString(),
    seq: 0,
    sessionId,
    payload: { commandId: crypto.randomUUID(), exitCode: 0, durationMs: 45200 },
  });

  emit({
    type: "validation.started",
    timestamp: new Date().toISOString(),
    seq: 0,
    sessionId,
    payload: { validationId: crypto.randomUUID(), type: "unit_tests" },
  });

  await sleep(delayMs * 1.5);

  emit({
    type: "test.started",
    timestamp: new Date().toISOString(),
    seq: 0,
    sessionId,
    payload: { taskId: turnId },
  });

  await sleep(delayMs);

  emit({
    type: "test.completed",
    timestamp: new Date().toISOString(),
    seq: 0,
    sessionId,
    payload: { taskId: turnId, passed: 411, failed: 0, skipped: 0 },
  });

  emit({
    type: "validation.completed",
    timestamp: new Date().toISOString(),
    seq: 0,
    sessionId,
    payload: { validationId: crypto.randomUUID(), passed: 411, failed: 0, skipped: 0 },
  });

  await sleep(delayMs * 0.5);

  emit({
    type: "subagent.completed",
    timestamp: new Date().toISOString(),
    seq: 0,
    sessionId,
    payload: { agentId: "architect", result: "Routing extension complete with fallback logic" },
  });

  emit({
    type: "artifact.created",
    timestamp: new Date().toISOString(),
    seq: 0,
    sessionId,
    payload: { artifactId: crypto.randomUUID(), type: "verification", title: "Verification Report", sessionId, turnId },
  });

  emit({
    type: "checkpoint.created",
    timestamp: new Date().toISOString(),
    seq: 0,
    sessionId,
    payload: { checkpointId: crypto.randomUUID(), label: "Routing complete", branch: "feature/provider-routing", fileCount: 3, testStatus: "411 passed" },
  });

  emit({
    type: "evidence.created",
    timestamp: new Date().toISOString(),
    seq: 0,
    sessionId,
    payload: {
      evidenceId: crypto.randomUUID(),
      conclusion: "ProviderCatalogService now supports capability-aware scoring via ForgeRouter.",
      references: [
        { kind: "file", ref: "src/ProviderDescriptor.cs:45" },
        { kind: "file", ref: "src/ForgeRouter.cs:128" },
        { kind: "test", ref: "tests/RouterTests.cs:78" },
        { kind: "command", ref: "dotnet test CodeForge.sln" },
      ],
    },
  });

  emit({
    type: "turn.completed",
    timestamp: new Date().toISOString(),
    seq: 0,
    sessionId,
    payload: { turnId, result: "Provider routing implemented with scoring and fallback" },
  });

  emit({
    type: "status.changed",
    timestamp: new Date().toISOString(),
    seq: 0,
    sessionId,
    payload: { from: "running", to: "completed" },
  });

  emit({
    type: "agent.completed",
    timestamp: new Date().toISOString(),
    seq: 0,
    sessionId,
    payload: { agentId: "lead", taskId: turnId },
  });
}

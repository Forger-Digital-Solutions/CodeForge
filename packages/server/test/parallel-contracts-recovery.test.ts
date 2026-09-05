import { describe, expect, it } from "vitest";
import { createSessionPersistence } from "@codeforge/sessions";
import { WorkstreamContractRegistry } from "../src/parallel-workstreams.js";
import { ParallelRunStore } from "../src/parallel-state.js";
import { createParallelAutonomousRunOrchestrator } from "../src/parallel-orchestrator.js";

describe("CF-08 public contracts and restart safety", () => {
  it("publishes only public evidence to consumers and invalidates consumers on revision drift", () => {
    const contracts = new WorkstreamContractRegistry();
    contracts.publish({ id: "user-api", producerWorkstreamId: "producer", consumerWorkstreamIds: ["consumer"], kind: "api", revision: "v1", summary: "User endpoint response", evidence: [{ kind: "file", ref: "src/user.ts", description: "public type" }] });
    expect(contracts.getForConsumer("consumer", ["user-api"])).toEqual([expect.objectContaining({ revision: "v1", summary: "User endpoint response" })]);
    expect(JSON.stringify(contracts.all())).not.toContain("CF08_CODER_A_PRIVATE_MARKER");
    contracts.publish({ id: "user-api", producerWorkstreamId: "producer", consumerWorkstreamIds: ["consumer"], kind: "api", revision: "v2", summary: "Nullable user endpoint response", evidence: [{ kind: "file", ref: "src/user.ts" }] });
    expect(contracts.getForConsumer("consumer", ["user-api"])).toBeUndefined();
    expect(contracts.get("user-api")?.staleConsumerWorkstreamIds).toEqual(["consumer"]);
  });

  it("persists stable dispatch identities and fails closed after a restart instead of dispatching a second Coder", () => {
    const persistence = createSessionPersistence();
    const now = new Date().toISOString();
    persistence.upsertSession({ id: "restart-session", title: "restart", createdAt: now, updatedAt: now, status: "running" });
    const store = new ParallelRunStore(persistence);
    store.save({ kind: "parallel_run", id: "parallel-restart", sessionId: "restart-session", workspaceId: "target", goal: "recover", status: "executing", baseRevision: "base", workstreams: [{ workstreamId: "A", status: "completed", workspaceId: "a", worktreeId: "a", baseRevision: "base", resultRevision: "a1", changedFiles: [], contractsProduced: [], review: { verdict: "pass", findings: [], summary: "pass" }, verification: [], evidence: [], findings: [] }], dispatches: [{ workstreamId: "B", dispatchId: "parallel-restart:B", workspaceId: "b", worktreeId: "b", branch: "codeforge/workstream/b", state: "active" }, { workstreamId: "C", dispatchId: "parallel-restart:C", workspaceId: "c", worktreeId: "c", branch: "codeforge/workstream/c", state: "active" }], contracts: [], createdAt: now, updatedAt: now });
    const recovered = createParallelAutonomousRunOrchestrator({ persistence, workspaceService: {} as never, agentRuntime: {} as never }).recoverRun("parallel-restart");
    expect(recovered).toMatchObject({ status: "blocked", error: "PARALLEL_RECOVERY_REVALIDATION_REQUIRED" });
    expect(recovered?.workstreams).toHaveLength(1);
    expect(recovered?.dispatches).toEqual(expect.arrayContaining([expect.objectContaining({ dispatchId: "parallel-restart:B", state: "revalidation_required" }), expect.objectContaining({ dispatchId: "parallel-restart:C", state: "revalidation_required" })]));
    expect(createParallelAutonomousRunOrchestrator({ persistence, workspaceService: {} as never, agentRuntime: {} as never }).getRun("parallel-restart")?.dispatches).toHaveLength(2);
    persistence.close();
  });
});

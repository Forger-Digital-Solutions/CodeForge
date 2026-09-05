import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ForgeZero, createGenericFreeRecord } from "@codeforge/forge-zero";
import { InMemoryProviderCatalog } from "@codeforge/providers";
import { createServer } from "../src/index.js";
import {
  Deferred, MissionProvider, SMALL_CRITERIA, SMALL_REPO, createRepo, reviewerPass, scriptFromSpec, smallMilestones,
} from "./helpers/mission-fixture.js";

const GOAL = "Implement the first and second modules";

async function request(port: number, route: string, method = "GET", body?: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`http://localhost:${port}${route}`, {
    method, headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as unknown };
}

describe("CF-09 mission HTTP surface", () => {
  let repoDir: string; let worktreeDir: string;
  let server: ReturnType<typeof createServer>; let port: number;
  let provider: MissionProvider;
  let coderGate: Deferred | undefined;
  let coderEntered: Deferred;

  beforeEach(async () => {
    repoDir = await createRepo(SMALL_REPO, "cf09-api-repo-");
    worktreeDir = await fs.mkdtemp(path.join(os.tmpdir(), "cf09-api-wt-"));
    coderEntered = new Deferred();
    const script = scriptFromSpec({ missionId: "small", goal: GOAL, criteria: SMALL_CRITERIA, plans: [{ milestones: smallMilestones() }], reviewer: () => reviewerPass() });
    provider = new MissionProvider(async (context) => {
      // Deterministic gate: the second wave's Coder parks until the test releases it.
      if (context.role === "coder" && context.all.includes('"workstream":"two-write"') && coderGate) {
        coderEntered.resolve();
        await coderGate.promise;
        coderGate = undefined;
      }
      return script(context);
    });
    const catalog = new InMemoryProviderCatalog();
    catalog.register(provider);
    const firewall = new ForgeZero();
    firewall.register(createGenericFreeRecord());
    // Construction-time injection only: a request body can never choose a provider.
    server = createServer({ port: 0, dbPath: ":memory:", providerCatalog: catalog, firewall, useRealRuntime: true, worktreeParentDir: worktreeDir });
    await server.start();
    port = (server as unknown as { httpPort: number }).httpPort;
    expect((await request(port, "/api/workspace/set", "POST", { path: repoDir })).status).toBe(200);
  });

  afterEach(async () => {
    coderGate?.resolve();
    await server.stop();
    await fs.rm(repoDir, { recursive: true, force: true });
    await fs.rm(worktreeDir, { recursive: true, force: true });
  });

  async function waitForStatus(missionId: string, statuses: string[], attempts = 600): Promise<Record<string, unknown>> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const fetched = await request(port, `/api/missions/${missionId}`);
      const mission = fetched.body as Record<string, unknown>;
      if (fetched.status === 200 && statuses.includes(String(mission.status))) return mission;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`mission never reached ${statuses.join("|")}`);
  }

  it("creates, pauses, inspects, resumes, and completes a mission over HTTP", async () => {
    coderGate = new Deferred();
    const created = await request(port, "/api/missions", "POST", { sessionId: "cf09-api", workspacePath: repoDir, goal: GOAL });
    expect(created.status).toBe(202);
    const missionId = String((created.body as { missionId: string }).missionId);

    // The second wave is genuinely in flight when the pause request arrives.
    await coderEntered.promise;
    expect((await request(port, `/api/missions/${missionId}/pause`, "POST")).body).toMatchObject({ ok: true });
    coderGate!.resolve();

    const paused = await waitForStatus(missionId, ["paused"]);
    expect(paused).toMatchObject({ kind: "mission", status: "paused", originalGoal: GOAL });
    expect((paused.milestones as Array<{ id: string; status: string }>).map((milestone) => milestone.status)).toEqual(["completed", "completed"]);

    expect((await request(port, "/api/missions?sessionId=cf09-api")).body).toHaveLength(1);

    const plan = await request(port, `/api/missions/${missionId}/plan`);
    expect(plan.status).toBe(200);
    expect(plan.body).toMatchObject({ currentPlanVersion: 1 });
    expect((plan.body as { planVersions: unknown[] }).planVersions).toHaveLength(1);

    const milestones = await request(port, `/api/missions/${missionId}/milestones`);
    expect((milestones.body as Array<{ id: string }>).map((milestone) => milestone.id)).toEqual(["s-one", "s-two"]);

    const evidence = await request(port, `/api/missions/${missionId}/evidence`);
    expect(evidence.status).toBe(200);
    const evidenceBody = evidence.body as { acceptance: Array<{ id: string; status: string }>; memory: { compactions: number } };
    expect(evidenceBody.acceptance.map((criterion) => criterion.id)).toEqual(["AC-1", "AC-2"]);
    expect(evidenceBody.memory.compactions).toBeGreaterThan(0);
    // No provider secret or private agent context is exposed on the product surface.
    expect(JSON.stringify(evidence.body)).not.toContain("apiKey");

    expect((await request(port, `/api/missions/${missionId}/resume`, "POST")).status).toBe(202);
    const completed = await waitForStatus(missionId, ["completed", "blocked", "failed"]);
    expect(completed.status).toBe("completed");
  }, 300_000);

  it("records trusted steering and cancels a running mission", async () => {
    coderGate = new Deferred();
    const created = await request(port, "/api/missions", "POST", { sessionId: "cf09-api-cancel", workspacePath: repoDir, goal: GOAL });
    const missionId = String((created.body as { missionId: string }).missionId);
    await coderEntered.promise;

    const steered = await request(port, `/api/missions/${missionId}/steer`, "POST", { type: "clarification", message: "prefer the existing helper" });
    expect(steered.status).toBe(200);
    expect(steered.body).toMatchObject({ ok: true, steering: { type: "clarification", message: "prefer the existing helper" } });
    expect((await request(port, `/api/missions/${missionId}/steer`, "POST", { type: "not_a_real_type" })).status).toBe(400);

    expect((await request(port, `/api/missions/${missionId}/cancel`, "POST")).body).toMatchObject({ ok: true });
    coderGate!.resolve();
    const cancelled = await waitForStatus(missionId, ["cancelled", "blocked", "completed"]);
    expect(cancelled.status).toBe("cancelled");
    // A cancelled mission does not resurrect.
    expect((await request(port, `/api/missions/${missionId}/resume`, "POST")).status).toBe(409);
    expect((await request(port, `/api/missions/${missionId}/cancel`, "POST")).status).toBe(409);

    expect((await request(port, "/api/missions/mission-does-not-exist")).status).toBe(404);
    expect((await request(port, "/api/missions/mission-does-not-exist/pause", "POST")).status).toBe(404);
    expect((await request(port, "/api/missions", "POST", { sessionId: "cf09-api-cancel" })).status).toBe(400);
  }, 300_000);
});

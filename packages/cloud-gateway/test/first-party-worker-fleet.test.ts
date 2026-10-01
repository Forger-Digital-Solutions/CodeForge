import { describe, expect, it } from "vitest";
import { CloudFirewallManager } from "../src/cloud-firewall.js";
import {
  FirstPartyWorkerFleet,
  QWEN_FREE_MODEL_ID,
  QWEN_MODEL_REVISION,
  QWEN_UPSTREAM_MODEL_ID,
  type FirstPartyWorkerFleetConfig,
} from "../src/first-party-worker-fleet.js";

const now = new Date("2026-10-01T12:00:00.000Z");

function config(workerIds: string[] = ["qwen-a", "qwen-b"]): FirstPartyWorkerFleetConfig {
  return {
    qualification: {
      schemaVersion: 1,
      modelId: QWEN_FREE_MODEL_ID,
      upstreamModelId: QWEN_UPSTREAM_MODEL_ID,
      modelRevision: QWEN_MODEL_REVISION,
      license: "Apache-2.0",
      commercialUseAuthorized: true,
      multiUserAuthorized: true,
      qualificationState: "QUALIFIED",
      suiteVersion: "R41_ROLE_QUALIFICATION_V3",
      completedAt: "2026-09-30T12:00:00.000Z",
      expiresAt: "2026-10-30T12:00:00.000Z",
      runtimeProfileId: "vllm-0.30-qwen3coder-fp8-v1",
      evidenceRef: "docs/evidence/r60/qualification/qwen-a.json",
      roleResults: { CODER: { status: "QUALIFIED" }, TOOL_AGENT: { status: "QUALIFIED" } },
    },
    workers: workerIds.map((workerId) => ({
      workerId,
      baseUrl: `https://${workerId}.gpu.example.test`,
      token: `synthetic-worker-token-${workerId}-with-more-than-32-bytes`,
      runtimeProfileId: "vllm-0.30-qwen3coder-fp8-v1",
    })),
  };
}

function fakeFetch(options: { holdChat?: boolean; mismatchedRevision?: boolean; failWorkerId?: string; draining?: boolean } = {}) {
  const pending: Array<() => void> = [];
  const calls: string[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/ready")) return Response.json(options.draining ? { status: "not_ready", draining: true } : { status: "ready" }, { status: options.draining ? 503 : 200 });
    if (url.endsWith("/v1/models")) {
      return Response.json({ data: [{ id: QWEN_FREE_MODEL_ID, revision: options.mismatchedRevision ? "wrong" : QWEN_MODEL_REVISION }] });
    }
    if (url.endsWith("/metrics")) {
      const workerId = new URL(url).hostname.split(".")[0];
      return Response.json({
        workerId,
        modelId: QWEN_FREE_MODEL_ID,
        modelRevision: QWEN_MODEL_REVISION,
        accelerator: "test-control-plane",
        vramMb: 0,
        activeRequests: 0,
        queueDepth: 0,
        maxConcurrentSequences: 1,
        maxBatchTokens: 4096,
        draining: options.draining === true,
      });
    }
    if (url.endsWith("/v1/chat/completions")) {
      const auth = new Headers(init?.headers).get("authorization");
      expect(auth).toMatch(/^Bearer synthetic-worker-token-/);
      if (options.failWorkerId && new URL(url).hostname.startsWith(options.failWorkerId)) {
        return Response.json({ error: { message: "controlled worker fault" } }, { status: 503 });
      }
      if (options.holdChat) await new Promise<void>((resolve) => pending.push(resolve));
      return Response.json({
        id: "chatcmpl-test",
        model: QWEN_FREE_MODEL_ID,
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    }
    throw new Error(`Unexpected worker request ${url}`);
  };
  return { fetchFn, pending, calls };
}

describe("FirstPartyWorkerFleet", () => {
  it("admits only a current authorized qualification and exact ready model revision", async () => {
    const transport = fakeFetch();
    const firewallManager = new CloudFirewallManager();
    const fleet = new FirstPartyWorkerFleet({
      firewallManager,
      config: config(["qwen-a"]),
      now: () => now,
      fetchFn: transport.fetchFn,
    });
    await fleet.start(60_000);

    expect(fleet.listWorkers()).toMatchObject([{ workerId: "qwen-a", models: [QWEN_FREE_MODEL_ID], state: "READY" }]);
    expect(fleet.availableCapacity()).toBe(1);
    expect(firewallManager.listHostedModels()).toContainEqual(expect.objectContaining({
      providerId: "codeforge-qwen-free",
      modelId: QWEN_FREE_MODEL_ID,
      accessClass: "free",
      supplyClass: "CODEFORGE_OWNED",
      isEligibleFree: true,
    }));
    fleet.stop();

    const staleTransport = fakeFetch({ mismatchedRevision: true });
    const staleFirewall = new CloudFirewallManager();
    const staleFleet = new FirstPartyWorkerFleet({ firewallManager: staleFirewall, config: config(["qwen-a"]), now: () => now, fetchFn: staleTransport.fetchFn });
    await staleFleet.start(60_000);
    expect(staleFleet.listWorkers()[0]?.state).toBe("UNAVAILABLE");
    expect(staleFirewall.listHostedModels().some((model) => model.modelId === QWEN_FREE_MODEL_ID)).toBe(false);
    staleFleet.stop();
  });

  it("schedules within reported worker sequence capacity and rejects excess concurrent work", async () => {
    const transport = fakeFetch({ holdChat: true });
    const fleet = new FirstPartyWorkerFleet({
      firewallManager: new CloudFirewallManager(),
      config: config(),
      now: () => now,
      fetchFn: transport.fetchFn,
    });
    await fleet.start(60_000);
    const request = { model: QWEN_FREE_MODEL_ID, messages: [{ role: "user" as const, content: "hi" }], maxTokens: 4 };
    const first = fleet.chat(request);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = fleet.chat(request);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(fleet.chat(request)).rejects.toMatchObject({ code: "CAPACITY_SATURATED" });
    expect(transport.calls.filter((url) => url.endsWith("/v1/chat/completions"))).toHaveLength(2);

    for (const release of transport.pending) release();
    await Promise.all([first, second]);
    fleet.stop();
  });

  it("fails over to another qualified worker after a pre-generation worker failure", async () => {
    const transport = fakeFetch({ failWorkerId: "qwen-a" });
    const fleet = new FirstPartyWorkerFleet({
      firewallManager: new CloudFirewallManager(),
      config: config(),
      now: () => now,
      fetchFn: transport.fetchFn,
    });
    await fleet.start(60_000);
    const result = await fleet.chat({ model: QWEN_FREE_MODEL_ID, messages: [{ role: "user", content: "hi" }], maxTokens: 4 });
    expect(result.choices[0]?.message.content).toBe("ok");
    expect(transport.calls.filter((url) => url.endsWith("/v1/chat/completions"))).toHaveLength(2);
    expect(fleet.listWorkers().find((worker) => worker.workerId === "qwen-a")?.state).toBe("UNAVAILABLE");
    expect(fleet.capacitySnapshot()).toEqual([{ modelId: QWEN_FREE_MODEL_ID, maxConcurrent: 1 }]);
    fleet.stop();
  });

  it("reports a draining worker as non-capacity", async () => {
    const transport = fakeFetch({ draining: true });
    const fleet = new FirstPartyWorkerFleet({
      firewallManager: new CloudFirewallManager(),
      config: config(["qwen-a"]),
      now: () => now,
      fetchFn: transport.fetchFn,
    });
    await fleet.start(60_000);
    expect(fleet.listWorkers()[0]?.state).toBe("DRAINING");
    expect(fleet.availableCapacity()).toBe(0);
    fleet.stop();
  });

  it("enforces the model manifest output and recommended input limits before worker dispatch", async () => {
    const transport = fakeFetch();
    const fleet = new FirstPartyWorkerFleet({
      firewallManager: new CloudFirewallManager(),
      config: config(["qwen-a"]),
      now: () => now,
      fetchFn: transport.fetchFn,
    });
    await fleet.start(60_000);
    await expect(fleet.chat({ model: QWEN_FREE_MODEL_ID, messages: [{ role: "user", content: "hi" }], maxTokens: 4097 })).rejects.toMatchObject({ code: "OUTPUT_LIMIT_EXCEEDED" });
    await expect(fleet.chat({ model: QWEN_FREE_MODEL_ID, messages: [{ role: "user", content: "x".repeat(80_000) }], maxTokens: 4 })).rejects.toMatchObject({ code: "CONTEXT_LENGTH" });
    expect(transport.calls.some((url) => url.endsWith("/v1/chat/completions"))).toBe(false);
    fleet.stop();
  });

  it("fails closed on an expired multi-user qualification receipt without hiding the cloud service", async () => {
    const invalid = config(["qwen-a"]);
    invalid.qualification.expiresAt = "2026-10-01T11:59:59.000Z";
    const fleet = new FirstPartyWorkerFleet({ firewallManager: new CloudFirewallManager(), config: invalid, now: () => now, fetchFn: fakeFetch().fetchFn });
    await fleet.start(60_000);
    expect(fleet.listWorkers()[0]?.error).toBe("qualification_unavailable");
    expect(fleet.availableCapacity()).toBe(0);
    fleet.stop();
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/index.js";
import { InMemoryProviderCatalog } from "@codeforge/providers";
import { createGenericFreeRecord } from "@codeforge/forge-zero";

async function request(port: number, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

async function waitFor<T>(read: () => T | Promise<T>, predicate: (value: T) => boolean, message: string): Promise<T> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

type ServerPersistence = { getWorkItems: (id: string) => Promise<Array<{ kind: string; id: string; turnId?: string; decision?: string; queuedSteers?: Array<{ steerId?: string; message?: string }>; state?: string }>>; getTurns: (id: string) => Promise<Array<{ id: string; status: string }>>; getEvents: (id: string) => Promise<Array<{ type: string; payload: { steerId?: string } }>> };

function serverPersistence(current: unknown): ServerPersistence {
  return (current as { persistence: ServerPersistence }).persistence;
}

async function waitForFile(filePath: string, message: string): Promise<void> {
  await waitFor(
    async () => access(filePath).then(() => true, () => false),
    (exists) => exists,
    message,
  );
}

describe("CF-17 runtime recovery through the production server restart path", () => {
  let server: ReturnType<typeof createServer> | undefined;
  let root: string | undefined;
  let activeCommandReleasePath: string | undefined;

  afterEach(async () => {
    if (activeCommandReleasePath) {
      await writeFile(activeCommandReleasePath, "release").catch(() => undefined);
      activeCommandReleasePath = undefined;
    }
    await server?.stop();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("hydrates an interrupted turn, preserves its queued steer once, and replans instead of replaying", async () => {
    root = await mkdtemp(join(tmpdir(), "cf17-server-restart-"));
    const dbPath = join(root, "server.db");
    const sessionId = "cf17-live-restart";
    let releaseFirstAttempt: (() => void) | undefined;
    const firstAttempt = new Promise<void>((resolve) => { releaseFirstAttempt = resolve; });
    const firstCatalog = new InMemoryProviderCatalog();
    firstCatalog.register({
      providerId: "codeforge",
      displayName: "First attempt provider",
      isTestProvider: false,
      models: () => [createGenericFreeRecord()],
      streamChat: () => (async function* () {
        yield { type: "text_delta", delta: "first attempt started" };
        await firstAttempt;
        yield { type: "finish", finishReason: "stop" as const };
      })(),
    } as never);

    server = createServer({ port: 0, dbPath, providerCatalog: firstCatalog, useRealRuntime: true } as never);
    await server.start();
    const started = await request(server.httpPort, "/api/send", { sessionId, message: "implement original behavior" });
    expect(started.status).toBe(200);
    const turnId = (started.body as { turnId: string }).turnId;
    await waitFor(
      () => (server as unknown as { runtimes: Map<string, { getTurn: (id: string) => { status: string } | undefined }> }).runtimes.get(sessionId)?.getTurn(turnId),
      (turn) => turn?.status === "running",
      "first runtime did not become active",
    );
    expect((await request(server.httpPort, "/api/send", { sessionId, message: "use revised behavior", steer: true, steerId: "restart-steer" })).status).toBe(200);
    expect((await serverPersistence(server).getWorkItems(sessionId)).find((item) => item.kind === "user_intent_hold")?.queuedSteers).toEqual([expect.objectContaining({ message: "use revised behavior" })]);

    await server.stop();
    server = undefined;

    const recoveredRequests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    const secondCatalog = new InMemoryProviderCatalog();
    secondCatalog.register({
      providerId: "codeforge",
      displayName: "Recovered attempt provider",
      isTestProvider: false,
      models: () => [createGenericFreeRecord()],
      streamChat: (request: typeof recoveredRequests[number]) => {
        recoveredRequests.push(request);
        return (async function* () {
          yield { type: "text_delta", delta: "replanned" };
          yield { type: "finish", finishReason: "stop" as const };
        })();
      },
    } as never);
    server = createServer({ port: 0, dbPath, providerCatalog: secondCatalog, useRealRuntime: true } as never);
    await server.start();
    // Hydration must make the recovered state explicit in durable storage: a turn whose
    // execution died with process A is reclassified, never left claiming to be "running".
    expect(await serverPersistence(server).getTurns(sessionId)).toEqual([expect.objectContaining({ id: turnId, status: "recovering" })]);
    const resumed = await request(server.httpPort, `/api/sessions/${sessionId}/turns/${turnId}/resume`);
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
    const snapshot = await waitFor(
      async () => (await fetch(`http://127.0.0.1:${server!.httpPort}/api/sessions/${sessionId}`)).json() as Promise<{ turns: Array<{ status: string }>; workItems: Array<{ kind: string; state?: string }> }>,
      (value) => value.turns.some((turn) => turn.status === "completed"),
      "recovered turn did not complete",
    );
    expect(snapshot.workItems.find((item) => item.kind === "agent_turn_recovery")).toMatchObject({ state: "resumed" });
    expect(recoveredRequests).toHaveLength(1);
    expect(recoveredRequests[0]!.messages.map((message) => message.content).join("\n")).toContain("Recovery directive");
    expect(recoveredRequests[0]!.messages.map((message) => message.content).join("\n")).toContain("use revised behavior");
    await server.stop();
    server = undefined;
    releaseFirstAttempt?.();
  });

  it("CF-17 active-command steering waits for a real child command boundary and consumes the steer exactly once", async () => {
    root = await mkdtemp(join(tmpdir(), "cf17-active-command-"));
    const dbPath = join(root, "server.db");
    const startedPath = join(root, "command-started");
    const releasePath = join(root, "command-release");
    activeCommandReleasePath = releasePath;
    const sessionId = "cf17-active-command";
    const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    const catalog = new InMemoryProviderCatalog();
    const commandSource = [
      `require('fs').writeFileSync(${JSON.stringify(startedPath)}, 'started')`,
      `const release=${JSON.stringify(releasePath)}`,
      "const wait=()=>require('fs').existsSync(release)?process.exit(0):setTimeout(wait,10)",
      "wait()",
    ].join(";");
    catalog.register({
      providerId: "codeforge",
      displayName: "Active command provider",
      isTestProvider: false,
      models: () => [createGenericFreeRecord()],
      streamChat: (request: typeof requests[number]) => {
        requests.push(request);
        return (async function* () {
          if (requests.length === 1) {
            yield { type: "tool_call_started", toolCallId: "active-command", toolName: "run_command" };
            yield { type: "tool_call_delta", toolCallId: "active-command", delta: JSON.stringify({ command: `node -e ${JSON.stringify(commandSource)}` }) };
            yield { type: "tool_call_completed", toolCallId: "active-command", toolName: "run_command", arguments: JSON.stringify({ command: `node -e ${JSON.stringify(commandSource)}` }) };
            yield { type: "finish", finishReason: "tool_calls" as const };
            return;
          }
          yield { type: "text_delta", delta: "steer-aware completion" };
          yield { type: "finish", finishReason: "stop" as const };
        })();
      },
    } as never);

    server = createServer({ port: 0, dbPath, providerCatalog: catalog, useRealRuntime: true } as never);
    await server.start();
    expect((await request(server.httpPort, "/api/workspace/set", { path: root })).status).toBe(200);
    const started = await request(server.httpPort, "/api/send", { sessionId, message: "Run the controlled command" });
    expect(started.status).toBe(200);
    const turnId = (started.body as { turnId: string }).turnId;
    const runtime = (server as unknown as { runtimes: Map<string, { getTurn: (id: string) => { status: string } | undefined; getPendingApproval: (id: string) => unknown }> }).runtimes.get(sessionId)!;
    const approvalId = await waitFor(
      async () => (await serverPersistence(server).getWorkItems(sessionId)).find((item) => item.kind === "approval" && item.turnId === turnId)?.id,
      (value): value is string => typeof value === "string",
      "command approval was not persisted",
    );
    expect((await request(server.httpPort, `/api/approvals/${approvalId}/resolve`, { decision: "allow_once" })).status).toBe(200);
    await waitForFile(startedPath, "controlled command did not start");
    expect(runtime.getTurn(turnId)?.status).toBe("running");

    const steered = await request(server.httpPort, "/api/send", {
      sessionId,
      message: "After the command, use the revised behavior",
      steer: true,
      steerId: "active-command-steer",
    });
    expect(steered).toMatchObject({ status: 200, body: { ok: true, steered: true, turnId } });
    const persistence = serverPersistence(server);
    expect((await persistence.getWorkItems(sessionId)).find((item) => item.kind === "user_intent_hold")?.queuedSteers).toEqual([expect.objectContaining({ steerId: "active-command-steer" })]);
    expect((await persistence.getEvents(sessionId)).filter((event) => event.type === "user_intent_steer.queued")).toHaveLength(1);

    await writeFile(releasePath, "release");
    activeCommandReleasePath = undefined;
    await waitFor(
      () => runtime.getTurn(turnId)?.status,
      (status) => status === "completed",
      "turn did not complete after the command's safe boundary",
    );
    expect(requests).toHaveLength(2);
    expect(requests[1]!.messages.map((message) => message.content).join("\n")).toContain("After the command, use the revised behavior");
    expect((await persistence.getEvents(sessionId)).filter((event) => event.type === "user_intent_steer.reconciliation_completed")).toHaveLength(1);
    expect((await persistence.getWorkItems(sessionId)).find((item) => item.kind === "user_intent_hold")?.queuedSteers).toEqual([]);

    const next = await request(server.httpPort, "/api/send", { sessionId, message: "A later unrelated turn" });
    expect(next.status).toBe(200);
    await waitFor(
      () => requests.length,
      (count) => count === 3,
      "later turn did not reach its model request",
    );
    expect(requests[2]!.messages.map((message) => message.content).join("\n")).not.toContain("After the command, use the revised behavior");
  });

  it("CF-17 approval-resolution races preserve one approval, one steer, and one guarded action in both committed orderings", async () => {
    root = await mkdtemp(join(tmpdir(), "cf17-approval-race-"));
    const dbPath = join(root, "server.db");
    const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    let approvalBoundary: (() => Promise<void>) | undefined;
    const catalog = new InMemoryProviderCatalog();
    catalog.register({
      providerId: "codeforge",
      displayName: "Approval race provider",
      isTestProvider: false,
      models: () => [createGenericFreeRecord()],
      streamChat: (request: typeof requests[number]) => {
        requests.push(request);
        return (async function* () {
          if (requests.length % 2 === 1) {
            const output = requests.length === 1 ? "race-a.txt" : "race-b.txt";
            yield { type: "tool_call_started", toolCallId: `write-${output}`, toolName: "write_file" };
            yield { type: "tool_call_delta", toolCallId: `write-${output}`, delta: JSON.stringify({ path: output, content: "guarded-once" }) };
            yield { type: "tool_call_completed", toolCallId: `write-${output}`, toolName: "write_file", arguments: JSON.stringify({ path: output, content: "guarded-once" }) };
            yield { type: "finish", finishReason: "tool_calls" as const };
            return;
          }
          yield { type: "text_delta", delta: "replanned after race" };
          yield { type: "finish", finishReason: "stop" as const };
        })();
      },
    } as never);
    server = createServer({
      port: 0,
      dbPath,
      providerCatalog: catalog,
      useRealRuntime: true,
      afterApprovalResolvedBoundary: () => approvalBoundary?.() ?? Promise.resolve(),
    } as never);
    await server.start();
    expect((await request(server.httpPort, "/api/workspace/set", { path: root })).status).toBe(200);
    const persistence = serverPersistence(server);
    const runtimeFor = (sessionId: string) => (server as unknown as { runtimes: Map<string, { getTurn: (id: string) => { status: string } | undefined }> }).runtimes.get(sessionId)!;

    const runRace = async (sessionId: string, ordering: "steer_then_approval" | "concurrent") => {
      const started = await request(server!.httpPort, "/api/send", { sessionId, message: `Start ${ordering}` });
      expect(started.status).toBe(200);
      const turnId = (started.body as { turnId: string }).turnId;
      const approvalId = await waitFor(
        async () => (await persistence.getWorkItems(sessionId)).find((item) => item.kind === "approval" && item.turnId === turnId)?.id,
        (value): value is string => typeof value === "string",
        `${ordering} approval was not persisted`,
      );
      const steer = () => request(server!.httpPort, "/api/send", { sessionId, message: `steer-${ordering}`, steer: true, steerId: `steer-${ordering}` });
      const resolve = () => request(server!.httpPort, `/api/approvals/${approvalId}/resolve`, { decision: "allow_once" });
      if (ordering === "steer_then_approval") {
        expect((await steer()).status).toBe(200);
        expect((await resolve()).status).toBe(200);
      } else {
        let enteredBoundary: (() => void) | undefined;
        const entered = new Promise<void>((resolveBoundary) => { enteredBoundary = resolveBoundary; });
        let releaseBoundary: (() => void) | undefined;
        approvalBoundary = () => {
          enteredBoundary?.();
          return new Promise<void>((resolveBoundary) => { releaseBoundary = resolveBoundary; });
        };
        const resolvedPromise = resolve();
        await entered;
        const steered = await steer();
        releaseBoundary?.();
        const resolved = await resolvedPromise;
        approvalBoundary = undefined;
        expect(resolved.status).toBe(200);
        expect(steered.status).toBe(200);
      }
      await waitFor(() => runtimeFor(sessionId).getTurn(turnId)?.status, (status) => status === "completed", `${ordering} turn did not settle`);
      const items = await persistence.getWorkItems(sessionId);
      expect(items.filter((item) => item.kind === "approval" && item.id === approvalId)).toEqual([expect.objectContaining({ decision: "allow_once" })]);
      expect((await persistence.getEvents(sessionId)).filter((event) => event.type === "approval.resolved")).toHaveLength(1);
      expect((await persistence.getEvents(sessionId)).filter((event) => event.type === "user_intent_steer.queued" && event.payload.steerId === `steer-${ordering}`)).toHaveLength(1);
      expect(items.find((item) => item.kind === "user_intent_hold")?.queuedSteers).toEqual([]);
      return turnId;
    };

    await runRace("cf17-race-a", "steer_then_approval");
    await runRace("cf17-race-b", "concurrent");
    expect(await access(join(root, "race-a.txt")).then(() => true, () => false)).toBe(true);
    expect(await access(join(root, "race-b.txt")).then(() => true, () => false)).toBe(true);
    expect(requests).toHaveLength(4);
    expect(requests[1]!.messages.map((message) => message.content).join("\n")).toContain("steer-steer_then_approval");
    expect(requests[3]!.messages.map((message) => message.content).join("\n")).toContain("steer-concurrent");
  });
});

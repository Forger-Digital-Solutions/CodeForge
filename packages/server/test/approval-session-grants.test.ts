import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/index.js";
import { createGenericFreeRecord } from "@codeforge/forge-zero";
import { InMemoryProviderCatalog } from "@codeforge/providers";

/**
 * Task-scoped grants on the session lease. "Allow for this task" must mean what it
 * says: a matching later operation inside the same task runs without asking again —
 * on the one boundary where the user must be able to trust the UI. Grants are
 * task-scoped per session lease and never cover Tier 3/4 boundaries (external,
 * sensitive, destructive), which re-confirm per invocation by design.
 */
async function fetchJson(url: string, body?: unknown, method = "POST"): Promise<{ status: number; body: any }> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** A provider that writes `count` files across successive tool iterations, one call per stream. */
function writingProvider(count: number) {
  let iteration = 0;
  return {
    providerId: "codeforge",
    displayName: "Mock Provider",
    // Scripted adapter: bypasses the process-global capacity governor so tests in this
    // file do not contend for the shared 60s token window.
    isTestProvider: true,
    models: () => [createGenericFreeRecord()],
    streamChat: () => (async function* () {
      iteration += 1;
      if (iteration <= count) {
        const name = `file-${iteration}.txt`;
        const tool = iteration % 2 === 1 ? "write_file" : "edit_file";
        const args = tool === "write_file"
          ? { path: name, content: `content ${iteration}` }
          : { path: `file-${iteration - 1}.txt`, oldText: `content ${iteration - 1}`, newText: `edited ${iteration}` };
        yield { type: "tool_call_started", toolCallId: `tc-${iteration}`, toolName: tool };
        yield { type: "tool_call_completed", toolCallId: `tc-${iteration}`, toolName: tool, arguments: JSON.stringify(args) };
        yield { type: "finish", finishReason: "tool_calls" as const };
        return;
      }
      yield { type: "text_delta", delta: "Done." };
      yield { type: "finish", finishReason: "stop" as const };
    })(),
  } as any;
}

/** A provider that runs each command in `commands` as one run_command call per iteration. */
function commandProvider(commands: string[]) {
  let iteration = 0;
  return {
    providerId: "codeforge",
    displayName: "Mock Provider",
    isTestProvider: true,
    models: () => [createGenericFreeRecord()],
    streamChat: () => (async function* () {
      iteration += 1;
      if (iteration <= commands.length) {
        const args = { command: commands[iteration - 1] };
        yield { type: "tool_call_started", toolCallId: `tc-${iteration}`, toolName: "run_command" };
        yield { type: "tool_call_completed", toolCallId: `tc-${iteration}`, toolName: "run_command", arguments: JSON.stringify(args) };
        yield { type: "finish", finishReason: "tool_calls" as const };
        return;
      }
      yield { type: "text_delta", delta: "Done." };
      yield { type: "finish", finishReason: "stop" as const };
    })(),
  } as any;
}

describe("task grants on the session lease", () => {
  let ws: string;
  let server: any;
  let port: number;
  let catalog: InMemoryProviderCatalog;

  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), "cf-approval-grant-"));
    catalog = new InMemoryProviderCatalog();
  });

  afterEach(async () => {
    if (server) await server.stop();
    await rm(ws, { recursive: true, force: true });
  });

  async function waitFor(check: () => boolean, ms = 10_000, sessionId?: string): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (check()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const seen = sessionId ? JSON.stringify(events(sessionId).map((e) => e.type)) : "";
    throw new Error(`condition not met in time ${seen}`);
  }

  const events = (sessionId: string) => (server as any).eventStore.getBySession(sessionId) as Array<{ type: string; payload: any }>;
  const approvals = (sessionId: string) => events(sessionId).filter((event) => event.type === "approval.requested");

  it("routine workspace writes and edits never prompt under Auto Review", async () => {
    catalog.register(writingProvider(3));
    server = createServer({ port: 0, dbPath: ":memory:", providerCatalog: catalog, useRealRuntime: true } as any);
    await server.start();
    port = server.httpPort;
    server.setWorkspace(ws);

    const started = await fetchJson(`http://localhost:${port}/api/send`, { sessionId: "routine", message: "Write some files" });
    expect(started.status).toBe(200);
    await waitFor(() => events("routine").some((event) => event.type === "turn.completed" || event.type === "turn.failed"), 10_000);

    // The whole point of the campaign: doing the job is not a permission boundary.
    expect(approvals("routine")).toHaveLength(0);
    expect(events("routine").some((event) => event.type === "turn.completed")).toBe(true);
    expect(events("routine").filter((event) => event.type === "file.written")).toHaveLength(3);
    expect(await readFile(join(ws, "file-1.txt"), "utf8")).toBe("edited 2");
    expect(await readFile(join(ws, "file-3.txt"), "utf8")).toBe("content 3");
  });

  it("asks once for a project-modifying command, then honors Allow for task on a repeat", async () => {
    const cmd = "node -e \"console.log(1)\"";
    catalog.register(commandProvider([cmd, cmd]));
    server = createServer({ port: 0, dbPath: ":memory:", providerCatalog: catalog, useRealRuntime: true } as any);
    await server.start();
    port = server.httpPort;
    server.setWorkspace(ws);

    await fetchJson(`http://localhost:${port}/api/send`, { sessionId: "grant", message: "Run the script twice" });
    await waitFor(() => approvals("grant").length === 1);

    const first = approvals("grant")[0]!.payload;
    expect(first.description).toContain("node -e");
    expect(first.risk).toBe("moderate");

    const runtime = (server as any).runtimes.get("grant");
    await runtime.resolveApproval(first.approvalId, "allow_session");

    await waitFor(() => events("grant").some((event) => event.type === "turn.completed" || event.type === "turn.failed"), 10_000);
    expect(events("grant").some((event) => event.type === "turn.completed")).toBe(true);
    // The repeat matched the command-prefix grant — no second card.
    expect(approvals("grant")).toHaveLength(1);
  });

  it("Allow Once keeps asking for each Tier-2 command, even an identical repeat", async () => {
    const cmd = "node -e \"console.log(1)\"";
    catalog.register(commandProvider([cmd, cmd]));
    server = createServer({ port: 0, dbPath: ":memory:", providerCatalog: catalog, useRealRuntime: true } as any);
    await server.start();
    port = server.httpPort;
    server.setWorkspace(ws);

    await fetchJson(`http://localhost:${port}/api/send`, { sessionId: "once", message: "Run the script twice" });
    await waitFor(() => approvals("once").length === 1);
    const runtime = (server as any).runtimes.get("once");
    await runtime.resolveApproval(approvals("once")[0]!.payload.approvalId, "allow_once");

    await waitFor(() => approvals("once").length === 2);
    expect(approvals("once")[1]!.payload.description).toContain("node -e");
    await runtime.resolveApproval(approvals("once")[1]!.payload.approvalId, "allow_once");
    await waitFor(() => events("once").some((event) => event.type === "turn.completed"), 10_000);
  });

  it("does not let a task grant survive into another session's lease", async () => {
    const cmd = "node -e \"console.log(1)\"";
    catalog.register(commandProvider([cmd]));
    server = createServer({ port: 0, dbPath: ":memory:", providerCatalog: catalog, useRealRuntime: true } as any);
    await server.start();
    port = server.httpPort;
    server.setWorkspace(ws);

    await fetchJson(`http://localhost:${port}/api/send`, { sessionId: "a", message: "Run the script" });
    await waitFor(() => approvals("a").length === 1);
    await (server as any).runtimes.get("a").resolveApproval(approvals("a")[0]!.payload.approvalId, "allow_session");
    await waitFor(() => events("a").some((event) => event.type === "turn.completed"), 10_000);

    catalog.register(commandProvider([cmd]));
    await fetchJson(`http://localhost:${port}/api/send`, { sessionId: "b", message: "Run the script" });
    await waitFor(() => approvals("b").length === 1);
    await (server as any).runtimes.get("b").resolveApproval(approvals("b")[0]!.payload.approvalId, "deny");
  });

  it("destructive commands always ask and Allow for task cannot mint a grant for them", async () => {
    catalog.register(commandProvider(["rm -rf node_modules", "rm -rf dist"]));
    server = createServer({ port: 0, dbPath: ":memory:", providerCatalog: catalog, useRealRuntime: true } as any);
    await server.start();
    port = server.httpPort;
    server.setWorkspace(ws);

    const send = await fetchJson(`http://localhost:${port}/api/send`, { sessionId: "crit", message: "Clean the build dirs" });
    expect(send.status).toBe(200);
    await waitFor(() => approvals("crit").length === 1, 20_000, "crit");
    expect(approvals("crit")[0]!.payload.risk).toBe("critical");

    const runtime = (server as any).runtimes.get("crit");
    await runtime.resolveApproval(approvals("crit")[0]!.payload.approvalId, "allow_session");

    // Tier 4 re-confirms per invocation: the second destructive command still asks.
    await waitFor(() => approvals("crit").length === 2, 20_000);
    await runtime.resolveApproval(approvals("crit")[1]!.payload.approvalId, "deny");
  });
});

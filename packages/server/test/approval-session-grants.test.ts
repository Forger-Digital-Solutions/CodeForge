import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/index.js";
import { createGenericFreeRecord } from "@codeforge/forge-zero";
import { InMemoryProviderCatalog } from "@codeforge/providers";

/**
 * "Allow for Session" must mean what it says. Before this, the decision was accepted and then
 * forgotten: every later file write asked again, so the button behaved exactly like "Allow Once"
 * — a control that does not do what it claims, on the one boundary where the user must be able to
 * trust the UI. Session grants are in-memory, per session runtime, and never cover high or
 * critical risk (those always ask).
 */
async function fetchJson(url: string, body?: unknown, method = "POST"): Promise<{ status: number; body: any }> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** A provider that writes `count` files across successive tool iterations, one call per stream. */
function writingProvider(count: number) {
  let iteration = 0;
  return {
    providerId: "codeforge",
    displayName: "Mock Provider",
    isTestProvider: false,
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

describe("approval session grants", () => {
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

  async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (check()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("condition not met in time");
  }

  const events = (sessionId: string) => (server as any).eventStore.getBySession(sessionId) as Array<{ type: string; payload: any }>;
  const approvals = (sessionId: string) => events(sessionId).filter((event) => event.type === "approval.requested");

  it("asks once, then honors Allow for Session for later writes and edits of the same risk", async () => {
    catalog.register(writingProvider(3));
    server = createServer({ port: 0, dbPath: ":memory:", providerCatalog: catalog, useRealRuntime: true } as any);
    await server.start();
    port = server.httpPort;
    server.setWorkspace(ws);

    const started = await fetchJson(`http://localhost:${port}/api/send`, { sessionId: "grant", message: "Write some files" });
    expect(started.status).toBe(200);
    await waitFor(() => approvals("grant").length === 1);

    const first = approvals("grant")[0]!.payload;
    // The prompt names the file, so the decision is about something the user can see.
    expect(first.description).toBe("write_file: write file-1.txt");
    expect(first.risk).toBe("moderate");

    const runtime = (server as any).runtimes.get("grant");
    await runtime.resolveApproval(first.approvalId, "allow_session");

    await waitFor(() => events("grant").some((event) => event.type === "turn.completed" || event.type === "turn.failed"), 10_000);
    expect(events("grant").some((event) => event.type === "turn.completed")).toBe(true);
    // Two more mutations happened (an edit_file and a write_file) without asking again.
    expect(approvals("grant")).toHaveLength(1);
    expect(events("grant").filter((event) => event.type === "file.written")).toHaveLength(3);
    expect(await readFile(join(ws, "file-1.txt"), "utf8")).toBe("edited 2");
    expect(await readFile(join(ws, "file-3.txt"), "utf8")).toBe("content 3");
  });

  it("Allow Once keeps asking for every mutation", async () => {
    catalog.register(writingProvider(2));
    server = createServer({ port: 0, dbPath: ":memory:", providerCatalog: catalog, useRealRuntime: true } as any);
    await server.start();
    port = server.httpPort;
    server.setWorkspace(ws);

    await fetchJson(`http://localhost:${port}/api/send`, { sessionId: "once", message: "Write some files" });
    await waitFor(() => approvals("once").length === 1);
    const runtime = (server as any).runtimes.get("once");
    await runtime.resolveApproval(approvals("once")[0]!.payload.approvalId, "allow_once");

    await waitFor(() => approvals("once").length === 2);
    expect(approvals("once")[1]!.payload.description).toBe("edit_file: edit file-1.txt");
    await runtime.resolveApproval(approvals("once")[1]!.payload.approvalId, "allow_once");
    await waitFor(() => events("once").some((event) => event.type === "turn.completed"), 10_000);
  });

  it("does not let a session grant survive into another session's runtime", async () => {
    catalog.register(writingProvider(1));
    server = createServer({ port: 0, dbPath: ":memory:", providerCatalog: catalog, useRealRuntime: true } as any);
    await server.start();
    port = server.httpPort;
    server.setWorkspace(ws);

    await fetchJson(`http://localhost:${port}/api/send`, { sessionId: "a", message: "Write a file" });
    await waitFor(() => approvals("a").length === 1);
    await (server as any).runtimes.get("a").resolveApproval(approvals("a")[0]!.payload.approvalId, "allow_session");
    await waitFor(() => events("a").some((event) => event.type === "turn.completed"), 10_000);

    catalog.register(writingProvider(1));
    await fetchJson(`http://localhost:${port}/api/send`, { sessionId: "b", message: "Write a file" });
    await waitFor(() => approvals("b").length === 1);
    await (server as any).runtimes.get("b").resolveApproval(approvals("b")[0]!.payload.approvalId, "deny");
  });
});

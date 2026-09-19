import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryProviderCatalog, createMockProvider } from "@codeforge/providers";
import { CodeForgeServer } from "../src/index.js";

process.env.CODEFORGE_REAL_RUNTIME = "true";

/**
 * Task identity: the sidebar title is the user's first request, forever. A repair/steer/continue
 * message ("Review the failure, fix the underlying issue…") is an instruction to the model, not a
 * new task name — it must never rename the conversation.
 */
describe("task identity stability", () => {
  let root = "";
  let server: CodeForgeServer;
  let base = "";

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "cf-task-identity-"));
    const providerCatalog = new InMemoryProviderCatalog();
    providerCatalog.register(createMockProvider({ providerId: "codeforge" }));
    server = new CodeForgeServer({ port: 0, dbPath: join(root, "sessions.db"), providerCatalog });
    await server.start();
    server.setWorkspace(root);
    base = `http://127.0.0.1:${server.httpPort}`;
  });

  afterAll(async () => {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  });

  const send = (body: unknown) =>
    fetch(`${base}/api/send`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const session = async (id: string) =>
    ((await (await fetch(`${base}/api/sessions/${id}`)).json()) as { session: { title: string; taskTitle?: string; createdAt: string; workspacePath?: string } }).session;

  it("a repair continuation never renames the original task", async () => {
    const first = await send({ sessionId: "identity-1", message: "Fix the login bug in auth.ts", executionMode: "chat" });
    expect(first.status).toBe(200);
    const afterFirst = await session("identity-1");
    expect(afterFirst.title).toBe("Fix the login bug in auth.ts");
    const createdAt = afterFirst.createdAt;

    // Repair/steer continuations inject a model-facing instruction — not a user title.
    const repair = await send({ sessionId: "identity-1", message: "Review the failure, fix the underlying issue, and rerun the relevant verification.", executionMode: "chat" });
    expect(repair.status).toBe(200);
    const afterRepair = await session("identity-1");
    expect(afterRepair.title).toBe("Fix the login bug in auth.ts");
    expect(afterRepair.createdAt).toBe(createdAt);

    // Same for an arbitrary steer/continue message.
    await send({ sessionId: "identity-1", message: "keep going", executionMode: "chat" });
    const afterSteer = await session("identity-1");
    expect(afterSteer.title).toBe("Fix the login bug in auth.ts");
  });
});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryProviderCatalog, createMockProvider } from "@codeforge/providers";
import { createSessionPersistence } from "@codeforge/sessions";
import { CodeForgeServer, sameWorkspacePath } from "../src/index.js";

process.env.CODEFORGE_REAL_RUNTIME = "true";

/**
 * R16 §33/§77: a conversation belongs to the repository it started in. The sidebar can still show a
 * task from another project, and the send path used to run that task against whichever workspace
 * happened to be active. The trusted runtime now refuses the mismatch instead of redirecting it.
 */
describe("workspace binding guard", () => {
  let root = "";
  let repoA = "";
  let repoB = "";
  let base = "";
  let dbPath = "";
  let server: CodeForgeServer;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "cf-ws-guard-"));
    repoA = join(root, "repo-a");
    repoB = join(root, "repo-b");
    await mkdir(repoA);
    await mkdir(repoB);
    dbPath = join(root, "sessions.db");
    // Seed a conversation that is bound to repo B before the server opens repo A.
    const persistence = createSessionPersistence({ dbPath });
    await persistence.init();
    const now = new Date().toISOString();
    await persistence.upsertSession({ id: "bound-to-b", title: "Refactor B", createdAt: now, updatedAt: now, status: "completed", workspacePath: repoB });
    await persistence.upsertSession({ id: "legacy-unbound", title: "Old task", createdAt: now, updatedAt: now, status: "completed" });
    await persistence.close();

    const providerCatalog = new InMemoryProviderCatalog();
    providerCatalog.register(createMockProvider({ providerId: "codeforge" }));
    server = new CodeForgeServer({ port: 0, dbPath, providerCatalog });
    await server.start();
    server.setWorkspace(repoA);
    base = `http://127.0.0.1:${server.httpPort}`;
  });

  afterAll(async () => {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  });

  const send = (body: unknown) => fetch(`${base}/api/send`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  it("refuses to continue a conversation bound to another repository", async () => {
    const res = await send({ sessionId: "bound-to-b", message: "continue please", executionMode: "chat" });
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: string; message: string; sessionWorkspace: string };
    expect(json.error).toBe("WORKSPACE_MISMATCH");
    expect(json.message).toContain('"repo-b"');
    expect(json.sessionWorkspace).toBe(repoB);
    // The refusal must not have mutated the session into a running state.
    const snapshot = (await (await fetch(`${base}/api/sessions/bound-to-b`)).json()) as { session: { status: string; workspacePath?: string } };
    expect(snapshot.session.status).toBe("completed");
    expect(snapshot.session.workspacePath).toBe(repoB);
  });

  it("refuses the workflow entry point the same way", async () => {
    const res = await fetch(`${base}/api/workflow/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: "bound-to-b", message: "fix it" }) });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("WORKSPACE_MISMATCH");
  });

  it("binds a legacy unbound conversation to the active repository on its next message", async () => {
    const res = await send({ sessionId: "legacy-unbound", message: "hello", executionMode: "chat" });
    expect(res.status).toBe(200);
    const snapshot = (await (await fetch(`${base}/api/sessions/legacy-unbound`)).json()) as { session: { workspacePath?: string } };
    expect(snapshot.session.workspacePath && sameWorkspacePath(snapshot.session.workspacePath, repoA)).toBe(true);
  });

  it("compares repository paths by identity, not spelling", () => {
    expect(sameWorkspacePath(repoA, `${repoA}${process.platform === "win32" ? "\\" : "/"}`)).toBe(true);
    if (process.platform === "win32") expect(sameWorkspacePath(repoA.toUpperCase(), repoA.toLowerCase())).toBe(true);
    expect(sameWorkspacePath(repoA, repoB)).toBe(false);
  });
});

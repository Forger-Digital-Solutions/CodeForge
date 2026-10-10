import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryProviderCatalog, createMockProvider } from "@codeforge/providers";
import { createSessionPersistence } from "@codeforge/sessions";
import { CodeForgeServer } from "../src/index.js";

describe("workspace inference consent at server entry points", () => {
  let root: string;
  let privateRepository: string;
  let server: CodeForgeServer;
  let base: string;
  let inferenceCalls = 0;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "cf-inference-consent-"));
    const publicRepository = join(root, "consented-public");
    privateRepository = join(root, "unconsented-private");
    await mkdir(publicRepository);
    await mkdir(privateRepository);
    const dbPath = join(root, "sessions.db");
    const persistence = createSessionPersistence({ dbPath });
    await persistence.init();
    const at = new Date().toISOString();
    await persistence.upsertSession({ id: "unconsented-task", title: "Existing private task", createdAt: at, updatedAt: at, status: "completed", workspacePath: privateRepository });
    await persistence.close();
    const catalog = new InMemoryProviderCatalog();
    const provider = createMockProvider({ providerId: "codeforge" });
    const original = provider.streamChat.bind(provider);
    provider.streamChat = (...args) => {
      inferenceCalls += 1;
      return original(...args);
    };
    catalog.register(provider);
    server = new CodeForgeServer({ port: 0, dbPath, providerCatalog: catalog,
      freeDataContext: () => ({ dataClass: "PUBLIC_CODE", userConsented: true }) });
    await server.start();
    server.setWorkspace(publicRepository);
    base = `http://127.0.0.1:${server.httpPort}`;
  });

  afterAll(async () => {
    await server?.stop();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it.each(["/api/workflow/run", "/api/orchestrator/run", "/api/missions", "/api/parallel-runs"])(
    "rejects a different request workspace at %s before inference", async (endpoint) => {
      const response = await fetch(`${base}${endpoint}`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "unconsented-task", goal: "Inspect this repository", message: "Inspect this repository", workspacePath: privateRepository }) });
      expect(response.ok).toBe(false);
      expect(JSON.stringify(await response.json())).toContain("WORKSPACE_MISMATCH");
      expect(inferenceCalls).toBe(0);
      const snapshot = await (await fetch(`${base}/api/sessions/unconsented-task`)).json() as { session: { status: string; workspacePath: string } };
      expect(snapshot.session.status).toBe("completed");
      expect(snapshot.session.workspacePath).toBe(privateRepository);
    },
  );
});

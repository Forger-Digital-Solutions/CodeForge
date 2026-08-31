import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/index.js";

async function request(port: number, route: string, method = "GET", body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`http://localhost:${port}${route}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

describe("repository index API", () => {
  let root: string;
  let server: ReturnType<typeof createServer>;
  let port: number;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "codeforge-repository-api-"));
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "service.ts"), "export function apiNeedle(): boolean { return true; }\n");
    server = createServer({ port: 0, dbPath: ":memory:" });
    await server.start();
    port = (server as unknown as { httpPort: number }).httpPort;
    expect((await request(port, "/api/workspace/set", "POST", { path: root })).status).toBe(200);
  });

  afterEach(async () => {
    await server.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function waitForReady(): Promise<Record<string, unknown>> {
    let last: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 100; attempt++) {
      const status = await request(port, "/api/repository-index/status");
      last = status.body;
      if (["READY", "DEGRADED"].includes(String(status.body.state))) return status.body;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Repository index did not become ready: ${JSON.stringify(last)}`);
  }

  it("reports local status, searches, rebuilds, and honors enable/disable control", async () => {
    const ready = await waitForReady();
    expect(ready.local).toBe(true);
    expect(ready.enabled).toBe(true);
    expect((await request(port, "/api/repository-index/search?q=apiNeedle")).body.items).toEqual(expect.arrayContaining([expect.objectContaining({ path: "src/service.ts" })]));

    const disabled = await request(port, "/api/repository-index/settings", "POST", { enabled: false });
    expect(disabled).toEqual({ status: 200, body: { enabled: false } });
    expect((await request(port, "/api/repository-index/status")).body).toEqual(expect.objectContaining({ state: "NOT_INDEXED", enabled: false }));
    expect((await request(port, "/api/repository-index/rebuild", "POST")).status).toBe(409);

    expect((await request(port, "/api/repository-index/settings", "POST", { enabled: true })).status).toBe(200);
    await waitForReady();
    expect((await request(port, "/api/repository-index/rebuild", "POST")).status).toBe(202);
    await waitForReady();
  });
});

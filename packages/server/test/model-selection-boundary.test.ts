import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryProviderCatalog, createMockProvider } from "@codeforge/providers";
import { CodeForgeServer } from "../src/index.js";

// Exercise the real AgentRuntime turn path (not demo mode).
process.env.CODEFORGE_REAL_RUNTIME = "true";

interface SelectionResponse {
  ok?: boolean;
  selection?: { providerId?: string; modelId?: string; tier?: string };
  error?: string;
  message?: string;
}

interface TurnView {
  id: string;
  status: string;
  error: string | null;
}

interface SessionSnapshot {
  session: { currentModelId?: string | null } | null;
  turns: TurnView[];
}

const providerCatalog = new InMemoryProviderCatalog();
providerCatalog.register(createMockProvider({ providerId: "codeforge" }));

let base = "";
let cleanupDir = "";
let server: CodeForgeServer;

beforeAll(async () => {
  cleanupDir = await mkdtemp(join(tmpdir(), "cf-model-boundary-"));
  server = new CodeForgeServer({
    port: 0,
    dbPath: join(cleanupDir, "boundary.db"),
    providerCatalog,
  });
  await server.start();
  base = `http://127.0.0.1:${server.httpPort}`;
});

afterAll(async () => {
  await server.stop();
  await rm(cleanupDir, { recursive: true, force: true });
});

async function postJSON(
  pathname: string,
  body: unknown,
): Promise<{ status: number; json: SelectionResponse }> {
  const res = await fetch(`${base}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as SelectionResponse };
}

async function sendTurn(sessionId: string, message: string, userId?: string): Promise<string> {
  const body = userId ? { sessionId, message, userId } : { sessionId, message };
  const res = await postJSON("/api/send", body);
  expect(res.status, `/api/send failed: ${JSON.stringify(res.json)}`).toBe(200);
  const turnId = (res.json as { ok?: boolean; turnId?: string }).turnId;
  expect(typeof turnId).toBe("string");
  return turnId as string;
}

async function settledTurn(sessionId: string, turnId: string): Promise<TurnView> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const res = await fetch(`${base}/api/sessions/${sessionId}`);
    if (res.ok) {
      const snap = (await res.json()) as SessionSnapshot;
      const turn = snap.turns.find((t) => t.id === turnId);
      if (turn && (turn.status === "completed" || turn.status === "failed")) {
        return turn;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`turn ${turnId} did not settle`);
}

async function currentModelOf(sessionId: string): Promise<string | null> {
  const res = await fetch(`${base}/api/sessions/${sessionId}`);
  expect(res.ok).toBe(true);
  const snap = (await res.json()) as SessionSnapshot;
  return snap.session?.currentModelId ?? null;
}

describe("HTTP model-selection boundary", () => {
  it("missing model selection auto-routes to the verified free model", async () => {
    const sessionId = "boundary-auto";
    const turnId = await sendTurn(sessionId, "auto routing");
    const turn = await settledTurn(sessionId, turnId);
    expect(turn.status).toBe("completed");
    expect(await currentModelOf(sessionId)).toBe("free-model-1");
  });

  it("valid free selection over HTTP reaches AgentRuntime.setModelSelection", async () => {
    const sessionId = "boundary-free";
    const sel = await postJSON("/api/model-selection", {
      sessionId,
      providerId: "codeforge",
      modelId: "free-model-1",
    });
    expect(sel.status).toBe(200);
    expect(sel.json.selection?.modelId).toBe("free-model-1");

    const turnId = await sendTurn(sessionId, "use free");
    const turn = await settledTurn(sessionId, turnId);
    expect(turn.status).toBe("completed");
    expect(await currentModelOf(sessionId)).toBe("free-model-1");
  });

  it("valid paid selection for entitled user executes the GEMS model", async () => {
    const sessionId = "boundary-paid";
    const sel = await postJSON("/api/model-selection", {
      sessionId,
      providerId: "codeforge",
      modelId: "topaz",
      userId: "paid-user",
    });
    expect(sel.status).toBe(200);
    expect(sel.json.selection?.tier).toBe("gems_paid");

    const turnId = await sendTurn(sessionId, "paid run", "paid-user");
    const turn = await settledTurn(sessionId, turnId);
    expect(turn.status).toBe("completed");
    // Auto-routing can never pick gems_paid models; reaching topaz proves the
    // HTTP request flowed into setModelSelection() and resolveTurnModel().
    expect(await currentModelOf(sessionId)).toBe("topaz");
  });

  it("locked paid model never executes for non-entitled user (fail closed)", async () => {
    const sessionId = "boundary-denied";
    const sel = await postJSON("/api/model-selection", {
      sessionId,
      providerId: "codeforge",
      modelId: "topaz",
    });
    expect(sel.status).toBe(200);

    const turnId = await sendTurn(sessionId, "anonymous attempt");
    const turn = await settledTurn(sessionId, turnId);
    // The entitlement error is thrown by executeTurn BEFORE any provider
    // execution, so a locked paid id sent by a client cannot run inference.
    expect(turn.status).toBe("failed");
    expect(turn.error).toContain("REQUIRES_SUBSCRIPTION");
  });

  it("invalid model id fails closed at the HTTP boundary", async () => {
    const sessionId = "boundary-invalid";
    const sel = await postJSON("/api/model-selection", {
      sessionId,
      providerId: "codeforge",
      modelId: "does-not-exist",
    });
    expect(sel.status).toBe(400);
    expect(sel.json.error).toBe("MODEL_NOT_FOUND");

    // The rejected selection must be ignored, not stored.
    const turnId = await sendTurn(sessionId, "still works");
    const turn = await settledTurn(sessionId, turnId);
    expect(turn.status).toBe("completed");
    expect(await currentModelOf(sessionId)).toBe("free-model-1");
  });

  it("malformed selection payload fails closed", async () => {
    const sel = await postJSON("/api/model-selection", {
      sessionId: "boundary-malformed",
      modelId: 123,
      providerId: 456,
    });
    expect(sel.status).toBe(400);
    expect(sel.json.error).toBe("MODEL_SELECTION_INVALID");
  });

  it("auto selection clears a previous manual selection", async () => {
    const sessionId = "boundary-back-to-auto";
    const paid = await postJSON("/api/model-selection", {
      sessionId,
      providerId: "codeforge",
      modelId: "sapphire",
      userId: "paid-user",
    });
    expect(paid.status).toBe(200);

    const auto = await postJSON("/api/model-selection", { sessionId, modelId: "auto" });
    expect(auto.status).toBe(200);

    const turnId = await sendTurn(sessionId, "back to auto", "paid-user");
    const turn = await settledTurn(sessionId, turnId);
    expect(turn.status).toBe("completed");
    expect(await currentModelOf(sessionId)).toBe("free-model-1");
  });
});

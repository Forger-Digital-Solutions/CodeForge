#!/usr/bin/env node
// Full-server free-inference E2E — the SAME path the desktop embeds:
//   real OpenRouter adapter → discovery/verify → ForgeZero → CodeForgeServer(useRealRuntime)
//     → POST /api/send → AgentRuntime real streamChat → assistant.message.* events (persisted)
//
// Reads OPENROUTER_API_KEY from env only (never logged). Uses $0 verified-free models. Proves:
//   - real free inference through the server (mode:"real")
//   - assistant prose streams AND persists (assistant.message.completed in /api/sessions/:id/events)
//   - session isolation filter (/api/events?sessionId=)
import os from "node:os";
import path from "node:path";
import { InMemoryProviderCatalog, createOpenRouterAdapter } from "@codeforge/providers";
import { NormalizedModelRegistry, discoverAndVerifyFree } from "@codeforge/model-registry";
import { ForgeZero } from "@codeforge/forge-zero";
import { CodeForgeServer } from "@codeforge/server";

const key = process.env.OPENROUTER_API_KEY;
if (!key) { console.error("OPENROUTER_API_KEY not set — skipping"); process.exit(2); }

const PORT = 3399;
const BASE = `http://localhost:${PORT}`;
const SESSION = "e2e-" + Math.random().toString(36).slice(2, 8);

const catalog = new InMemoryProviderCatalog();
catalog.register(createOpenRouterAdapter({ apiKey: key }));
const firewall = new ForgeZero({ providerOracle: { isActive: (id) => !!catalog.get(id) } });
const registry = new NormalizedModelRegistry();
registry.loadSnapshot();

// Discover + verify free models from the live OpenRouter catalog, register into ForgeZero.
const live = (await catalog.get("openrouter").listModels()).map((m) => ({
  modelId: m.modelId, isFree: m.isFree, displayName: m.displayName, contextWindow: m.contextWindow, toolCalling: m.capabilities?.toolCalling,
}));
const { records, verifiedCount } = discoverAndVerifyFree(registry, "openrouter", live);
for (const rec of records) firewall.register(rec);
console.log(`Discovered ${verifiedCount} verified-free OpenRouter models.`);
const eligible = firewall.eligibleModels();
console.log(`ForgeZero eligible: ${eligible.length} (e.g. ${eligible.slice(0, 3).map((m) => m.modelId).join(", ")})`);

const server = new CodeForgeServer({ port: PORT, dbPath: path.join(os.tmpdir(), `cf-e2e-${Date.now()}.db`), firewall, providerCatalog: catalog, useRealRuntime: true });
await server.start();
try {
  // Pick a small, fast verified-free text model deterministically for a bounded prose turn.
  const chosen = eligible.find((m) => /mini|flash|lite|small|8b|nano|gemma/i.test(m.modelId)) ?? eligible[0];
  await post("/api/model-selection", { sessionId: SESSION, providerId: chosen.providerId, modelId: chosen.modelId });
  console.log(`Selected exact-free: ${chosen.providerId}::${chosen.modelId}`);

  const send = await post("/api/send", { sessionId: SESSION, message: "In two sentences, what is a model registry in an AI coding tool?", turnId: crypto.randomUUID() });
  console.log("send →", JSON.stringify(send));

  // Poll persisted events for the assistant.message.completed prose.
  let completed = null;
  let deltas = 0;
  for (let i = 0; i < 30 && !completed; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const evs = await get(`/api/sessions/${SESSION}/events`);
    deltas = evs.filter((e) => e.type === "text.delta").length;
    completed = evs.find((e) => e.type === "assistant.message.completed" && (e.payload.text || "").trim().length > 0);
    if (evs.find((e) => e.type === "turn.failed")) { console.error("turn.failed:", evs.find((e) => e.type === "turn.failed").payload.error); break; }
  }

  // Session isolation: the SSE stream scoped to a DIFFERENT session must not carry these events.
  const otherStream = await sseFirstEvents(`${BASE}/api/events?sessionId=other-session`, 1500);
  const bleed = otherStream.filter((e) => e.sessionId === SESSION).length;

  console.log("\n===== RESULT =====");
  console.log("text.delta events streamed:", deltas);
  if (completed) {
    console.log("assistant.message.completed PERSISTED:", JSON.stringify(completed.payload.text.slice(0, 260)));
  } else {
    console.log("assistant.message.completed: NONE");
  }
  console.log("session isolation — events for our session leaking into another stream:", bleed, "(want 0)");
  const pass = !!completed && deltas > 0 && bleed === 0;
  console.log("\nE2E free-inference + prose-persistence + isolation:", pass ? "PASS" : "FAIL");
  await server.stop();
  process.exit(pass ? 0 : 1);
} catch (e) {
  console.error("E2E error:", e?.message || e);
  await server.stop();
  process.exit(1);
}

async function post(p, body) {
  const r = await fetch(BASE + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
}
async function get(p) {
  const r = await fetch(BASE + p);
  return r.json();
}
async function sseFirstEvents(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const out = [];
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: "text/event-stream" } });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const l of lines) {
        if (l.startsWith("data:")) { try { out.push(JSON.parse(l.slice(5).trim())); } catch {} }
      }
    }
  } catch {
    // aborted by timeout — expected
  } finally {
    clearTimeout(timer);
  }
  return out;
}

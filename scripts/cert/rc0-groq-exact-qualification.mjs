#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ForgeZero, createGenericFreeRecord } from "@codeforge/forge-zero";
import { createGroqAdapter } from "@codeforge/providers";

const outputPath = resolve(process.argv[2] ?? "tests/evidence/rc0-live-certification/provider-runtime/groq-exact-qualification.json");
const modelId = "openai/gpt-oss-20b";
const evidence = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  providerId: "groq",
  modelId,
  purpose: "One bounded live free-tier qualification; no fallback providers are constructed.",
  credential: "GROQ_API_KEY presence checked only; value never read into evidence or output.",
  maxTokens: 128,
  result: "blocked",
};

try {
  if (!process.env.GROQ_API_KEY?.trim()) throw new Error("missing credential");
  const firewall = new ForgeZero();
  firewall.register(createGenericFreeRecord({ providerId: "groq", modelId, displayName: "Groq gpt-oss-20b" }));
  evidence.forgeZeroEligible = firewall.eligibleModels().some((model) => model.providerId === "groq" && model.modelId === modelId);
  if (!evidence.forgeZeroEligible) throw new Error("exact model rejected by ForgeZero");
  const adapter = createGroqAdapter({ apiKey: process.env.GROQ_API_KEY, timeoutMs: 30_000 });
  let textDeltas = 0;
  const eventTypes = new Set();
  let finish = false;
  let usage = null;
  for await (const event of adapter.streamChat({
    model: modelId,
    messages: [{ role: "user", content: "Reply exactly with: RC0_FREE_OK" }],
    maxTokens: 128,
  })) {
    eventTypes.add(event.type);
    if (event.type === "text_delta") textDeltas += 1;
    if (event.type === "finish") finish = true;
    if (event.type === "usage") usage = event.usage;
  }
  evidence.result = textDeltas > 0 && finish ? "completed" : "blocked";
  evidence.runtime = { textDeltas, finish, usage, eventTypes: [...eventTypes] };
} catch (error) {
  evidence.result = "blocked";
  evidence.failureClass = error instanceof Error && /timeout/i.test(error.message) ? "timeout" : "request_failed";
}

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ result: evidence.result, outputPath, modelId }, null, 2));
process.exit(evidence.result === "completed" ? 0 : 1);

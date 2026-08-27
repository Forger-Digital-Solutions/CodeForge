#!/usr/bin/env node
// verify:opencode — reusable live verification for OpenCode Zen Muse Spark Contributor Free
// Law 7: optional live verification, never prints secrets
import { OpencodeAdapter, EnvironmentCredentialStore } from "../packages/providers/dist/index.js";

const MODEL = "muse-spark-1.2-contributor-free";
const EXPECTED = "CODEFORGE_MUSE_OK";

function hasKey() {
  return !!process.env.OPENCODE_API_KEY;
}

async function main() {
  if (!hasKey()) {
    console.log("LIVE_VERIFICATION_SKIPPED — OPENCODE_API_KEY absent");
    console.log("Deterministic adapter tests remain mandatory; live check is optional.");
    process.exit(0);
  }

  const store = new EnvironmentCredentialStore();
  const adapter = new OpencodeAdapter({ credentialStore: store });

  // Verify provider identity
  if (adapter.providerId !== "opencode") {
    console.error(`FAIL — providerId is ${adapter.providerId}, expected opencode`);
    process.exit(1);
  }

  console.log(`Verifying ${MODEL} via OpencodeAdapter -> https://opencode.ai/zen/v1/responses`);
  const start = Date.now();
  try {
    const res = await adapter.chat({
      model: MODEL,
      messages: [{ role: "user", content: "Return exactly: CODEFORGE_MUSE_OK" }],
      maxTokens: 32,
    });
    const latency = Date.now() - start;

    // Law 2: exact model id
    const served = res.model;
    const normRequested = MODEL.replace(/^opencode\//, "");
    const normServed = served.replace(/^opencode\//, "");
    if (normRequested !== normServed) {
      console.error(`FAIL — MODEL_MISMATCH: requested ${MODEL} but served ${served}`);
      process.exit(1);
    }

    // Law 3: response content
    if (!res.id) {
      console.error("FAIL — response id missing");
      process.exit(1);
    }
    const output = res.choices?.[0]?.message?.content?.trim();
    if (output !== EXPECTED) {
      console.error(`FAIL — output mismatch: expected "${EXPECTED}" got "${output}"`);
      console.log(`Full response: ${JSON.stringify(res, null, 2)}`);
      process.exit(1);
    }

    // usage structurally valid if present
    if (res.usage) {
      if (typeof res.usage.inputTokens !== "number" || typeof res.usage.outputTokens !== "number") {
        console.error("FAIL — usage malformed");
        process.exit(1);
      }
    }

    console.log(`PASS — provider=opencode model=${served} id=${res.id} latency=${latency}ms output=${output}`);
    if (res.usage) console.log(`usage input=${res.usage.inputTokens} output=${res.usage.outputTokens} total=${res.usage.totalTokens}`);
    console.log("Live verification succeeded; ForgeZero still authoritative (7-day expiry unchanged).");
    process.exit(0);
  } catch (e) {
    const err = e;
    console.error(`FAIL — ${err.name || "Error"}: ${err.message}`);
    if (err.code) console.error(`code=${err.code} retryable=${err.retryable}`);
    // Map to expected semantics without leaking secrets
    process.exit(1);
  }
}

main();

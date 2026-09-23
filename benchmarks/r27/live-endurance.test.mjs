import assert from "node:assert/strict";
import test from "node:test";
import { createBoundedAdapter } from "./live-endurance.mjs";

test("stops a live run before a second dispatch after a provider-reported output-cap violation", async () => {
  const inner = {
    providerId: "fake-free",
    async listModels() { return []; },
    async healthCheck() { return { status: "available" }; },
    async *streamChat() {
      yield { type: "usage", usage: { inputTokens: 1, outputTokens: 257 } };
      yield { type: "finish", finishReason: "stop" };
    },
  };
  const records = [];
  const adapter = createBoundedAdapter(inner, 4, 256, records);
  for await (const _event of adapter.streamChat({})) {
    // Consume the complete first response; the real runtime receives this response before its
    // next model-turn dispatch, which is where the guard rejects further provider work.
  }

  assert.equal(records.length, 1);
  assert.equal(records[0].outputCapExceeded, true);
  assert.equal(records[0].outcome, "output_cap_exceeded");
  await assert.rejects(async () => {
    for await (const _event of adapter.streamChat({})) {
      // no-op
    }
  }, (error) => error?.code === "R27_LIVE_OUTPUT_CAP");
});

import { describe, expect, it } from "vitest";
import { createKiloFreeDirectAdapter } from "../src/provider-factory.js";
import type { StreamEvent } from "../src/chat-types.js";

const model = "vendor/qualified:free";
const request = { model, messages: [{ role: "user" as const, content: "Review public code" }] };
const stream = (frames: unknown[]) => new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
const toolFrame = { model, choices: [{ delta: { tool_calls: [{ index: 0, id: "edit", function: { name: "edit_file", arguments: '{"path":"src/a.ts"}' } }] }, finish_reason: "tool_calls" }] };

describe("R74 Kilo exact qualified identity", () => {
  it.each([undefined, "vendor/substitute:free"])("refuses chat identity %s without lending qualification", async served => {
    const adapter = createKiloFreeDirectAdapter({ fetchFn: (async () => new Response(JSON.stringify({ model: served, choices: [{ message: { content: "approved" }, finish_reason: "stop" }] }))) as typeof fetch });
    await expect(adapter.chat(request)).rejects.toMatchObject({ code: served ? "MODEL_SUBSTITUTED" : "SERVED_MODEL_UNVERIFIED" });
  });

  it("withholds executable tools when the terminal usage frame changes identity", async () => {
    const adapter = createKiloFreeDirectAdapter({ fetchFn: (async () => stream([toolFrame, { model: "vendor/substitute:free", choices: [], usage: { prompt_tokens: 20, completion_tokens: 10 } }])) as typeof fetch });
    const events: StreamEvent[] = [];
    await expect((async () => { for await (const event of adapter.streamChat(request)) events.push(event); })()).rejects.toMatchObject({ code: "MODEL_SUBSTITUTED" });
    expect(events.some(event => event.type === "tool_call_completed")).toBe(false);
    expect(events.some(event => event.type === "finish")).toBe(false);
  });

  it("refuses unverified stream content and executes no tool", async () => {
    const adapter = createKiloFreeDirectAdapter({ fetchFn: (async () => stream([{ choices: [{ delta: { content: "pass" }, finish_reason: "stop" }] }])) as typeof fetch });
    const events: StreamEvent[] = [];
    await expect((async () => { for await (const event of adapter.streamChat(request)) events.push(event); })()).rejects.toMatchObject({ code: "SERVED_MODEL_UNVERIFIED" });
    expect(events).toEqual([]);
  });

  it("releases exact-model tools only after final identity verification", async () => {
    const adapter = createKiloFreeDirectAdapter({ fetchFn: (async () => stream([toolFrame, { model, choices: [], usage: { prompt_tokens: 20, completion_tokens: 10 } }])) as typeof fetch });
    const events: StreamEvent[] = [];
    for await (const event of adapter.streamChat(request)) events.push(event);
    const usage = events.findIndex(event => event.type === "usage");
    const tool = events.findIndex(event => event.type === "tool_call_completed");
    expect(usage).toBeGreaterThanOrEqual(0);
    expect(tool).toBeGreaterThan(usage);
    expect(events.at(-1)).toEqual({ type: "finish", finishReason: "tool_calls", model });
  });

  it("preserves Auto Free's explicitly delegated physical-model selection", async () => {
    const adapter = createKiloFreeDirectAdapter({ fetchFn: (async () => new Response(JSON.stringify({ model, choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }))) as typeof fetch });
    expect((await adapter.chat({ ...request, model: "kilo-auto/free" })).model).toBe(model);
  });
});

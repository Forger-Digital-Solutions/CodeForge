import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenRouterAdapter } from "../src/openrouter.js";
import type { CredentialStore } from "../src/index.js";

/**
 * OpenRouter's live catalog states tool support through `supported_parameters` and modalities
 * through `architecture.{input,output}_modalities` / a "text+image->text" string. The adapter must
 * read those facts and fail closed: a $0 route the catalog does not mark tool-capable (a content
 * safety classifier, a music model) must never look like an executable coding route, and a model
 * that cannot produce text is not a chat model at all.
 */
const fakeCredentials: CredentialStore = {
  get: () => "test-key",
  set: () => {},
  delete: () => {},
  has: () => true,
};

function catalog(models: unknown[]) {
  return new Response(JSON.stringify({ data: models }), { status: 200, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OpenRouterAdapter — live catalog capability facts", () => {
  it("derives tool calling, vision and structured output from the catalog's own fields", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(catalog([
      {
        id: "nvidia/nemotron-3-super-120b-a12b:free",
        name: "Nemotron 3 Super (free)",
        context_length: 262144,
        pricing: { prompt: "0", completion: "0" },
        architecture: { modality: "text->text", input_modalities: ["text"], output_modalities: ["text"] },
        supported_parameters: ["max_tokens", "response_format", "structured_outputs", "tool_choice", "tools"],
      },
      {
        id: "google/gemma-4-31b-it:free",
        context_length: 262144,
        pricing: { prompt: "0", completion: "0" },
        architecture: { modality: "text+image+video->text", input_modalities: ["image", "text", "video"], output_modalities: ["text"] },
        supported_parameters: ["max_tokens", "tools", "tool_choice"],
      },
    ])));
    const models = await new OpenRouterAdapter({ credentialStore: fakeCredentials }).listModels();

    expect(models.map((m) => [m.modelId, m.capabilities.toolCalling, m.capabilities.vision, m.capabilities.structuredOutput, m.isFree])).toEqual([
      ["nvidia/nemotron-3-super-120b-a12b:free", true, false, true, true],
      ["google/gemma-4-31b-it:free", true, true, false, true],
    ]);
  });

  it("marks a $0 route without `tools` as not tool-capable instead of assuming it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(catalog([
      {
        id: "nvidia/nemotron-3.5-content-safety:free",
        context_length: 128000,
        pricing: { prompt: "0", completion: "0" },
        architecture: { modality: "text+image->text", input_modalities: ["text", "image"], output_modalities: ["text"] },
        supported_parameters: ["include_reasoning", "max_tokens", "reasoning", "seed", "temperature", "top_p"],
      },
      {
        id: "google/lyria-3-pro-preview",
        context_length: 1048576,
        pricing: { prompt: "0", completion: "0" },
        architecture: { modality: "text+image->text+audio", input_modalities: ["text", "image"], output_modalities: ["text", "audio"] },
        supported_parameters: ["max_tokens", "response_format", "seed", "temperature", "top_p"],
      },
    ])));
    const models = await new OpenRouterAdapter({ credentialStore: fakeCredentials }).listModels();

    expect(models.map((m) => [m.modelId, m.capabilities.toolCalling])).toEqual([
      ["nvidia/nemotron-3.5-content-safety:free", false],
      ["google/lyria-3-pro-preview", false],
    ]);
  });

  it("drops catalog entries that cannot produce text", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(catalog([
      { id: "some/tts-model", pricing: { prompt: "0", completion: "0" }, architecture: { modality: "text->audio", input_modalities: ["text"], output_modalities: ["audio"] }, supported_parameters: ["max_tokens"] },
      { id: "some/image-model", pricing: { prompt: "0", completion: "0" }, architecture: { modality: "text->image" } },
      { id: "some/chat-model", pricing: { prompt: "0", completion: "0" }, architecture: { modality: "text->text" }, supported_parameters: ["tools"] },
    ])));
    const models = await new OpenRouterAdapter({ credentialStore: fakeCredentials }).listModels();

    expect(models.map((m) => m.modelId)).toEqual(["some/chat-model"]);
  });

  it("fails closed when the catalog states no capability facts at all", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(catalog([
      { id: "mystery/model", pricing: { prompt: "0", completion: "0" } },
      { id: "legacy/model", pricing: { prompt: "0", completion: "0" }, supports_tools: true },
    ])));
    const models = await new OpenRouterAdapter({ credentialStore: fakeCredentials }).listModels();

    expect(models.map((m) => [m.modelId, m.capabilities.toolCalling, m.capabilities.structuredOutput, m.capabilities.coding])).toEqual([
      ["mystery/model", false, false, true],
      ["legacy/model", true, false, true],
    ]);
  });

  it("keeps the $0 gate strict: any non-zero unit price is paid", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(catalog([
      { id: "meta/muse-spark-1.2", pricing: { prompt: "0", completion: "0.000001" }, architecture: { modality: "text->text" }, supported_parameters: ["tools"] },
      { id: "x/no-pricing", architecture: { modality: "text->text" }, supported_parameters: ["tools"] },
    ])));
    const models = await new OpenRouterAdapter({ credentialStore: fakeCredentials }).listModels();

    expect(models.map((m) => [m.modelId, m.isFree, m.freeStatus])).toEqual([
      ["meta/muse-spark-1.2", false, "paid"],
      ["x/no-pricing", false, "paid"],
    ]);
  });
});

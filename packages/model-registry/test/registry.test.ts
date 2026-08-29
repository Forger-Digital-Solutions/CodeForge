import { describe, it, expect } from "vitest";
import {
  NormalizedModelRegistry,
  normalizeModelsDev,
  normalizeModel,
  deriveAccessClass,
  getProviderPolicy,
  verifyZeroUnitFree,
  verifyAllowanceFree,
  ModelsDevDocSchema,
  fetchModelsDev,
  ModelsDevFetchError,
  type ModelsDevDoc,
  type CachePersistence,
} from "../src/index.js";

const NOW = new Date("2026-08-29T12:00:00.000Z");
const now = () => NOW;

/** Minimal fake Models.dev doc with one free + one paid model per key provider. */
function fakeDoc(): ModelsDevDoc {
  return {
    zai: {
      id: "zai",
      name: "Z.AI",
      env: ["ZHIPU_API_KEY"],
      api: "https://api.z.ai/api/paas/v4",
      models: {
        "glm-4.5-flash": {
          id: "glm-4.5-flash",
          name: "GLM-4.5-Flash",
          family: "glm-flash",
          tool_call: true,
          reasoning: true,
          structured_output: true,
          modalities: { input: ["text"], output: ["text"] },
          limit: { context: 128000, output: 96000 },
          cost: { input: 0, output: 0 },
        },
        "glm-4.7": {
          id: "glm-4.7",
          name: "GLM-4.7",
          family: "glm",
          tool_call: true,
          modalities: { input: ["text"], output: ["text"] },
          limit: { context: 204800, output: 131072 },
          cost: { input: 0.6, output: 2.2 },
        },
      },
    },
    openrouter: {
      id: "openrouter",
      name: "OpenRouter",
      api: "https://openrouter.ai/api/v1",
      models: {
        "z-ai/glm-5.2:free": {
          id: "z-ai/glm-5.2:free",
          name: "GLM 5.2 (free)",
          family: "glm",
          tool_call: true,
          modalities: { input: ["text"], output: ["text"] },
          limit: { context: 200000, output: 100000 },
          cost: { input: 0, output: 0 },
        },
      },
    },
    google: {
      id: "google",
      name: "Google",
      env: ["GEMINI_API_KEY"],
      models: {
        "gemini-3.1-flash-lite": {
          id: "gemini-3.1-flash-lite",
          name: "Gemini 3.1 Flash Lite",
          family: "gemini",
          tool_call: true,
          modalities: { input: ["text", "image"], output: ["text"] },
          limit: { context: 1000000, output: 65000 },
          cost: { input: 0.1, output: 0.4 },
        },
      },
    },
    openai: {
      id: "openai",
      name: "OpenAI",
      env: ["OPENAI_API_KEY"],
      models: {
        "gpt-4o-mini": {
          id: "gpt-4o-mini",
          name: "GPT-4o mini",
          family: "gpt-mini",
          tool_call: true,
          attachment: true,
          modalities: { input: ["text", "image"], output: ["text"] },
          limit: { context: 128000, output: 16384 },
          cost: { input: 0.15, output: 0.6 },
        },
      },
    },
  };
}

describe("Models.dev normalization → access classification", () => {
  it("classifies Z.AI $0 model as FREE_NATIVE (direct provider)", () => {
    const rec = normalizeModel("zai", fakeDoc().zai.models["glm-4.5-flash"]!, getProviderPolicy("zai"));
    expect(rec.accessClass).toBe("FREE_NATIVE");
    expect(rec.authMode).toBe("API_KEY");
    expect(rec.capabilities.toolCalling).toBe(true);
    expect(rec.contextWindow).toBe(128000);
  });

  it("classifies OpenRouter :free model as FREE_ROUTED (gateway)", () => {
    const rec = normalizeModel("openrouter", fakeDoc().openrouter.models["z-ai/glm-5.2:free"]!, getProviderPolicy("openrouter"));
    expect(rec.accessClass).toBe("FREE_ROUTED");
    expect(rec.authMode).toBe("OAUTH_PKCE");
  });

  it("classifies Gemini paid-unit chat model as FREE_ALLOWANCE with permissive privacy", () => {
    const rec = normalizeModel("google", fakeDoc().google.models["gemini-3.1-flash-lite"]!, getProviderPolicy("google"));
    expect(rec.accessClass).toBe("FREE_ALLOWANCE");
    expect(rec.privacyClass).toBe("permissive"); // free tier may train on prompts
    expect(rec.capabilities.vision).toBe(true);
  });

  it("classifies OpenAI model as PAID (no free tier)", () => {
    const rec = normalizeModel("openai", fakeDoc().openai.models["gpt-4o-mini"]!, getProviderPolicy("openai"));
    expect(rec.accessClass).toBe("PAID");
  });

  it("classifies Z.AI non-zero coding model as PAID", () => {
    const rec = normalizeModel("zai", fakeDoc().zai.models["glm-4.7"]!, getProviderPolicy("zai"));
    expect(rec.accessClass).toBe("PAID");
  });

  it("never classifies unknown pricing as free", () => {
    const cls = deriveAccessClass(
      "zai",
      { inputPerMillion: null, outputPerMillion: null, currency: "USD" },
      { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: false, longContext: false, reasoning: false },
      getProviderPolicy("zai"),
    );
    expect(cls).toBe("PAID");
  });

  it("only normalizes providers CodeForge has a policy for", () => {
    const doc = { ...fakeDoc(), "random-provider": { id: "random-provider", models: { m: { id: "m", cost: { input: 0, output: 0 } } } } } as ModelsDevDoc;
    const records = normalizeModelsDev(doc);
    expect(records.some((r) => r.providerId === "random-provider")).toBe(false);
    expect(records.some((r) => r.providerId === "zai")).toBe(true);
  });
});

describe("Schema validation", () => {
  it("accepts documents with unknown extra fields (passthrough)", () => {
    const doc = { zai: { id: "zai", extra: 1, models: { a: { id: "a", surprise: true, cost: { input: 0, output: 0 } } } } };
    expect(ModelsDevDocSchema.safeParse(doc).success).toBe(true);
  });

  it("rejects a model missing its id", () => {
    const doc = { zai: { id: "zai", models: { a: { name: "no id" } } } };
    expect(ModelsDevDocSchema.safeParse(doc).success).toBe(false);
  });
});

describe("CodeForge overlay independence & verification", () => {
  it("free candidate is NOT verified-free from facts alone (Models.dev cannot grant trust)", () => {
    const reg = new NormalizedModelRegistry({ now });
    reg.loadDoc(fakeDoc(), "live", NOW.toISOString());
    const rec = reg.get("zai", "glm-4.5-flash")!;
    const bridged = reg.toFreeModelRecord(rec);
    expect(rec.accessClass).toBe("FREE_NATIVE");
    expect(bridged.freeStatus).toBe("unknown"); // candidate, not trusted yet
    expect(bridged.costProfile.isFree).toBe(true); // $0 unit is a fact
  });

  it("becomes verified-free only after the overlay records live-catalog evidence", () => {
    const reg = new NormalizedModelRegistry({ now });
    reg.loadDoc(fakeDoc(), "live", NOW.toISOString());
    const rec = reg.get("zai", "glm-4.5-flash")!;
    const ev = verifyZeroUnitFree(rec, { confirmedByLiveCatalog: true, now });
    expect(ev).not.toBeNull();
    reg.overlay.merge(ev!);
    const bridged = reg.toFreeModelRecord(rec);
    expect(bridged.freeStatus).toBe("verified_free");
    expect(bridged.freeStatusVerifiedAt).toBe(NOW.toISOString());
    expect(bridged.health?.status).toBe("available");
  });

  it("refuses zero-unit verification without live-catalog confirmation", () => {
    const reg = new NormalizedModelRegistry({ now });
    reg.loadDoc(fakeDoc(), "live", NOW.toISOString());
    const rec = reg.get("zai", "glm-4.5-flash")!;
    expect(verifyZeroUnitFree(rec, { confirmedByLiveCatalog: false, now })).toBeNull();
  });

  it("allowance verification requires a live probe, never pricing", () => {
    const reg = new NormalizedModelRegistry({ now });
    reg.loadDoc(fakeDoc(), "live", NOW.toISOString());
    const rec = reg.get("google", "gemini-3.1-flash-lite")!;
    expect(verifyAllowanceFree(rec, { probeSucceeded: false, now })).toBeNull();
    const ev = verifyAllowanceFree(rec, { probeSucceeded: true, now });
    expect(ev?.verifiedFree).toBe(true);
  });

  it("paid model can never be marked verified-free by the overlay helpers", () => {
    const reg = new NormalizedModelRegistry({ now });
    reg.loadDoc(fakeDoc(), "live", NOW.toISOString());
    const rec = reg.get("openai", "gpt-4o-mini")!;
    expect(verifyZeroUnitFree(rec, { confirmedByLiveCatalog: true, now })).toBeNull();
    expect(verifyAllowanceFree(rec, { probeSucceeded: true, now })).toBeNull();
  });
});

describe("Cache & snapshot fallback (offline resilience)", () => {
  it("loads the bundled snapshot without any network", () => {
    const reg = new NormalizedModelRegistry({ now });
    reg.loadSnapshot();
    expect(reg.source).toBe("snapshot");
    expect(reg.all().length).toBeGreaterThan(0);
    expect(reg.byProvider("zai").length).toBeGreaterThan(0);
  });

  it("refresh success replaces registry and stamps lastUpdated + persists cache", async () => {
    const saved: { doc: ModelsDevDoc; fetchedAt: string }[] = [];
    const cache: CachePersistence = { load: () => null, save: (e) => saved.push(e) };
    const reg = new NormalizedModelRegistry({ now, cache });
    const fetchFn = (async () => new Response(JSON.stringify(fakeDoc()), { status: 200 })) as unknown as typeof fetch;
    const res = await reg.refresh({ fetchFn });
    expect(res.ok).toBe(true);
    expect(res.source).toBe("live");
    expect(reg.lastUpdated).toBe(NOW.toISOString());
    expect(saved).toHaveLength(1);
  });

  it("on upstream outage with empty registry, falls back to snapshot (never loses availability)", async () => {
    const reg = new NormalizedModelRegistry({ now });
    const fetchFn = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
    const res = await reg.refresh({ fetchFn });
    expect(res.ok).toBe(false);
    expect(res.source).toBe("snapshot");
    expect(reg.all().length).toBeGreaterThan(0);
    expect(res.error).toContain("503");
  });

  it("on upstream outage with disk cache, prefers cache over snapshot", async () => {
    const cachedDoc = fakeDoc();
    const cache: CachePersistence = {
      load: () => ({ doc: cachedDoc, fetchedAt: "2026-08-28T00:00:00.000Z" }),
      save: () => {},
    };
    const reg = new NormalizedModelRegistry({ now, cache });
    const fetchFn = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const res = await reg.refresh({ fetchFn });
    expect(res.ok).toBe(false);
    expect(res.source).toBe("cache");
    expect(reg.lastUpdated).toBe("2026-08-28T00:00:00.000Z");
  });

  it("keeps existing good data when a later refresh fails (no destruction)", async () => {
    const reg = new NormalizedModelRegistry({ now });
    const good = (async () => new Response(JSON.stringify(fakeDoc()), { status: 200 })) as unknown as typeof fetch;
    await reg.refresh({ fetchFn: good });
    const countAfterGood = reg.all().length;
    const bad = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    const res = await reg.refresh({ fetchFn: bad });
    expect(res.ok).toBe(false);
    expect(reg.all().length).toBe(countAfterGood); // unchanged
    expect(reg.source).toBe("live"); // retained
  });

  it("fetchModelsDev throws a typed error on HTTP failure", async () => {
    const fetchFn = (async () => new Response("x", { status: 500 })) as unknown as typeof fetch;
    await expect(fetchModelsDev({ fetchFn })).rejects.toBeInstanceOf(ModelsDevFetchError);
  });
});

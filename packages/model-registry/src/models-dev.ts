import { z } from "zod";
import type { ModelRecord, NormalizedCapabilities, NormalizedPricing } from "./normalized-types.js";
import { canonicalId } from "./normalized-types.js";
import {
  deriveAccessClass,
  derivePrivacyClass,
  getProviderPolicy,
  type ProviderPolicy,
} from "./provider-policy.js";

/**
 * Lenient Zod schemas for the Models.dev catalog (https://models.dev/api.json).
 * Unknown fields are ignored; missing fields tolerated. We validate the SHAPE we consume,
 * not the whole upstream document, so upstream additions never break the fetch.
 */
export const ModelsDevModelSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    family: z.string().optional(),
    attachment: z.boolean().optional(),
    reasoning: z.boolean().optional(),
    tool_call: z.boolean().optional(),
    structured_output: z.boolean().optional(),
    open_weights: z.boolean().optional(),
    release_date: z.string().optional(),
    last_updated: z.string().optional(),
    modalities: z
      .object({
        input: z.array(z.string()).optional(),
        output: z.array(z.string()).optional(),
      })
      .optional(),
    limit: z
      .object({
        context: z.number().optional(),
        output: z.number().optional(),
      })
      .optional(),
    cost: z
      .object({
        input: z.number().optional(),
        output: z.number().optional(),
        cache_read: z.number().optional(),
        cache_write: z.number().optional(),
      })
      .optional(),
  })
  .passthrough();
export type ModelsDevModel = z.infer<typeof ModelsDevModelSchema>;

export const ModelsDevProviderSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    env: z.array(z.string()).optional(),
    npm: z.string().optional(),
    api: z.string().optional(),
    doc: z.string().optional(),
    models: z.record(ModelsDevModelSchema),
  })
  .passthrough();
export type ModelsDevProvider = z.infer<typeof ModelsDevProviderSchema>;

/** Top-level document: object keyed by providerId. */
export const ModelsDevDocSchema = z.record(ModelsDevProviderSchema);
export type ModelsDevDoc = z.infer<typeof ModelsDevDocSchema>;

export interface NormalizeOptions {
  /** Only include these providers (default: all providers CodeForge has a policy for). */
  providerIds?: string[];
  /** Override the "now" timestamp for tests. */
  now?: () => Date;
}

function capsFrom(m: ModelsDevModel): NormalizedCapabilities {
  const inputs = m.modalities?.input ?? ["text"];
  const context = m.limit?.context ?? 0;
  const vision = m.attachment === true || inputs.includes("image");
  return {
    text: inputs.includes("text"),
    // Coding is not a modality; treat any text+tool model as coding-capable, refined by scores later.
    coding: inputs.includes("text"),
    toolCalling: m.tool_call === true,
    vision,
    structuredOutput: m.structured_output === true,
    longContext: context >= 32000,
    reasoning: m.reasoning === true,
  };
}

function pricingFrom(m: ModelsDevModel): NormalizedPricing {
  const c = m.cost;
  return {
    inputPerMillion: c?.input ?? null,
    outputPerMillion: c?.output ?? null,
    cacheReadPerMillion: c?.cache_read ?? null,
    cacheWritePerMillion: c?.cache_write ?? null,
    currency: "USD",
  };
}

/** Normalize one Models.dev model into a CodeForge ModelRecord (facts only). */
export function normalizeModel(
  providerId: string,
  m: ModelsDevModel,
  policy: ProviderPolicy | undefined,
): ModelRecord {
  const capabilities = capsFrom(m);
  const pricing = pricingFrom(m);
  const accessClass = deriveAccessClass(providerId, pricing, capabilities, policy);
  const privacyClass = derivePrivacyClass(policy, accessClass);
  return {
    id: canonicalId(providerId, m.id),
    providerId,
    modelId: m.id,
    displayName: m.name ?? m.id,
    family: m.family,
    upstreamSource: "models.dev",
    capabilities,
    contextWindow: m.limit?.context,
    maxOutput: m.limit?.output,
    pricing,
    accessClass,
    authMode: policy?.authMode ?? "API_KEY",
    privacyClass,
    status: "active",
    deprecated: false,
    lastUpdated: m.last_updated ?? m.release_date,
  };
}

/**
 * Normalize a validated Models.dev document into ModelRecord[].
 * Providers without a CodeForge policy are skipped by default (we only surface providers
 * CodeForge can actually route to). Pass `providerIds` to widen/narrow the selection.
 */
export function normalizeModelsDev(doc: ModelsDevDoc, opts: NormalizeOptions = {}): ModelRecord[] {
  const out: ModelRecord[] = [];
  const wanted = opts.providerIds;
  for (const [providerId, provider] of Object.entries(doc)) {
    const policy = getProviderPolicy(providerId);
    if (wanted) {
      if (!wanted.includes(providerId)) continue;
    } else if (!policy) {
      continue;
    }
    for (const m of Object.values(provider.models)) {
      out.push(normalizeModel(providerId, m, policy));
    }
  }
  return out;
}

export interface FetchModelsDevOptions {
  url?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

export class ModelsDevFetchError extends Error {
  readonly reason?: unknown;
  constructor(message: string, reason?: unknown) {
    super(message);
    this.name = "ModelsDevFetchError";
    this.reason = reason;
  }
}

const MODELS_DEV_URL = "https://models.dev/api.json";

/**
 * Fetch + validate the Models.dev catalog. Throws {@link ModelsDevFetchError} on network,
 * HTTP, JSON, or schema failure — callers fall back to the cached/snapshot registry.
 */
export async function fetchModelsDev(opts: FetchModelsDevOptions = {}): Promise<ModelsDevDoc> {
  const url = opts.url ?? MODELS_DEV_URL;
  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { signal: controller.signal });
    if (!res.ok) {
      throw new ModelsDevFetchError(`Models.dev returned HTTP ${res.status}`);
    }
    const json = (await res.json()) as unknown;
    const parsed = ModelsDevDocSchema.safeParse(json);
    if (!parsed.success) {
      throw new ModelsDevFetchError(`Models.dev schema validation failed: ${parsed.error.issues[0]?.message ?? "unknown"}`);
    }
    return parsed.data;
  } catch (e) {
    if (e instanceof ModelsDevFetchError) throw e;
    if (e instanceof Error && e.name === "AbortError") {
      throw new ModelsDevFetchError("Models.dev request timed out", e);
    }
    throw new ModelsDevFetchError(`Models.dev fetch failed: ${e instanceof Error ? e.message : String(e)}`, e);
  } finally {
    clearTimeout(timeout);
  }
}

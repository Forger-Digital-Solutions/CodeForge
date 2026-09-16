/**
 * Canonical model identity — the layer that separates WHAT a model is from WHERE it is served.
 *
 *   provider route  openrouter :: openai/gpt-oss-120b:free   ┐
 *   provider route  groq       :: openai/gpt-oss-120b        ├─▶ canonical  openai/gpt-oss-120b
 *   provider route  cerebras   :: gpt-oss-120b               │
 *   provider route  cloudflare :: @cf/openai/gpt-oss-120b    ┘
 *
 * The user picks the canonical model; ForgeAuto picks the route. Identity is derived from a
 * deterministic normalization of the provider's model id plus a small curated alias table for
 * hosts that rename models. Normalization never consults price or availability.
 */

export interface CanonicalIdentity {
  /** `${lab}/${slug}` — e.g. "openai/gpt-oss-120b", "zai/glm-4.7-flash". */
  canonicalId: string;
  lab: string;
  slug: string;
  family: string;
  displayName: string;
  /** True when the provider id carried an explicit free-variant marker (":free", "-free"). */
  freeVariant: boolean;
}

const LAB_ALIASES: Record<string, string> = {
  "z-ai": "zai",
  "zai-org": "zai",
  zhipuai: "zai",
  zhipu: "zai",
  "deepseek-ai": "deepseek",
  "meta-llama": "meta",
  meta: "meta",
  "mistralai": "mistral",
  "moonshotai": "moonshotai",
  moonshot: "moonshotai",
  "inclusionai": "inclusionai",
  "thinkingmachines": "thinkingmachines",
  "dots-studio": "dots-studio",
  "nex-agi": "nex-agi",
  "cohere": "cohere",
  "liquid": "liquid",
  "nvidia": "nvidia",
  "openai": "openai",
  "google": "google",
  "qwen": "qwen",
  "poolside": "poolside",
  "xai": "xai",
  "anthropic": "anthropic",
  "ibm-granite": "ibm",
  "aisingapore": "aisingapore",
  "canopylabs": "canopylabs",
  "stepfun": "stepfun",
};

/** Slug prefixes that identify a lab when the provider id carries no vendor path. */
const SLUG_LAB_HINTS: Array<[RegExp, string]> = [
  [/^gpt-oss/, "openai"],
  [/^gpt-|^o[134](-|$)|^codex/, "openai"],
  [/^glm/, "zai"],
  [/^gemini|^gemma|^lyria/, "google"],
  [/^qwen|^qwq/, "qwen"],
  [/^llama/, "meta"],
  [/^nemotron/, "nvidia"],
  [/^laguna/, "poolside"],
  [/^kimi/, "moonshotai"],
  [/^deepseek/, "deepseek"],
  [/^mistral|^ministral|^magistral|^codestral|^devstral|^voxtral|^mixtral/, "mistral"],
  [/^claude/, "anthropic"],
  [/^grok/, "xai"],
  [/^ling|^ring/, "inclusionai"],
  [/^inkling/, "thinkingmachines"],
  [/^north/, "cohere"],
  [/^lfm/, "liquid"],
  [/^nex-/, "nex-agi"],
  [/^step/, "stepfun"],
  [/^muse-spark|^big-pickle/, "opencode"],
  [/^minimax/, "minimax"],
  [/^mimo/, "xiaomi"],
  [/^granite/, "ibm"],
  [/^allam/, "sdaia"],
  [/^compound/, "groq"],
  [/^hy3|^hunyuan/, "tencent"],
  [/^longcat/, "meituan"],
  [/^trinity/, "arcee"],
  [/^dots/, "dots-studio"],
];

/**
 * Curated slug aliases for hosts that rename a model. Keyed by the normalized slug produced by
 * {@link normalizeSlug}; value is the canonical slug. Only add entries backed by provider docs.
 */
const SLUG_ALIASES: Record<string, string> = {
  // Cloudflare serves Nemotron 3 Super under its parameter-count name.
  "nemotron-3-120b-a12b": "nemotron-3-super-120b-a12b",
  // Cloudflare's dated DeepSeek v4 snapshots are the v4 flash/pro releases.
  "deepseek-v4-flash-0731": "deepseek-v4-flash",
  "deepseek-v4-pro-0813": "deepseek-v4-pro",
  // Groq / Cerebras / Cloudflare spell Qwen 3.8 differently.
  "qwen-3.8-27b": "qwen3.8-27b",
  "qwen-3.6-27b": "qwen3.6-27b",
  "gemma-4-31b-it": "gemma-4-31b",
  "gemma-4-26b-a4b-it": "gemma-4-26b-a4b",
  "gemma-4-26b-a4b-it-free": "gemma-4-26b-a4b",
  "gpt-oss-120b-high": "gpt-oss-120b",
  "laguna-s-2.1-free": "laguna-s-2.1",
  "laguna-xs-2.1-free": "laguna-xs-2.1",
  "nemotron-3.5-lightning-free": "nemotron-3.5-lightning",
  "nemotron-3-super-free": "nemotron-3-super-120b-a12b",
  "nemotron-3-ultra-free": "nemotron-3-ultra-550b-a55b",
  "glm-4.7-flash-free": "glm-4.7-flash",
  "glm-4.6v-flash-free": "glm-4.6v-flash",
  "kimi-k2.7-code-free": "kimi-k2.7-code",
  "deepseek-v4-flash-free": "deepseek-v4-flash",
  "north-mini-code-free": "north-mini-code",
};

const DISPLAY_NAMES: Record<string, string> = {
  "openai/gpt-oss-120b": "GPT-OSS 120B",
  "openai/gpt-oss-20b": "GPT-OSS 20B",
  "zai/glm-4.7-flash": "GLM-4.7 Flash",
  "zai/glm-4.5-flash": "GLM-4.5 Flash",
  "zai/glm-4.6v-flash": "GLM-4.6V Flash",
  "zai/glm-5.2": "GLM-5.2",
  "zai/glm-5.3": "GLM-5.3",
  "zai/glm-5.3-flash": "GLM-5.3 Flash",
  "qwen/qwen3.8-27b": "Qwen 3.8 27B",
  "qwen/qwen3.6-27b": "Qwen 3.6 27B",
  "qwen/qwen2.5-coder-32b-instruct": "Qwen 2.5 Coder 32B",
  "google/gemma-4-31b": "Gemma 4 31B",
  "google/gemma-4-26b-a4b": "Gemma 4 26B A4B",
  "nvidia/nemotron-3-super-120b-a12b": "Nemotron 3 Super",
  "nvidia/nemotron-3-ultra-550b-a55b": "Nemotron 3 Ultra",
  "nvidia/nemotron-3.5-lightning": "Nemotron 3.5 Lightning",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning": "Nemotron 3 Nano Omni",
  "poolside/laguna-s-2.1": "Laguna S 2.1",
  "poolside/laguna-xs-2.1": "Laguna XS 2.1",
  "poolside/laguna-m.1": "Laguna M.1",
  "moonshotai/kimi-k2.7-code": "Kimi K2.7 Code",
  "moonshotai/kimi-k2.6": "Kimi K2.6",
  "moonshotai/kimi-k3": "Kimi K3",
  "deepseek/deepseek-v4-flash": "DeepSeek V4 Flash",
  "deepseek/deepseek-v4-pro": "DeepSeek V4 Pro",
  "cohere/north-mini-code": "North Mini Code",
  "thinkingmachines/inkling": "Inkling",
  "thinkingmachines/inkling-small": "Inkling Small",
  "nex-agi/nex-n2.5-pro": "Nex N2.5 Pro",
  "nex-agi/nex-n2.5-mini": "Nex N2.5 Mini",
  "inclusionai/ling-3.0-flash-fin": "Ling 3.0 Flash Fin",
  "inclusionai/ling-3.0-flash-sante": "Ling 3.0 Flash Sante",
  "inclusionai/ling-3.0-flash-vl": "Ling 3.0 Flash VL",
  "liquid/lfm-2.5-2.6b": "LFM 2.5 2.6B",
  "dots-studio/dots-3-note-preview": "Dots3 Note Preview",
  "mistral/devstral-small-2512": "Devstral Small 2",
  "mistral/codestral-2508": "Codestral 25.08",
};

const FREE_VARIANT_RE = /(:free|-free|\(free\)|_free)$/i;

/** Lowercase, strip host prefixes and free-variant markers, unify separators. */
export function normalizeSlug(raw: string): { slug: string; freeVariant: boolean; labFromPath?: string } {
  let s = raw.trim();
  // Host-specific prefixes.
  s = s.replace(/^@cf\//i, "").replace(/^models\//i, "").replace(/^accounts\/[^/]+\/models\//i, "");
  // Gateway variant suffixes (":free", ":nitro", ":extended", ":exacto", ":thinking").
  let freeVariant = false;
  const variantMatch = s.match(/:([a-z0-9-]+)$/i);
  if (variantMatch) {
    if (variantMatch[1]!.toLowerCase() === "free") freeVariant = true;
    s = s.slice(0, -variantMatch[0].length);
  }
  s = s.toLowerCase();
  if (FREE_VARIANT_RE.test(s)) {
    freeVariant = true;
    s = s.replace(FREE_VARIANT_RE, "");
  }
  let labFromPath: string | undefined;
  const slash = s.lastIndexOf("/");
  if (slash > 0) {
    labFromPath = s.slice(0, slash);
    s = s.slice(slash + 1);
  }
  // Serving-precision suffixes are host details, not identity.
  s = s.replace(/-(fp8|fp16|bf16|int4|int8|awq|gptq)(-fast)?$/, "");
  s = s.replace(/-(instruct|it)$/, "");
  s = s.replace(/^labs-/, "");
  return { slug: s, freeVariant, labFromPath };
}

function labFor(slug: string, labFromPath: string | undefined, providerId: string): string {
  if (labFromPath) {
    const last = labFromPath.split("/").pop()!;
    return LAB_ALIASES[last] ?? last;
  }
  for (const [re, lab] of SLUG_LAB_HINTS) if (re.test(slug)) return lab;
  return providerId;
}

function familyFor(slug: string): string {
  const m = slug.match(/^([a-z]+(?:-oss)?)/);
  const head = m ? m[1]! : slug;
  if (head === "gpt" && slug.startsWith("gpt-oss")) return "gpt-oss";
  if (/^gemma/.test(slug)) return "gemma";
  if (/^gemini/.test(slug)) return "gemini";
  if (/^glm/.test(slug)) return "glm";
  if (/^qwen|^qwq/.test(slug)) return "qwen";
  if (/^nemotron/.test(slug)) return "nemotron";
  if (/^laguna/.test(slug)) return "laguna";
  if (/^kimi/.test(slug)) return "kimi";
  if (/^deepseek/.test(slug)) return "deepseek";
  if (/^devstral/.test(slug)) return "devstral";
  if (/^codestral/.test(slug)) return "codestral";
  if (/^mistral|^ministral|^magistral/.test(slug)) return "mistral";
  if (/^llama/.test(slug)) return "llama";
  if (/^claude/.test(slug)) return "claude";
  if (/^ling|^ring/.test(slug)) return "ling";
  if (/^inkling/.test(slug)) return "inkling";
  return head;
}

function titleCase(slug: string): string {
  return slug
    .split("-")
    .map((part) => (part.length <= 3 && /^[a-z0-9.]+$/.test(part) ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(" ");
}

/**
 * Resolve the canonical identity for a provider route. `displayName` (the provider's own label)
 * is only used as a fallback for the human name; identity is never derived from it.
 */
export function canonicalIdentityFor(providerId: string, providerModelId: string, providerDisplayName?: string): CanonicalIdentity {
  const { slug: rawSlug, freeVariant, labFromPath } = normalizeSlug(providerModelId);
  const slug = SLUG_ALIASES[rawSlug] ?? rawSlug;
  const lab = labFor(slug, labFromPath, providerId);
  const canonicalId = `${lab}/${slug}`;
  const family = familyFor(slug);
  const curated = DISPLAY_NAMES[canonicalId];
  const cleaned = providerDisplayName
    ? providerDisplayName
        .replace(/\s*\((free|Free|latest)\)\s*$/i, "")
        .replace(/\s+Free$/i, "")
        .replace(/^[A-Za-z0-9 .]+:\s+/, "")
        // Serving artifacts are route details, not model identity.
        .replace(/(fp8|fp16|bf16|int4|int8|awq|gptq|lora|fast|instruct|it)/gi, "")
        .replace(/\s{2,}/g, " ")
        .trim()
    : "";
  const displayName = curated ?? (cleaned.length > 0 && cleaned.toLowerCase() !== slug ? cleaned : titleCase(slug));
  return { canonicalId, lab, slug, family, displayName, freeVariant };
}

/** Group any route-like records by canonical id, preserving first-seen order. */
export function groupByCanonical<T extends { providerId: string; modelId: string; displayName?: string }>(
  routes: T[],
): Map<string, { identity: CanonicalIdentity; routes: T[] }> {
  const out = new Map<string, { identity: CanonicalIdentity; routes: T[] }>();
  for (const r of routes) {
    const identity = canonicalIdentityFor(r.providerId, r.modelId, r.displayName);
    const group = out.get(identity.canonicalId);
    if (group) group.routes.push(r);
    else out.set(identity.canonicalId, { identity, routes: [r] });
  }
  return out;
}

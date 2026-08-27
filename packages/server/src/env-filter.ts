/**
 * Deliberately constructed child-process environment.
 *
 * The host environment is NOT inherited wholesale. Sensitive variables are
 * removed so the model cannot learn secrets by inspecting `env`, and so
 * compromised child processes do not propagate CodeForge credentials.
 *
 * Unknown secret-bearing variables are best-effort filtered by pattern.
 * This filter is not a sandbox; it is a defense-in-depth layer.
 */

const SENSITIVE_EXACT_DENY = new Set<string>([
  "OPENCODE_API_KEY",
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "GROQ_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "NPM_TOKEN",
  "CODEFORGE_API_KEY",
  "HF_TOKEN",
  "HUGGINGFACE_API_KEY",
  "COHERE_API_KEY",
  "REPLICATE_API_TOKEN",
]);

const SENSITIVE_SUBSTRINGS = [
  "SECRET",
  "PASSWORD",
  "PRIVATE_KEY",
  "CREDENTIAL",
  "AUTH_TOKEN",
  "ACCESS_TOKEN",
  "REFRESH_TOKEN",
];

const SENSITIVE_PREFIXES = [
  "AWS_",
  "AZURE_",
  "GCP_",
  "GOOGLE_CREDENTIALS",
  "CLOUDFLARE_",
];

export function isSensitiveEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  if (SENSITIVE_EXACT_DENY.has(upper)) return true;
  for (const p of SENSITIVE_PREFIXES) {
    if (upper.startsWith(p)) return true;
  }
  for (const s of SENSITIVE_SUBSTRINGS) {
    if (upper.includes(s)) return true;
  }
  return false;
}

export function filterEnv(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue;
    if (isSensitiveEnvKey(k)) continue;
    out[k] = v;
  }
  return out;
}

export function getSanitizedEnvForChild(): NodeJS.ProcessEnv {
  return filterEnv(process.env);
}

export const KNOWN_SENSITIVE_KEYS = Array.from(SENSITIVE_EXACT_DENY);

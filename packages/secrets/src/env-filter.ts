/**
 * Deliberately constructed child-process environment.
 *
 * The host environment is NOT inherited wholesale by anything CodeForge spawns on behalf of an
 * agent, a workflow, or a repository (shell commands, git, verification commands). Sensitive
 * variables are removed so a model cannot learn secrets by inspecting `env`, so a malicious
 * repository hook or build script cannot read CodeForge control-plane credentials, and so a
 * compromised child process does not propagate them further.
 *
 * Unknown secret-bearing variables are best-effort filtered by pattern. This filter is not a
 * sandbox; it is one defense-in-depth layer (see docs/security/threat-model.md, "agent execution
 * plane"). The deny list is intentionally broad: a false positive costs a child process one
 * harmless variable, a false negative leaks a credential.
 */

const SENSITIVE_EXACT_DENY = new Set<string>([
  // Provider / model credentials
  "OPENCODE_API_KEY",
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "GROQ_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "ZHIPU_API_KEY",
  "ZAI_API_KEY",
  "CLOUDFLARE_API_KEY",
  "CLOUDFLARE_ACCOUNT_ID",
  "HF_TOKEN",
  "HUGGINGFACE_API_KEY",
  "COHERE_API_KEY",
  "REPLICATE_API_TOKEN",
  "CODEFORGE_API_KEY",
  // Source-control credentials
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_CLIENT_SECRET",
  "GITHUB_APP_PRIVATE_KEY",
  "NPM_TOKEN",
  "NODE_AUTH_TOKEN",
  "NPM_CONFIG__AUTH",
  "NPM_CONFIG__AUTHTOKEN",
  // CodeForge Cloud control plane
  "JWT_SECRET",
  "DATABASE_URL",
  "CODEFORGE_DATA_ENCRYPTION_KEYS",
  "CODEFORGE_DATA_ENCRYPTION_ACTIVE_KEY",
  "CODEFORGE_LOCAL_CONTROL_TOKEN",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  // Database client credentials
  "PGPASSWORD",
  "PGPASSFILE",
  "PGSERVICE",
  "PGSSLKEY",
  "MYSQL_PWD",
  "REDIS_URL",
  "MONGODB_URI",
  "MONGO_URL",
]);

const SENSITIVE_SUBSTRINGS = [
  "SECRET",
  "PASSWORD",
  "PASSWD",
  "PRIVATE_KEY",
  "CREDENTIAL",
  "AUTH_TOKEN",
  "ACCESS_TOKEN",
  "REFRESH_TOKEN",
  "API_KEY",
  "APIKEY",
  "ENCRYPTION_KEY",
  "SIGNING_KEY",
  "TOKEN",
  "_DSN",
  "CONNECTION_STRING",
];

const SENSITIVE_PREFIXES = [
  "AWS_",
  "AZURE_",
  "GCP_",
  "GOOGLE_",
  "CLOUDFLARE_",
  "OPENAI_",
  "ANTHROPIC_",
  "GROQ_",
  "OPENROUTER_",
  "OPENCODE_",
  "SUPABASE_",
  "STRIPE_",
  "VAULT_",
  "DOPPLER_",
  "SENTRY_",
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

export function filterEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
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

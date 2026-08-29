/**
 * Redact secrets from text before it is surfaced in errors/logs. Providers sometimes echo the
 * API key back in error bodies (e.g. Google's 403 includes `api_key:AIza...`), so we strip both
 * the exact known key and common credential patterns.
 */
const PATTERNS: RegExp[] = [
  /AIza[0-9A-Za-z_-]{20,}/g, // Google API keys
  /sk-or-v1-[A-Za-z0-9]{16,}/g, // OpenRouter keys
  /sk-[A-Za-z0-9_-]{16,}/g, // OpenAI-style keys
  /\bBearer\s+[A-Za-z0-9._-]{16,}/gi, // Bearer tokens
  /gsk_[A-Za-z0-9]{16,}/g, // Groq keys
];

export function redactSecrets(text: string, exactKey?: string): string {
  let out = text;
  if (exactKey && exactKey.length >= 8) {
    // Escape regex metacharacters in the literal key before global replace.
    const escaped = exactKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(escaped, "g"), "***");
  }
  for (const re of PATTERNS) out = out.replace(re, "***");
  return out;
}

// qualification-fixtures/code-understanding/token-validator.ts
// Small module with deterministic behavior for code understanding test

export interface Token {
  value: string;
  expiresAt: number;
  scopes: string[];
}

export function validateToken(token: Token, requiredScope: string, now: number = Date.now()): boolean {
  if (!token) return false;
  if (now > token.expiresAt) return false;
  if (!token.scopes.includes(requiredScope)) return false;
  return true;
}

export function createToken(value: string, ttlMs: number, scopes: string[]): Token {
  return {
    value,
    expiresAt: Date.now() + ttlMs,
    scopes,
  };
}

export function parseToken(raw: string): Token | null {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed.value || !parsed.expiresAt || !Array.isArray(parsed.scopes)) {
      return null;
    }
    return parsed as Token;
  } catch {
    return null;
  }
}

// Only this function validates tokens - the question is deterministic
export { validateToken as theValidator };
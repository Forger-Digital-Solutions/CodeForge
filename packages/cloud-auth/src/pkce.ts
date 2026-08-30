import { createHash, randomBytes } from "node:crypto";

export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
  method: "S256";
}

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function generatePkcePair(verifierLength = 64): PkcePair {
  const bytes = randomBytes(verifierLength);
  const codeVerifier = base64UrlEncode(bytes).slice(0, Math.min(128, Math.max(43, verifierLength)));
  const hash = createHash("sha256").update(codeVerifier).digest();
  const codeChallenge = base64UrlEncode(hash);
  return { codeVerifier, codeChallenge, method: "S256" };
}

export function generateState(): string {
  return base64UrlEncode(randomBytes(32));
}

export function verifyPkce(verifier: string, challenge: string): boolean {
  if (!verifier || !challenge) return false;
  const hash = createHash("sha256").update(verifier).digest();
  const expected = base64UrlEncode(hash);
  return expected === challenge;
}

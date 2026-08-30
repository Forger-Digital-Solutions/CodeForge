import { createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";

export interface AccessTokenPayload {
  sub: string; // userId
  sid: string; // deviceSessionId
  planId?: string;
  displayName?: string;
  iat: number;
  exp: number;
  iss: string;
}

function base64UrlEncode(strOrBuf: string | Buffer): string {
  const buf = typeof strOrBuf === "string" ? Buffer.from(strOrBuf, "utf8") : strOrBuf;
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlDecode(str: string): string {
  let b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4 !== 0) b64 += "=";
  return Buffer.from(b64, "base64").toString("utf8");
}

export function signAccessToken(
  payload: Omit<AccessTokenPayload, "iat" | "exp" | "iss">,
  secret: string,
  expiresInSeconds = 3600, // 1 hour access token
  issuer = "codeforge-cloud",
): string {
  if (!secret || secret.length < 16) {
    throw new Error("JWT secret must be at least 16 characters long.");
  }
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload: AccessTokenPayload = {
    ...payload,
    iat: now,
    exp: now + expiresInSeconds,
    iss: issuer,
  };

  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(fullPayload));
  const signatureInput = `${headerB64}.${payloadB64}`;
  const signature = createHmac("sha256", secret).update(signatureInput).digest();
  const signatureB64 = base64UrlEncode(signature);

  return `${signatureInput}.${signatureB64}`;
}

export function verifyAccessToken(token: string, secret: string, issuer = "codeforge-cloud"): AccessTokenPayload {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid JWT token format");
  }

  const headerB64 = parts[0];
  const payloadB64 = parts[1];
  const signatureB64 = parts[2];
  if (!headerB64 || !payloadB64 || !signatureB64) {
    throw new Error("Invalid JWT token structure");
  }

  let header: { alg?: string; typ?: string };
  try {
    header = JSON.parse(base64UrlDecode(headerB64));
  } catch {
    throw new Error("Invalid JWT header encoding");
  }

  if (header.alg !== "HS256") {
    throw new Error(`Unsupported JWT algorithm: ${header.alg}. HS256 required.`);
  }

  const signatureInput = `${headerB64}.${payloadB64}`;
  const expectedSignature = createHmac("sha256", secret).update(signatureInput).digest();
  const expectedSignatureB64 = base64UrlEncode(expectedSignature);

  // Timing safe signature verification
  const sigBuf = Buffer.from(signatureB64, "utf8");
  const expBuf = Buffer.from(expectedSignatureB64, "utf8");
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    throw new Error("Invalid JWT signature");
  }

  let payload: AccessTokenPayload;
  try {
    payload = JSON.parse(base64UrlDecode(payloadB64)) as AccessTokenPayload;
  } catch {
    throw new Error("Invalid JWT payload encoding");
  }

  if (!payload.sub) {
    throw new Error("JWT payload missing required subject (sub)");
  }
  if (!payload.sid) {
    throw new Error("JWT payload missing required session id (sid)");
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) {
    throw new Error("JWT token has expired");
  }
  if (payload.iss && payload.iss !== issuer) {
    throw new Error(`Invalid JWT issuer: ${payload.iss}`);
  }

  return payload;
}

export function generateRefreshToken(): string {
  return `cfr_${base64UrlEncode(randomBytes(48))}`;
}

export function hashRefreshToken(refreshToken: string): string {
  return createHash("sha256").update(refreshToken).digest("hex");
}

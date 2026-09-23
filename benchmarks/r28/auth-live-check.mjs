// R28 authentication live check — exercises the real cloud-auth crypto lifecycle:
// PKCE S256 correctness + uniqueness, JWT sign/verify round-trip and every hostile
// variant (tampered sig, wrong secret, alg confusion, expired, malformed, missing
// claims), desktop auth codes, browser session tokens.
//
//   node benchmarks/r28/auth-live-check.mjs
import { createHash, createHmac } from "node:crypto";
import fs from "node:fs";
import {
  generatePkcePair, generateState, verifyPkce,
  signAccessToken, verifyAccessToken, generateRefreshToken, hashRefreshToken,
  generateDesktopAuthCode, hashDesktopAuthCode, isDesktopAuthCode,
  generateBrowserSessionToken, hashBrowserSessionToken,
} from "@codeforge/cloud-auth";

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + String(detail).slice(0, 150) : ""}`); };
const throws = (fn) => { try { fn(); return null; } catch (e) { return e instanceof Error ? e.message : String(e); } };
const b64u = (s) => Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// ---- PKCE -------------------------------------------------------------------------
const pair = generatePkcePair();
const expectedChallenge = createHash("sha256").update(pair.codeVerifier).digest("base64")
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
check("PKCE challenge is real S256 of verifier", pair.codeChallenge === expectedChallenge && pair.method === "S256", "");
check("verifyPkce accepts correct pair", verifyPkce(pair.codeVerifier, pair.codeChallenge) === true, "");
check("verifyPkce rejects wrong verifier", verifyPkce("wrong-verifier", pair.codeChallenge) === false, "");
const states = new Set(Array.from({ length: 200 }, () => generateState()));
check("state entropy (200 unique)", states.size === 200, `${states.size}/200`);
const pairs = new Set(Array.from({ length: 100 }, () => generatePkcePair().codeVerifier));
check("verifier entropy (100 unique)", pairs.size === 100, "");

// ---- JWT lifecycle ------------------------------------------------------------------
const secret = "r28-live-check-secret-0123456789";
const token = signAccessToken({ sub: "user-1", sid: "sess-1", displayName: "R28" }, secret, 3600);
const verified = verifyAccessToken(token, secret);
check("JWT round-trip verifies", verified.sub === "user-1" && verified.sid === "sess-1" && verified.iss === "codeforge-cloud", "");

const [h, p] = token.split(".");
const tampered = `${h}.${p}.${"A".repeat(43)}`;
check("tampered signature rejected", throws(() => verifyAccessToken(tampered, secret))?.includes("signature"), throws(() => verifyAccessToken(tampered, secret)));
check("wrong secret rejected", throws(() => verifyAccessToken(token, "different-secret-987654321"))?.includes("signature"), "");
const payload = JSON.parse(Buffer.from(p.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
payload.sub = "attacker";
const forgedP = b64u(JSON.stringify(payload));
check("forged payload rejected", throws(() => verifyAccessToken(`${h}.${forgedP}.${token.split(".")[2]}`, secret)) !== null, "");

const noneAlg = `${b64u(JSON.stringify({ alg: "none", typ: "JWT" }))}.${p}.`;
check("alg=none rejected", throws(() => verifyAccessToken(noneAlg, secret)) !== null, throws(() => verifyAccessToken(noneAlg, secret)));
const rsAlg = `${b64u(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${p}.AAAA`;
check("alg confusion (RS256) rejected", throws(() => verifyAccessToken(rsAlg, secret))?.includes("HS256"), "");

const expired = signAccessToken({ sub: "u", sid: "s" }, secret, -60);
check("expired token rejected", throws(() => verifyAccessToken(expired, secret)) !== null, throws(() => verifyAccessToken(expired, secret)));
for (const bad of ["", "a.b", "a.b.c.d", "!!.@@.##", token.slice(0, -10)]) {
  check(`malformed ${JSON.stringify(bad.slice(0, 16))} rejected`, throws(() => verifyAccessToken(bad, secret)) !== null, "");
}
const noSub = signAccessToken({ sub: "", sid: "s" }, secret, 3600);
check("missing sub rejected", throws(() => verifyAccessToken(noSub, secret))?.includes("sub"), "");
check("short secret refused at signing", throws(() => signAccessToken({ sub: "u", sid: "s" }, "short")) !== null, "");
const wrongIss = verifyAccessTokenThrows => { const t = signAccessToken({ sub: "u", sid: "s" }, secret, 3600, "evil-issuer"); return throws(() => verifyAccessToken(t, secret)); };
check("wrong issuer rejected", wrongIss() !== null, wrongIss());

// ---- Refresh/desktop/browser tokens ---------------------------------------------------
const rt1 = generateRefreshToken(), rt2 = generateRefreshToken();
check("refresh tokens unique", rt1 !== rt2 && rt1.length >= 32, "");
check("refresh hash deterministic + salted-proof", hashRefreshToken(rt1) === hashRefreshToken(rt1) && hashRefreshToken(rt1) !== hashRefreshToken(rt2), "");
const dac = generateDesktopAuthCode();
check("desktop auth code recognized", isDesktopAuthCode(dac) === true, "");
check("desktop auth code hash stable", hashDesktopAuthCode(dac) === hashDesktopAuthCode(dac), "");
check("random string not an auth code", isDesktopAuthCode("not-a-code") === false, "");
const bst = generateBrowserSessionToken();
check("browser session token hashed", hashBrowserSessionToken(bst) !== bst && hashBrowserSessionToken(bst).length === 64, "");

const passed = results.filter((r) => r.ok).length;
console.log(`\nAUTH_LIVE_CHECK ${passed}/${results.length} PASS`);
fs.writeFileSync("docs/evidence/r28-capability-completion/R28-AUTH-LIVE-EVIDENCE.json", JSON.stringify({
  schema: "r28-auth-live-check-1",
  recordedAt: new Date().toISOString(),
  surface: "real @codeforge/cloud-auth crypto — PKCE S256, HS256 JWT lifecycle + hostile inputs, refresh/desktop/browser token mint+hash",
  note: "Full OAuth browser dance + cloud sign-in against the real hosted service is not exercised here; this proves the on-device cryptographic lifecycle and rejection behavior.",
  results,
}, null, 2) + "\n");
process.exit(passed === results.length ? 0 : 1);

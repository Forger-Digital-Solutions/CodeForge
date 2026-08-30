import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { CloudDatabase } from "@codeforge/cloud-db";
import { CodeForgeCloudServer } from "codeforge-cloud-api";
import { signAccessToken } from "@codeforge/cloud-auth";
import { createMockGitHubFetch, loginToCloud } from "./helpers/cloud-login.js";

/**
 * PRODUCTION IDENTITY-BYPASS GUARD.
 *
 * Test suites legitimately need to construct authenticated state; production request surfaces must
 * never let a caller do the same. The gap between those two facts is where an auth bypass gets
 * reintroduced — usually as a convenience header or a "just for local dev" body field that quietly
 * ships.
 *
 * This suite closes it from both directions:
 *   1. BEHAVIORAL — every known bypass shape is fired at the live HTTP surface and must be refused.
 *   2. STRUCTURAL — production source (`src/`, excluding tests) is scanned for bypass identifiers, so
 *      reintroducing one fails CI at the point it is written rather than at the next audit.
 *
 * Dependency injection stays allowed: a test may pass a database or a fetch into a constructor. What
 * is forbidden is a REQUEST being able to assert who it is.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

/** Identifiers that, in production source, would indicate an identity bypass hook. */
const BYPASS_IDENTIFIERS = [
  "mockProfile",
  "mockUser",
  "mockAuth",
  "fakeAuth",
  "testAuth",
  "devAuth",
  "skipAuth",
  "bypassAuth",
  "fixtureAuth",
  "impersonate",
  "assumeUser",
  "x-test-user",
  "x-debug-user",
  "x-mock-user",
  "X-Test-Auth",
  "X-Debug-Auth",
  "X-Mock-Auth",
];

/** Production source trees whose request handling must be free of bypass hooks. */
const PRODUCTION_SOURCE_ROOTS = [
  "apps/cloud-api/src",
  "packages/cloud-auth/src",
  "packages/cloud-db/src",
  "packages/cloud-entitlements/src",
  "packages/cloud-usage/src",
  "packages/cloud-billing/src",
  "packages/cloud-gateway/src",
];

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === "node_modules" || entry === "dist" || entry === "test" || entry === "__tests__") continue;
      out.push(...collectSourceFiles(full));
    } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry) && !/\.test\.[tj]sx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("Production identity-bypass guard", () => {
  describe("structural: production source contains no bypass hooks", () => {
    it("has no identity-bypass identifiers in cloud production source", () => {
      const offenders: string[] = [];

      for (const root of PRODUCTION_SOURCE_ROOTS) {
        for (const file of collectSourceFiles(resolve(repoRoot, root))) {
          const contents = readFileSync(file, "utf8");
          for (const identifier of BYPASS_IDENTIFIERS) {
            // Case-insensitive: `SkipAuth`, `skipauth`, and `skip_auth` are all the same mistake.
            const pattern = new RegExp(identifier.replace(/[-]/g, "[-_]?"), "i");
            if (pattern.test(contents)) {
              offenders.push(`${relative(repoRoot, file).split(sep).join("/")}: ${identifier}`);
            }
          }
        }
      }

      expect(offenders, `identity-bypass hooks found in production source:\n${offenders.join("\n")}`).toEqual([]);
    });

    it("scans a non-trivial number of production files (the guard is not silently vacuous)", () => {
      const total = PRODUCTION_SOURCE_ROOTS.reduce((acc, root) => acc + collectSourceFiles(resolve(repoRoot, root)).length, 0);
      // If a refactor moves these trees, the scan above would pass by scanning nothing. This makes
      // that failure loud instead of invisible.
      expect(total).toBeGreaterThanOrEqual(15);
    });

    it("detects a bypass identifier when one is present (the matcher actually works)", () => {
      // Negative control for the scanner itself.
      const sample = "function handler(req){ if (req.headers['x-test-user']) return req.headers['x-test-user']; }";
      const matched = BYPASS_IDENTIFIERS.some((id) => new RegExp(id.replace(/[-]/g, "[-_]?"), "i").test(sample));
      expect(matched).toBe(true);
    });
  });

  describe("behavioral: the live HTTP surface refuses every bypass shape", () => {
    let server: CodeForgeCloudServer;
    let baseUrl: string;
    const jwtSecret = "bypass-guard-cert-jwt-secret-32-characters";

    beforeEach(async () => {
      server = new CodeForgeCloudServer({
        db: new CloudDatabase({ dbPath: ":memory:" }),
        jwtSecret,
        fetchFn: createMockGitHubFetch({ id: 989898, login: "guard_user", name: "Guard User" }),
      });
      const port = await server.start(0);
      baseUrl = `http://127.0.0.1:${port}`;
    });

    afterEach(async () => {
      await server.stop();
    });

    it("refuses every header-based identity assertion on authenticated endpoints", async () => {
      const hostileHeaders: Array<Record<string, string>> = [
        { "X-Test-User": "victim-user-id" },
        { "X-Debug-User": "victim-user-id" },
        { "X-Mock-User": "victim-user-id" },
        { "X-Test-Auth": "1" },
        { "X-Debug-Auth": "1" },
        { "X-Mock-Auth": "1" },
        { "X-User-Id": "victim-user-id" },
        { "X-Impersonate": "victim-user-id" },
        { "X-Assume-User": "victim-user-id" },
        { "X-Forwarded-User": "victim-user-id" },
        { "X-Skip-Auth": "true" },
        { "X-Bypass-Auth": "true" },
      ];

      for (const headers of hostileHeaders) {
        for (const path of ["/v1/account", "/v1/usage"]) {
          const res = await fetch(`${baseUrl}${path}`, { headers });
          expect(res.status, `${path} with ${JSON.stringify(headers)}`).toBe(401);
          expect(await res.text()).not.toContain("creditBalance");
        }
      }
    });

    it("refuses every body-based identity assertion on hosted inference", async () => {
      const hostileBodies = [
        { userId: "victim-user-id" },
        { sub: "victim-user-id" },
        { mockProfile: { id: 1, login: "torvalds" } },
        { mockUser: { id: "victim-user-id" } },
        { skipAuth: true },
        { bypassAuth: true },
        { devAuth: true },
        { impersonate: "victim-user-id" },
        { assumeUser: "victim-user-id" },
      ];

      for (const extra of hostileBodies) {
        const res = await fetch(`${baseUrl}/v1/hosted/inference`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requestId: randomUUID(), messages: [{ role: "user", content: "hi" }], ...extra }),
        });
        expect(res.status, JSON.stringify(extra)).toBe(401);
      }

      // No account was conjured into existence by any of those attempts.
      expect(await server.db.getUserById("victim-user-id")).toBeUndefined();
      expect(await server.db.getUserByPrimaryIdentity("github:1")).toBeUndefined();
    });

    it("refuses tokens that are unsigned, wrongly signed, or use the 'none' algorithm", async () => {
      const real = await loginToCloud(baseUrl);

      const forged = [
        // alg:none
        `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${Buffer.from(
          JSON.stringify({ sub: real.user.id, sid: "x", exp: Math.floor(Date.now() / 1000) + 3600, iss: "codeforge-cloud" }),
        ).toString("base64url")}.`,
        // Correct shape, wrong secret.
        signAccessToken({ sub: real.user.id, sid: "forged-session" }, "an-entirely-different-secret-32-chars!!"),
        // Structurally invalid.
        "not.a.jwt",
        "",
      ];

      for (const token of forged) {
        const res = await fetch(`${baseUrl}/v1/account`, { headers: { Authorization: `Bearer ${token}` } });
        expect(res.status, `forged token: ${token.slice(0, 24)}`).toBe(401);
      }

      // The genuine token still works — the endpoint is refusing forgeries, not everything.
      const ok = await fetch(`${baseUrl}/v1/account`, { headers: { Authorization: `Bearer ${real.accessToken}` } });
      expect(ok.status).toBe(200);
    });

    it("does not accept a token as a query parameter or cookie", async () => {
      const real = await loginToCloud(baseUrl);

      const viaQuery = await fetch(`${baseUrl}/v1/account?access_token=${encodeURIComponent(real.accessToken)}`);
      expect(viaQuery.status).toBe(401);

      const viaCookie = await fetch(`${baseUrl}/v1/account`, { headers: { Cookie: `access_token=${real.accessToken}` } });
      expect(viaCookie.status).toBe(401);
    });

    it("ignores a client-asserted identity even when a VALID token is also present", async () => {
      const real = await loginToCloud(baseUrl);
      const victim = await server.db.createUser({ displayName: "Victim", primaryIdentity: `github:victim-${randomUUID()}` });

      const res = await fetch(`${baseUrl}/v1/account`, {
        headers: {
          Authorization: `Bearer ${real.accessToken}`,
          "X-User-Id": victim.id,
          "X-Impersonate": victim.id,
        },
      });
      expect(res.status).toBe(200);
      // The token's subject wins; the header is not consulted at all.
      expect((await res.json()).user.id).toBe(real.user.id);
    });
  });
});

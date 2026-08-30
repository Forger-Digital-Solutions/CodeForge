import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveCloudEndpoint,
  parseCloudEndpointManifest,
  assertValidCloudUrl,
  describeCloudEndpoint,
  CloudEndpointError,
  DEFAULT_DEVELOPMENT_CLOUD_URL,
  type CloudEndpointManifest,
} from "../src/cloud-endpoint.js";

/**
 * The desktop's Cloud endpoint decides which server sees a user's OAuth flow, holds their session,
 * and reports their balance. These tests pin the rules that keep that decision out of reach of the
 * renderer, of the user, and — in a release build — of the environment.
 */

const here = dirname(fileURLToPath(import.meta.url));

const PRODUCTION_MANIFEST: CloudEndpointManifest = {
  channel: "production",
  endpoints: { production: "https://cloud.codeforge.dev", staging: "https://staging.codeforge.dev", development: "http://127.0.0.1:3220" },
};
const STAGING_MANIFEST: CloudEndpointManifest = {
  channel: "staging",
  endpoints: { staging: "https://staging.codeforge.dev" },
};
const DEV_MANIFEST: CloudEndpointManifest = {
  channel: "development",
  endpoints: { development: "http://127.0.0.1:3220" },
};

const HOSTILE_OVERRIDE = { CODEFORGE_CLOUD_URL: "https://attacker.example" };

describe("desktop Cloud endpoint resolution", () => {
  describe("release builds use the build manifest and ignore the environment", () => {
    it("a packaged production build uses the production endpoint", () => {
      const resolved = resolveCloudEndpoint({ manifest: PRODUCTION_MANIFEST, env: {}, isPackaged: true });
      expect(resolved.url).toBe("https://cloud.codeforge.dev");
      expect(resolved.channel).toBe("production");
      expect(resolved.overridden).toBe(false);
    });

    it("a packaged staging build uses the staging endpoint", () => {
      const resolved = resolveCloudEndpoint({ manifest: STAGING_MANIFEST, env: {}, isPackaged: true });
      expect(resolved.url).toBe("https://staging.codeforge.dev");
      expect(resolved.channel).toBe("staging");
    });

    it("IGNORES an environment override in a packaged production build", () => {
      const resolved = resolveCloudEndpoint({ manifest: PRODUCTION_MANIFEST, env: HOSTILE_OVERRIDE, isPackaged: true });
      expect(resolved.url).toBe("https://cloud.codeforge.dev");
      expect(resolved.overridden).toBe(false);
      expect(resolved.overrideReason).toContain("IGNORED");
    });

    it("IGNORES an environment override in a packaged staging build", () => {
      const resolved = resolveCloudEndpoint({ manifest: STAGING_MANIFEST, env: HOSTILE_OVERRIDE, isPackaged: true });
      expect(resolved.url).toBe("https://staging.codeforge.dev");
      expect(resolved.overridden).toBe(false);
    });

    it("IGNORES an override even on an unpackaged production/staging build", () => {
      // Running a production-channel build from source is still a production-channel build.
      for (const manifest of [PRODUCTION_MANIFEST, STAGING_MANIFEST]) {
        const resolved = resolveCloudEndpoint({ manifest, env: HOSTILE_OVERRIDE, isPackaged: false });
        expect(resolved.overridden).toBe(false);
        expect(resolved.url).not.toContain("attacker.example");
      }
    });

    it("ignores both override variable names", () => {
      const resolved = resolveCloudEndpoint({
        manifest: PRODUCTION_MANIFEST,
        env: { CODEFORGE_CLOUD_API_URL: "https://attacker.example", CODEFORGE_CLOUD_URL: "https://attacker.example" },
        isPackaged: true,
      });
      expect(resolved.url).toBe("https://cloud.codeforge.dev");
    });
  });

  describe("release builds fail closed rather than guessing", () => {
    it("REFUSES to start a production build with no configured endpoint", () => {
      expect(() => resolveCloudEndpoint({ manifest: { channel: "production", endpoints: {} }, env: {}, isPackaged: true })).toThrow(CloudEndpointError);
      // Specifically: it must not silently fall back to loopback.
      expect(() => resolveCloudEndpoint({ manifest: { channel: "production", endpoints: {} }, env: {}, isPackaged: true })).toThrow(/refusing to fall back/i);
    });

    it("REFUSES to start a staging build with no configured endpoint", () => {
      expect(() => resolveCloudEndpoint({ manifest: { channel: "staging", endpoints: {} }, env: {}, isPackaged: true })).toThrow(CloudEndpointError);
    });

    it("REFUSES a non-HTTPS endpoint on a release channel", () => {
      expect(() =>
        resolveCloudEndpoint({ manifest: { channel: "production", endpoints: { production: "http://cloud.codeforge.dev" } }, env: {}, isPackaged: true }),
      ).toThrow(/HTTPS/);
      expect(() =>
        resolveCloudEndpoint({ manifest: { channel: "staging", endpoints: { staging: "http://127.0.0.1:3220" } }, env: {}, isPackaged: true }),
      ).toThrow(/HTTPS/);
    });
  });

  describe("development keeps the developer override", () => {
    it("defaults to loopback", () => {
      expect(resolveCloudEndpoint({ manifest: DEV_MANIFEST, env: {}, isPackaged: false }).url).toBe(DEFAULT_DEVELOPMENT_CLOUD_URL);
      expect(resolveCloudEndpoint({ manifest: { channel: "development", endpoints: {} }, env: {}, isPackaged: false }).url).toBe(
        DEFAULT_DEVELOPMENT_CLOUD_URL,
      );
    });

    it("honors an override when running unpackaged", () => {
      const resolved = resolveCloudEndpoint({
        manifest: DEV_MANIFEST,
        env: { CODEFORGE_CLOUD_URL: "http://127.0.0.1:4444" },
        isPackaged: false,
      });
      expect(resolved.url).toBe("http://127.0.0.1:4444");
      expect(resolved.overridden).toBe(true);
    });

    it("stops honoring the override the moment the app is packaged", () => {
      const resolved = resolveCloudEndpoint({
        manifest: DEV_MANIFEST,
        env: { CODEFORGE_CLOUD_URL: "http://127.0.0.1:4444" },
        isPackaged: true,
      });
      expect(resolved.overridden).toBe(false);
      expect(resolved.url).toBe("http://127.0.0.1:3220");
    });

    it("still validates a development override", () => {
      expect(() =>
        resolveCloudEndpoint({ manifest: DEV_MANIFEST, env: { CODEFORGE_CLOUD_URL: "not-a-url" }, isPackaged: false }),
      ).toThrow(CloudEndpointError);
      // Plain http to a NON-loopback host is refused even in development.
      expect(() =>
        resolveCloudEndpoint({ manifest: DEV_MANIFEST, env: { CODEFORGE_CLOUD_URL: "http://attacker.example" }, isPackaged: false }),
      ).toThrow(/HTTPS/);
    });
  });

  describe("URL validation", () => {
    it("accepts HTTPS on every channel and normalizes trailing slashes", () => {
      expect(assertValidCloudUrl("https://cloud.example.com/", "production")).toBe("https://cloud.example.com");
      expect(assertValidCloudUrl("https://cloud.example.com", "staging")).toBe("https://cloud.example.com");
    });

    it("rejects credentials, query strings, and fragments", () => {
      expect(() => assertValidCloudUrl("https://u:p@cloud.example.com", "production")).toThrow(/credentials/);
      expect(() => assertValidCloudUrl("https://cloud.example.com/?x=1", "production")).toThrow(/query string/);
      expect(() => assertValidCloudUrl("https://cloud.example.com/#f", "production")).toThrow(/fragment/);
    });
  });

  describe("manifest parsing", () => {
    it("rejects a malformed manifest instead of guessing", () => {
      expect(() => parseCloudEndpointManifest(null)).toThrow(CloudEndpointError);
      expect(() => parseCloudEndpointManifest({})).toThrow(/invalid channel/i);
      expect(() => parseCloudEndpointManifest({ channel: "prod" })).toThrow(/invalid channel/i);
      expect(() => parseCloudEndpointManifest({ channel: "production", endpoints: "nope" })).toThrow(/endpoints/);
    });

    it("ignores unknown channel keys in endpoints", () => {
      const manifest = parseCloudEndpointManifest({
        channel: "production",
        endpoints: { production: "https://cloud.example.com", bogus: "https://evil.example" },
      });
      expect(manifest.endpoints).toEqual({ production: "https://cloud.example.com" });
    });

    it("parses the committed repository manifest", () => {
      const raw = JSON.parse(readFileSync(resolve(here, "..", "cloud-endpoints.json"), "utf8"));
      const manifest = parseCloudEndpointManifest(raw);
      // The committed manifest is a DEVELOPMENT manifest: a release build's packaging step rewrites
      // it. Committing a production channel with no endpoint would fail every developer's startup.
      expect(manifest.channel).toBe("development");
      const resolved = resolveCloudEndpoint({ manifest, env: {}, isPackaged: false });
      expect(resolved.url).toBe(DEFAULT_DEVELOPMENT_CLOUD_URL);
    });
  });

  describe("the renderer has no way to supply a Cloud URL at all", () => {
    // The strongest form of the guarantee is structural: not "the renderer's URL is ignored" but
    // "there is no channel through which a renderer could send one". These assertions fail the
    // moment someone adds a parameter to a Cloud IPC channel.
    const preloadSource = readFileSync(resolve(here, "..", "src", "preload.ts"), "utf8");
    const mainSource = readFileSync(resolve(here, "..", "src", "main.ts"), "utf8");

    it("exposes no preload Cloud API that forwards an argument", () => {
      const cloudInvocations = [...preloadSource.matchAll(/ipcRenderer\.invoke\(\s*"(cloud:[^"]+)"([^)]*)\)/g)];
      expect(cloudInvocations.length, "expected the preload to expose Cloud channels").toBeGreaterThan(0);

      for (const [, channel, extraArgs] of cloudInvocations) {
        expect(extraArgs.trim(), `preload channel '${channel}' forwards an argument to the main process`).toBe("");
      }
    });

    it("registers no main-process Cloud IPC handler that reads a request payload", () => {
      const handlers = [...mainSource.matchAll(/ipcMain\.handle\(\s*"(cloud:[^"]+)"\s*,\s*async\s*\(([^)]*)\)/g)];
      expect(handlers.length, "expected main to register Cloud IPC handlers").toBeGreaterThan(0);

      for (const [, channel, params] of handlers) {
        // A zero-argument handler cannot be influenced by the renderer, even by a compromised one.
        expect(params.trim(), `Cloud IPC handler '${channel}' accepts renderer-supplied arguments`).toBe("");
      }
    });

    it("resolves the endpoint exactly once, from the manifest, in the main process", () => {
      expect(mainSource).toContain("resolveCloudEndpoint({");
      expect(mainSource).toContain("const CLOUD_API_URL = RESOLVED_CLOUD_ENDPOINT.url;");
      // No other assignment may reintroduce an environment-derived endpoint.
      const cloudUrlAssignments = [...mainSource.matchAll(/const\s+CLOUD_API_URL\s*=/g)];
      expect(cloudUrlAssignments).toHaveLength(1);
      expect(mainSource).not.toMatch(/CLOUD_API_URL\s*=\s*.*process\.env/);
    });
  });

  it("describes the resolution in a log-safe line", () => {
    const line = describeCloudEndpoint(resolveCloudEndpoint({ manifest: PRODUCTION_MANIFEST, env: HOSTILE_OVERRIDE, isPackaged: true }));
    expect(line).toContain("channel=production");
    expect(line).toContain("cloud=https://cloud.codeforge.dev");
    expect(line).not.toContain("attacker.example");
  });
});

/**
 * CodeForge extension manifest — the contract every extension must satisfy before a single byte
 * of its code is evaluated. Validation is structural (zod) plus policy: ids are namespaced,
 * `main` cannot escape the extension folder, and `engines.codeforge` gates incompatible builds.
 *
 * This module is pure: no fs, no node imports beyond types — safe from main, tests, and docs.
 */
import { z } from "zod";

export const EXTENSION_MANIFEST_FILENAME = "codeforge-extension.json";

/** publisher.name — lowercase, dot-separated, no path characters. */
const ExtensionIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/, "Extension id must be namespaced like 'publisher.name'");

const SemverSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "Version must be semver (x.y.z)");

/**
 * `engines.codeforge` — `*` (any), `>=x.y.z`, or `^x.y.z` (same major, at least that version).
 * Kept deliberately small; full semver ranges are overkill for a foundation.
 */
const EngineRangeSchema = z.string().regex(/^(\*|>=\d+\.\d+\.\d+|\^\d+\.\d+\.\d+)$/, "engines.codeforge must be '*', '>=x.y.z', or '^x.y.z'");

export const ExtensionPermissionSchema = z.enum([
  "settings:read",
  "settings:write",
  "commands:register",
  "workspace:read",
  "notifications:show",
  "secrets:read",
]);
export type ExtensionPermission = z.infer<typeof ExtensionPermissionSchema>;

const CommandContributionSchema = z.object({
  /** Command id, namespaced under the extension (e.g. "hello.sayHi"). */
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/i).max(120),
  title: z.string().min(1).max(120),
});

const SettingContributionSchema = z.object({
  key: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i).max(80),
  type: z.enum(["boolean", "string", "enum"]),
  label: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  default: z.union([z.boolean(), z.string()]).optional(),
  options: z.array(z.string().min(1).max(80)).max(50).optional(),
}).refine(
  (s) => s.type !== "enum" || (Array.isArray(s.options) && s.options.length > 0),
  { message: "enum settings must declare options" },
);

export const ExtensionManifestSchema = z
  .object({
    id: ExtensionIdSchema,
    name: z.string().min(1).max(100),
    version: SemverSchema,
    description: z.string().max(500).default(""),
    engines: z.object({ codeforge: EngineRangeSchema }).optional(),
    /** Entry file relative to the extension root. Must stay inside the folder. */
    main: z
      .string()
      .min(1)
      .max(200)
      .refine((v) => !v.startsWith("/") && !v.startsWith("\\") && !v.includes("..") && !/^[a-zA-Z]:/.test(v), {
        message: "main must be a relative path inside the extension folder",
      }),
    permissions: z.array(ExtensionPermissionSchema).max(20).default([]),
    contributes: z
      .object({
        commands: z.array(CommandContributionSchema).max(50).default([]),
        settings: z.array(SettingContributionSchema).max(100).default([]),
      })
      .default({ commands: [], settings: [] }),
    activationEvents: z.array(z.string().max(80)).max(20).default([]),
  })
  .strict();

export type ExtensionManifest = z.infer<typeof ExtensionManifestSchema>;
export type ExtensionCommandContribution = z.infer<typeof CommandContributionSchema>;
export type ExtensionSettingContribution = z.infer<typeof SettingContributionSchema>;

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

/** Parse + validate an unknown manifest payload. Throws ManifestError with a readable reason. */
export function parseExtensionManifest(raw: unknown): ExtensionManifest {
  const result = ExtensionManifestSchema.safeParse(raw);
  if (result.success) return result.data;
  const issues = result.error.issues
    .map((issue) => `${issue.path.join(".") || "manifest"}: ${issue.message}`)
    .join("; ");
  throw new ManifestError(`Invalid extension manifest — ${issues}`);
}

function parseVersion(version: string): [number, number, number] {
  const [major, minor, patch] = version.split("-")[0]!.split(".").map(Number);
  return [major ?? 0, minor ?? 0, patch ?? 0];
}

function cmpVersion(a: string, b: string): number {
  const [am, an, ap] = parseVersion(a);
  const [bm, bn, bp] = parseVersion(b);
  return am - bm || an - bn || ap - bp;
}

/** True when `hostVersion` satisfies the manifest's `engines.codeforge` range. */
export function engineSatisfied(hostVersion: string, range: string | undefined): boolean {
  if (!range || range === "*") return true;
  if (range.startsWith(">=")) return cmpVersion(hostVersion, range.slice(2)) >= 0;
  if (range.startsWith("^")) {
    const base = range.slice(1);
    const [hostMajor] = parseVersion(hostVersion);
    const [baseMajor] = parseVersion(base);
    return hostMajor === baseMajor && cmpVersion(hostVersion, base) >= 0;
  }
  return false;
}

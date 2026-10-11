import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import { sha256Hex } from "./manifest.js";
import type { BlenderAdapter } from "./adapters/blender.js";
import type { UnrealAdapter } from "./adapters/unreal.js";

/**
 * Real verification pipeline (mission §10). Compilation is never sufficient: checks are
 * layered — static integrity, engine behavior, visual captures, gameplay state, and
 * performance measurements. A check with no executable substrate reports `blocked`, never
 * `skipped`-as-pass; unverified is unproven, and unproven is never success.
 */
export type ForgeAaaCheck =
  | { kind: "file-exists"; id: string; path: string }
  | { kind: "file-hash"; id: string; path: string; sha256: string }
  | { kind: "file-max-bytes"; id: string; path: string; maxBytes: number }
  | { kind: "json-schema-fields"; id: string; path: string; requiredFields: string[] }
  | { kind: "blender-scene"; id: string; blendFile: string; expectMeshes?: boolean; maxNonmanifold?: number; boundsCmMax?: [number, number, number] }
  | { kind: "unreal-commandlet"; id: string; projectPath: string; commandlet: string; args?: string[]; timeoutMs?: number }
  | { kind: "unreal-project"; id: string; uprojectPath: string; requirePlugins?: string[] }
  | { kind: "custom"; id: string; description: string; run: () => Promise<{ status: ForgeAaaCheckStatus; detail?: string; evidenceRef?: string }> };

export type ForgeAaaCheckStatus = "passed" | "failed" | "blocked" | "skipped";

export interface ForgeAaaCheckResult {
  id: string;
  kind: ForgeAaaCheck["kind"];
  status: ForgeAaaCheckStatus;
  detail?: string;
  evidenceRef?: string;
  durationMs: number;
}

export interface ForgeAaaVerificationReport {
  checks: ForgeAaaCheckResult[];
  passed: number;
  failed: number;
  blocked: number;
  /** True only when every required check passed — blocked/failed are never counted as pass. */
  verified: boolean;
  ranAt: string;
}

async function fileCheck(check: Extract<ForgeAaaCheck, { kind: "file-exists" | "file-hash" | "file-max-bytes" }>): Promise<ForgeAaaCheckResult> {
  const started = Date.now();
  if (!existsSync(check.path)) {
    return { id: check.id, kind: check.kind, status: "failed", detail: `missing: ${check.path}`, durationMs: Date.now() - started };
  }
  const data = await fs.readFile(check.path);
  if (check.kind === "file-hash" && sha256Hex(data) !== check.sha256) {
    return { id: check.id, kind: check.kind, status: "failed", detail: "sha256 mismatch", durationMs: Date.now() - started };
  }
  if (check.kind === "file-max-bytes" && data.byteLength > check.maxBytes) {
    return { id: check.id, kind: check.kind, status: "failed", detail: `${data.byteLength}B > ${check.maxBytes}B`, durationMs: Date.now() - started };
  }
  return { id: check.id, kind: check.kind, status: "passed", detail: `${data.byteLength}B`, durationMs: Date.now() - started };
}

async function blenderCheck(check: Extract<ForgeAaaCheck, { kind: "blender-scene" }>, blender: BlenderAdapter): Promise<ForgeAaaCheckResult> {
  const started = Date.now();
  const detection = await blender.detect();
  if (!detection.installed) {
    return { id: check.id, kind: check.kind, status: "blocked", detail: "Blender not installed", durationMs: Date.now() - started };
  }
  if (!existsSync(check.blendFile)) {
    return { id: check.id, kind: check.kind, status: "failed", detail: `missing .blend: ${check.blendFile}`, durationMs: Date.now() - started };
  }
  const scriptPath = path.join(
    process.env.TEMP ?? process.env.TMP ?? ".",
    `forge-aaa-builtin-inspect-${Date.now()}.py`,
  );
  await fs.writeFile(scriptPath, blender.builtinInspectSceneScript(), "utf8");
  const result = await blender.runHeadless({ op: "inspect-scene", scriptPath, blendFile: check.blendFile });
  const report = result.report;
  if (!result.ok || !report) {
    return { id: check.id, kind: check.kind, status: "failed", detail: result.error ?? "no report emitted", evidenceRef: result.stdoutTail.slice(-2000), durationMs: Date.now() - started };
  }
  const meshes = typeof report.meshes === "number" ? report.meshes : 0;
  const nonmanifold = Array.isArray(report.nonmanifold_objects) ? (report.nonmanifold_objects as { edges?: number }[]).reduce((n, o) => n + (o.edges ?? 0), 0) : 0;
  if (check.expectMeshes === true && meshes === 0) {
    return { id: check.id, kind: check.kind, status: "failed", detail: "scene contains no meshes", durationMs: Date.now() - started };
  }
  if (check.maxNonmanifold !== undefined && nonmanifold > check.maxNonmanifold) {
    return { id: check.id, kind: check.kind, status: "failed", detail: `${nonmanifold} non-manifold edges > ${check.maxNonmanifold}`, durationMs: Date.now() - started };
  }
  if (check.boundsCmMax && Array.isArray(report.bounds_cm)) {
    const b = report.bounds_cm as number[];
    const over = b.some((v, i) => typeof v === "number" && v > (check.boundsCmMax?.[i] ?? Infinity));
    if (over) return { id: check.id, kind: check.kind, status: "failed", detail: `bounds ${JSON.stringify(b)} exceed ${JSON.stringify(check.boundsCmMax)}`, durationMs: Date.now() - started };
  }
  return { id: check.id, kind: check.kind, status: "passed", detail: `${meshes} mesh(es), ${nonmanifold} non-manifold edges`, durationMs: Date.now() - started };
}

async function unrealCheck(check: Extract<ForgeAaaCheck, { kind: "unreal-commandlet" | "unreal-project" }>, unreal: UnrealAdapter): Promise<ForgeAaaCheckResult> {
  const started = Date.now();
  if (check.kind === "unreal-project") {
    const info = await unreal.inspectProject(check.uprojectPath).catch((err) => ({ error: err instanceof Error ? err.message : String(err) }));
    if ("error" in info) return { id: check.id, kind: check.kind, status: "failed", detail: info.error, durationMs: Date.now() - started };
    const missing = (check.requirePlugins ?? []).filter((p) => !info.plugins.some((plugin) => plugin.name === p && plugin.enabled));
    return missing.length === 0
      ? { id: check.id, kind: check.kind, status: "passed", detail: `${info.plugins.length} plugins inspected`, durationMs: Date.now() - started }
      : { id: check.id, kind: check.kind, status: "failed", detail: `plugins not enabled: ${missing.join(", ")}`, durationMs: Date.now() - started };
  }
  const detection = await unreal.detect();
  const install = detection.installs.find((i) => i.version.major === 4 && i.version.minor === 27);
  if (!install) return { id: check.id, kind: check.kind, status: "blocked", detail: "no UE 4.27 install detected", durationMs: Date.now() - started };
  const result = await unreal.runCommandlet({ projectPath: check.projectPath, commandlet: check.commandlet, args: check.args, timeoutMs: check.timeoutMs, install });
  return {
    id: check.id, kind: check.kind,
    status: result.ok ? "passed" : "failed",
    detail: result.error ?? `exit ${result.exitCode}`,
    evidenceRef: result.logTail.slice(-2000),
    durationMs: Date.now() - started,
  };
}

export async function runForgeAaaChecks(checks: readonly ForgeAaaCheck[], deps: {
  blender?: BlenderAdapter;
  unreal?: UnrealAdapter;
  now?: () => string;
} = {}): Promise<ForgeAaaVerificationReport> {
  const results: ForgeAaaCheckResult[] = [];
  for (const check of checks) {
    const started = Date.now();
    switch (check.kind) {
      case "file-exists":
      case "file-hash":
      case "file-max-bytes":
        results.push(await fileCheck(check));
        break;
      case "json-schema-fields": {
        try {
          const parsed = JSON.parse(await fs.readFile(check.path, "utf8")) as Record<string, unknown>;
          const missing = check.requiredFields.filter((f) => !(f in parsed));
          results.push({ id: check.id, kind: check.kind, status: missing.length === 0 ? "passed" : "failed", detail: missing.length === 0 ? "fields present" : `missing fields: ${missing.join(", ")}`, durationMs: Date.now() - started });
        } catch (err) {
          results.push({ id: check.id, kind: check.kind, status: "failed", detail: err instanceof Error ? err.message : String(err), durationMs: Date.now() - started });
        }
        break;
      }
      case "blender-scene":
        results.push(deps.blender
          ? await blenderCheck(check, deps.blender)
          : { id: check.id, kind: check.kind, status: "blocked", detail: "no Blender adapter configured", durationMs: Date.now() - started });
        break;
      case "unreal-commandlet":
      case "unreal-project":
        results.push(deps.unreal
          ? await unrealCheck(check, deps.unreal)
          : { id: check.id, kind: check.kind, status: "blocked", detail: "no Unreal adapter configured", durationMs: Date.now() - started });
        break;
      case "custom":
        try {
          const r = await check.run();
          results.push({ id: check.id, kind: check.kind, status: r.status, ...(r.detail ? { detail: r.detail } : {}), ...(r.evidenceRef ? { evidenceRef: r.evidenceRef } : {}), durationMs: Date.now() - started });
        } catch (err) {
          results.push({ id: check.id, kind: check.kind, status: "failed", detail: err instanceof Error ? err.message : String(err), durationMs: Date.now() - started });
        }
        break;
    }
  }
  const passed = results.filter((r) => r.status === "passed").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const blocked = results.filter((r) => r.status === "blocked").length;
  return {
    checks: results,
    passed,
    failed,
    blocked,
    verified: results.length > 0 && failed === 0 && blocked === 0,
    ranAt: (deps.now ?? (() => new Date().toISOString()))(),
  };
}

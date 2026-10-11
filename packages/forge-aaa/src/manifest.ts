import { createHash } from "node:crypto";

/**
 * Machine-readable asset contract (mission §9). Every generated/integrated asset carries
 * provenance, licensing, geometry stats, engine compatibility, and validation results so
 * downstream systems can reason about the artifact without trusting the generator's word.
 */
export interface ForgeAaaAssetManifest {
  manifestVersion: 1;
  assetId: string;
  taskId: string;
  runId?: string;
  provenance: {
    generator: string;
    generatorVersion?: string;
    providerId?: string;
    modelId?: string;
    tool: "blender" | "unreal" | "codeforge" | "external" | "hand";
  };
  license: { id?: string; commercialUse: "yes" | "no" | "conditional" | "unknown"; detail?: string };
  files: { path: string; role: "source" | "output" | "preview" | "log"; sha256: string; bytes: number }[];
  units: { system: "metric" | "imperial"; scale: number; upAxis: "Z" | "Y"; forwardAxis?: "X" | "Y" | "-Y" };
  stats?: {
    vertices?: number;
    triangles?: number;
    materials?: number;
    textures?: number;
    boundsCm?: [number, number, number];
    nonmanifoldEdges?: number;
  };
  skeleton?: { boneCount?: number; compatibleSkeletons?: string[] };
  materials?: string[];
  collision?: "none" | "custom" | "ucx_prefix" | "generated" | "unknown";
  lods?: { count?: number; screenSizes?: number[] };
  engines: { blender?: string[]; unreal?: string[] };
  validation: {
    checks: { id: string; kind: string; status: "passed" | "failed" | "blocked" | "skipped"; detail?: string }[];
    validatedAt?: string;
  };
  revision: number;
  supersedes?: string;
  dependencies?: string[];
  approved?: boolean;
  createdAt: string;
}

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function validateManifest(m: unknown): string[] {
  const errors: string[] = [];
  if (typeof m !== "object" || m === null) return ["manifest is not an object"];
  const v = m as Partial<ForgeAaaAssetManifest>;
  if (v.manifestVersion !== 1) errors.push("manifestVersion must be 1");
  if (typeof v.assetId !== "string" || !/^[a-z0-9][a-z0-9._/-]{0,127}$/.test(v.assetId)) errors.push("assetId missing or unsafe");
  if (typeof v.taskId !== "string" || !v.taskId.trim()) errors.push("taskId required");
  if (typeof v.provenance?.generator !== "string" || !v.provenance.generator.trim()) errors.push("provenance.generator required");
  if (!v.provenance || !["blender", "unreal", "codeforge", "external", "hand"].includes(v.provenance.tool)) errors.push("provenance.tool invalid");
  if (!v.license || !["yes", "no", "conditional", "unknown"].includes(v.license.commercialUse)) errors.push("license.commercialUse invalid");
  if (!Array.isArray(v.files) || v.files.length === 0) errors.push("files must be a non-empty array");
  for (const [i, f] of (v.files ?? []).entries()) {
    if (typeof f.path !== "string" || !f.path.trim()) errors.push(`files[${i}].path required`);
    if (typeof f.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(f.sha256)) errors.push(`files[${i}].sha256 must be a lowercase sha256 hex`);
    if (typeof f.bytes !== "number" || f.bytes < 0) errors.push(`files[${i}].bytes invalid`);
    if (!["source", "output", "preview", "log"].includes(f.role)) errors.push(`files[${i}].role invalid`);
  }
  if (!v.units || !["metric", "imperial"].includes(v.units.system)) errors.push("units.system invalid");
  if (v.units && (typeof v.units.scale !== "number" || !(v.units.scale > 0))) errors.push("units.scale must be > 0");
  if (v.units && !["Z", "Y"].includes(v.units.upAxis)) errors.push("units.upAxis must be Z or Y");
  if (typeof v.revision !== "number" || !Number.isInteger(v.revision) || v.revision < 1) errors.push("revision must be an integer >= 1");
  if (!v.engines || typeof v.engines !== "object") errors.push("engines required (may be empty)");
  if (!v.validation || !Array.isArray(v.validation.checks)) errors.push("validation.checks must be an array");
  if (typeof v.createdAt !== "string" || Number.isNaN(Date.parse(v.createdAt))) errors.push("createdAt must be ISO-8601");
  return errors;
}

export function createManifest(input: Omit<ForgeAaaAssetManifest, "manifestVersion" | "createdAt"> & { createdAt?: string }): ForgeAaaAssetManifest {
  const manifest: ForgeAaaAssetManifest = {
    manifestVersion: 1,
    ...input,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
  const errors = validateManifest(manifest);
  if (errors.length > 0) {
    throw new Error(`FORGE_AAA_MANIFEST_INVALID: ${errors.join("; ")}`);
  }
  return manifest;
}

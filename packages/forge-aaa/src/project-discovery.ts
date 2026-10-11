import { promises as fs } from "node:fs";
import path from "node:path";
import { ForgeAaaError, FORGE_AAA_ERRORS, type ForgeAaaEngineTarget } from "./types.js";

/** How ForgeAAA may treat a project directory — the four modes are never conflated. */
export type ForgeAaaProjectMode = "EXISTING_PROJECT" | "NEW_PROJECT" | "PILOT_PROJECT" | "MIGRATION_PROJECT";

export interface ForgeAaaProjectInspection {
  path: string;
  exists: boolean;
  git: { initialized: boolean; committed: boolean; dirty: boolean };
  unreal: {
    uprojectFiles: string[];
    engineAssociations: string[];
    hasContent: boolean;
    hasPlugins: boolean;
    hasSource: boolean;
  };
  blender: { blendFiles: string[] };
  generated: { forgeAaaArtifacts: boolean };
  contentSignals: {
    authoredAssetCount: number;
    totalFiles: number;
  };
}

export interface ForgeAaaProjectClassification {
  mode: ForgeAaaProjectMode;
  engineTarget: ForgeAaaEngineTarget | undefined;
  /** Real authored content exists — generated demonstrations must never replace it. */
  hasAuthoredContent: boolean;
  rationale: string[];
  protections: string[];
}

const IGNORED_DIRS = new Set([".git", "DerivedDataCache", "Intermediate", "Saved", "Binaries", "node_modules", ".vs"]);
const AUTHORED_EXTENSIONS = new Set([".uasset", ".umap", ".blend", ".fbx", ".obj", ".png", ".tga", ".wav", ".cpp", ".h", ".cs", ".usf"]);

async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

async function walk(root: string, depth = 0, maxDepth = 4): Promise<string[]> {
  if (depth > maxDepth) return [];
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return []; }
  const out: string[] = [];
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) {
      if (!IGNORED_DIRS.has(e.name)) out.push(...await walk(p, depth + 1, maxDepth));
    } else out.push(p);
  }
  return out;
}

async function gitState(dir: string): Promise<ForgeAaaProjectInspection["git"]> {
  const gitDir = path.join(dir, ".git");
  if (!(await exists(gitDir))) return { initialized: false, committed: false, dirty: false };
  let committed = false;
  try {
    const head = await fs.readFile(path.join(gitDir, "HEAD"), "utf8");
    const ref = head.trim().replace(/^ref:\s*/, "");
    committed = ref.startsWith("refs/")
      ? await exists(path.join(gitDir, ref)) || await exists(path.join(gitDir, "packed-refs"))
      : /^[0-9a-f]{40}$/i.test(ref);
  } catch { /* unreadable HEAD → uncommitted */ }
  return { initialized: true, committed, dirty: false };
}

async function uprojectInfo(dir: string, files: string[]): Promise<ForgeAaaProjectInspection["unreal"]> {
  const uprojectFiles = files.filter((f) => f.toLowerCase().endsWith(".uproject") && path.dirname(f) === dir);
  const engineAssociations: string[] = [];
  for (const file of uprojectFiles) {
    try {
      const parsed = JSON.parse(await fs.readFile(file, "utf8")) as { EngineAssociation?: string };
      if (parsed.EngineAssociation) engineAssociations.push(parsed.EngineAssociation);
    } catch { /* malformed descriptor — record no association */ }
  }
  return {
    uprojectFiles,
    engineAssociations,
    hasContent: await exists(path.join(dir, "Content")),
    hasPlugins: await exists(path.join(dir, "Plugins")),
    hasSource: await exists(path.join(dir, "Source")),
  };
}

/** Inspect a candidate project directory without mutating it. */
export async function inspectForgeAaaProject(dir: string): Promise<ForgeAaaProjectInspection> {
  const resolved = path.resolve(dir);
  if (!(await exists(resolved))) {
    return {
      path: resolved, exists: false,
      git: { initialized: false, committed: false, dirty: false },
      unreal: { uprojectFiles: [], engineAssociations: [], hasContent: false, hasPlugins: false, hasSource: false },
      blender: { blendFiles: [] },
      generated: { forgeAaaArtifacts: false },
      contentSignals: { authoredAssetCount: 0, totalFiles: 0 },
    };
  }
  const files = (await walk(resolved)).map((f) => path.resolve(f));
  const authored = files.filter((f) => AUTHORED_EXTENSIONS.has(path.extname(f).toLowerCase()));
  return {
    path: resolved,
    exists: true,
    git: await gitState(resolved),
    unreal: await uprojectInfo(resolved, files),
    blender: { blendFiles: authored.filter((f) => f.toLowerCase().endsWith(".blend")) },
    generated: { forgeAaaArtifacts: await exists(path.join(resolved, ".forge-aaa")) },
    contentSignals: { authoredAssetCount: authored.length, totalFiles: files.length },
  };
}

/**
 * Classify how ForgeAAA may treat the directory. EXISTING_PROJECT wins whenever real
 * authored content is present; PILOT_PROJECT is only inferred when the directory is
 * empty or contains solely ForgeAAA-generated scaffolding. NEW_PROJECT requires an
 * explicit request — classification never invents it.
 */
export function classifyForgeAaaProject(
  inspection: ForgeAaaProjectInspection,
  opts: { explicitlyNew?: boolean; migrationTarget?: ForgeAaaEngineTarget } = {},
): ForgeAaaProjectClassification {
  const rationale: string[] = [];
  const protections: string[] = [];
  if (!inspection.exists) {
    rationale.push("path does not exist");
    if (opts.explicitlyNew) return { mode: "NEW_PROJECT", engineTarget: undefined, hasAuthoredContent: false, rationale, protections: ["create only inside the requested path"] };
    return { mode: "PILOT_PROJECT", engineTarget: undefined, hasAuthoredContent: false, rationale: [...rationale, "no authored content to protect — treat as disposable"], protections: ["never write outside the inspected path"] };
  }
  if (inspection.contentSignals.authoredAssetCount > 0 || inspection.unreal.hasSource) {
    rationale.push(`${inspection.contentSignals.authoredAssetCount} authored asset(s) detected${inspection.unreal.hasSource ? " plus C++ source" : ""}`);
    protections.push("no deletion or overwrite of authored files", "changes land under isolated ForgeAAA paths or new assets only", "high-risk edits require a git commit point or backup first");
    return {
      mode: "EXISTING_PROJECT",
      engineTarget: engineTargetFor(inspection),
      hasAuthoredContent: true,
      rationale, protections,
    };
  }
  if (opts.migrationTarget) {
    rationale.push("no authored content; migration target requested");
    return { mode: "MIGRATION_PROJECT", engineTarget: opts.migrationTarget, hasAuthoredContent: false, rationale, protections: ["source state snapshotted before any migration step"] };
  }
  rationale.push(inspection.unreal.uprojectFiles.length > 0 ? "descriptor present but no authored content — generated scaffolding only" : "empty or scaffold-only directory");
  protections.push("label generated artifacts as pilot output", "do not present pilot content as the user's authored project");
  return { mode: "PILOT_PROJECT", engineTarget: engineTargetFor(inspection), hasAuthoredContent: false, rationale, protections };
}

function engineTargetFor(i: ForgeAaaProjectInspection): ForgeAaaEngineTarget | undefined {
  const assoc = i.unreal.engineAssociations[0];
  if (!assoc) return undefined;
  if (assoc.startsWith("4.27")) return "ue-4.27";
  if (assoc.startsWith("5.")) return "ue-5";
  return undefined;
}

/**
 * Guard used before every mutating operation: the inspected state must permit the
 * requested mode. Throws OPERATION_DENIED rather than risking authored content.
 */
export function assertProjectMode(inspection: ForgeAaaProjectInspection, required: ForgeAaaProjectMode): ForgeAaaProjectClassification {
  const classification = classifyForgeAaaProject(inspection);
  if (required === "EXISTING_PROJECT" && !classification.hasAuthoredContent) {
    throw new ForgeAaaError(FORGE_AAA_ERRORS.OPERATION_DENIED, `refusing EXISTING_PROJECT operation: ${classification.rationale.join("; ")}`);
  }
  if (classification.mode === "EXISTING_PROJECT" && required !== "EXISTING_PROJECT") {
    throw new ForgeAaaError(FORGE_AAA_ERRORS.OPERATION_DENIED, `authored content present — ${required} operations are forbidden without explicit approval`);
  }
  return classification;
}

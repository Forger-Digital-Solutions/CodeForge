import { FORGE_AAA_ERRORS, ForgeAaaError } from "./types.js";

/**
 * Reusable building-module contract (R81 mission §7.1–7.3). Where DoorSpec is the
 * geometry contract for one generator, the module contract is the *gameplay* contract:
 * how a placed instance identifies itself, how it interacts, what state persists, and
 * which sockets future modules attach to. A model may author it; nothing downstream
 * trusts it until validateModuleContract has run.
 */
export interface BuildingModuleContract {
  contractVersion: 1;
  /** Logical module id, e.g. "dtw/building/door-western/v1". */
  moduleId: string;
  moduleType:
    | "door"
    | "window"
    | "wall"
    | "floor"
    | "roof"
    | "foundation"
    | "stair"
    | "storage"
    | "furniture"
    | "attachment";
  displayName: string;
  /** Overall module extents in UE centimeters. */
  dimensions: { widthCm: number; depthCm: number; heightCm: number };
  /** Rotation/attachment pivot convention. */
  pivot: {
    kind: "hinge-left" | "hinge-right" | "center" | "corner" | "custom";
    /** Local offset of the pivot from the module origin, cm — required for "custom". */
    offsetCm?: [number, number, number];
  };
  /** Named local-space sockets other modules can attach to. */
  sockets: { id: string; localPosCm: [number, number, number]; accepts?: string[] }[];
  collision: {
    profile: "block-all" | "block-dynamic" | "custom" | "none";
    /** Interactive modules: does the module block passage in its closed state? */
    blocksWhenClosed?: boolean;
    passesWhenOpen?: boolean;
  };
  interaction?: {
    /** Native contract the module implements. */
    interface: "IForgeInteractable";
    states: string[];
    initialState: string;
  };
  persistence?: {
    /** How a placed instance's durable identity is derived. */
    identityFrom: "instanceId" | "actorName" | "placedLabel";
    /** Save-record field names this module serializes. */
    stateFields: string[];
    schemaVersion: number;
  };
  provenance: {
    authoredBy: "model" | "deterministic" | "hand";
    modelId?: string;
    sourceModuleId?: string;
  };
  engines: { unreal?: string[]; blender?: string[] };
}

const MODULE_TYPES = new Set([
  "door", "window", "wall", "floor", "roof", "foundation", "stair", "storage", "furniture", "attachment",
]);
const PIVOT_KINDS = new Set(["hinge-left", "hinge-right", "center", "corner", "custom"]);
const COLLISION_PROFILES = new Set(["block-all", "block-dynamic", "custom", "none"]);
const IDENTITY_KINDS = new Set(["instanceId", "actorName", "placedLabel"]);

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const str = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

function vec3(name: string, v: unknown): [number, number, number] {
  if (!Array.isArray(v) || v.length !== 3 || !v.every(num)) {
    throw new ForgeAaaError(FORGE_AAA_ERRORS.MANIFEST_INVALID, `moduleContract.${name} must be [x,y,z] numbers — got ${JSON.stringify(v)}`);
  }
  return v as [number, number, number];
}

function dim(name: string, v: unknown): number {
  if (!num(v) || v <= 0 || v > 100_000) {
    throw new ForgeAaaError(FORGE_AAA_ERRORS.MANIFEST_INVALID, `moduleContract.${name} must be a number in (0, 100000] — got ${JSON.stringify(v)}`);
  }
  return v;
}

/** Validates a model-produced (or hand-authored) module contract; returns a normalized copy. */
export function validateModuleContract(raw: unknown): BuildingModuleContract {
  if (typeof raw !== "object" || raw === null) {
    throw new ForgeAaaError(FORGE_AAA_ERRORS.MANIFEST_INVALID, "moduleContract must be an object");
  }
  const c = raw as Record<string, unknown>;
  const bad = (msg: string): never => { throw new ForgeAaaError(FORGE_AAA_ERRORS.MANIFEST_INVALID, msg); };
  if (c.contractVersion !== 1) bad(`moduleContract.contractVersion must be 1 — got ${JSON.stringify(c.contractVersion)}`);
  if (typeof c.moduleId !== "string" || !/^[A-Za-z0-9/_-]{3,96}$/.test(c.moduleId)) {
    bad(`moduleContract.moduleId invalid: ${JSON.stringify(c.moduleId)}`);
  }
  if (typeof c.moduleType !== "string" || !MODULE_TYPES.has(c.moduleType)) {
    bad(`moduleContract.moduleType must be one of ${[...MODULE_TYPES].join("|")} — got ${JSON.stringify(c.moduleType)}`);
  }
  if (!str(c.displayName)) bad("moduleContract.displayName required");
  const dimensions = (c.dimensions ?? {}) as Record<string, unknown>;
  const pivot = (c.pivot ?? {}) as Record<string, unknown>;
  if (typeof pivot.kind !== "string" || !PIVOT_KINDS.has(pivot.kind)) {
    bad(`moduleContract.pivot.kind must be one of ${[...PIVOT_KINDS].join("|")} — got ${JSON.stringify(pivot.kind)}`);
  }
  if (pivot.kind === "custom" && pivot.offsetCm === undefined) bad("moduleContract.pivot.offsetCm required when pivot.kind is custom");
  const collision = (c.collision ?? {}) as Record<string, unknown>;
  if (typeof collision.profile !== "string" || !COLLISION_PROFILES.has(collision.profile)) {
    bad(`moduleContract.collision.profile must be one of ${[...COLLISION_PROFILES].join("|")} — got ${JSON.stringify(collision.profile)}`);
  }
  const sockets = Array.isArray(c.sockets) ? c.sockets : bad("moduleContract.sockets must be an array");
  const provenance = (c.provenance ?? {}) as Record<string, unknown>;
  if (provenance.authoredBy !== "model" && provenance.authoredBy !== "deterministic" && provenance.authoredBy !== "hand") {
    bad(`moduleContract.provenance.authoredBy must be model|deterministic|hand — got ${JSON.stringify(provenance.authoredBy)}`);
  }
  const engines = (c.engines ?? {}) as Record<string, unknown>;

  const contract: BuildingModuleContract = {
    contractVersion: 1,
    moduleId: c.moduleId as string,
    moduleType: c.moduleType as BuildingModuleContract["moduleType"],
    displayName: (c.displayName as string).trim(),
    dimensions: {
      widthCm: dim("dimensions.widthCm", dimensions.widthCm),
      depthCm: dim("dimensions.depthCm", dimensions.depthCm),
      heightCm: dim("dimensions.heightCm", dimensions.heightCm),
    },
    pivot: {
      kind: pivot.kind as BuildingModuleContract["pivot"]["kind"],
      ...(pivot.offsetCm !== undefined ? { offsetCm: vec3("pivot.offsetCm", pivot.offsetCm) } : {}),
    },
    sockets: (sockets as Record<string, unknown>[]).map((s, i) => {
      if (!str(s.id)) bad(`moduleContract.sockets[${i}].id required`);
      return {
        id: (s.id as string).trim(),
        localPosCm: vec3(`sockets[${i}].localPosCm`, s.localPosCm),
        ...(Array.isArray(s.accepts) ? { accepts: s.accepts.filter((a): a is string => typeof a === "string") } : {}),
      };
    }),
    collision: {
      profile: collision.profile as BuildingModuleContract["collision"]["profile"],
      ...(collision.blocksWhenClosed !== undefined ? { blocksWhenClosed: collision.blocksWhenClosed === true } : {}),
      ...(collision.passesWhenOpen !== undefined ? { passesWhenOpen: collision.passesWhenOpen === true } : {}),
    },
    provenance: {
      authoredBy: provenance.authoredBy as BuildingModuleContract["provenance"]["authoredBy"],
      ...(str(provenance.modelId) ? { modelId: provenance.modelId.trim() } : {}),
      ...(str(provenance.sourceModuleId) ? { sourceModuleId: provenance.sourceModuleId.trim() } : {}),
    },
    engines: {
      ...(Array.isArray(engines.unreal) ? { unreal: engines.unreal.filter((e): e is string => typeof e === "string") } : {}),
      ...(Array.isArray(engines.blender) ? { blender: engines.blender.filter((e): e is string => typeof e === "string") } : {}),
    },
  };
  if (c.interaction !== undefined) {
    const it = c.interaction as Record<string, unknown>;
    if (it.interface !== "IForgeInteractable") bad(`moduleContract.interaction.interface must be "IForgeInteractable" — got ${JSON.stringify(it.interface)}`);
    if (!Array.isArray(it.states) || it.states.length === 0 || !it.states.every(str)) bad("moduleContract.interaction.states must be a non-empty string array");
    if (!str(it.initialState)) bad("moduleContract.interaction.initialState required");
    if (!(it.states as string[]).includes(it.initialState as string)) bad("moduleContract.interaction.initialState must be one of states");
    contract.interaction = {
      interface: "IForgeInteractable",
      states: (it.states as string[]).map((s) => s.trim()),
      initialState: (it.initialState as string).trim(),
    };
  }
  if (c.persistence !== undefined) {
    const p = c.persistence as Record<string, unknown>;
    if (typeof p.identityFrom !== "string" || !IDENTITY_KINDS.has(p.identityFrom)) {
      bad(`moduleContract.persistence.identityFrom must be one of ${[...IDENTITY_KINDS].join("|")} — got ${JSON.stringify(p.identityFrom)}`);
    }
    if (!Array.isArray(p.stateFields) || p.stateFields.length === 0 || !p.stateFields.every(str)) bad("moduleContract.persistence.stateFields must be a non-empty string array");
    if (!num(p.schemaVersion) || !Number.isInteger(p.schemaVersion) || p.schemaVersion < 1) bad("moduleContract.persistence.schemaVersion must be an integer >= 1");
    contract.persistence = {
      identityFrom: p.identityFrom as NonNullable<BuildingModuleContract["persistence"]>["identityFrom"],
      stateFields: (p.stateFields as string[]).map((s) => s.trim()),
      schemaVersion: p.schemaVersion as number,
    };
  }
  return contract;
}

/** Parses a module contract out of raw model output text (tolerates fences/preamble). */
export function parseModuleContractFromText(raw: string): { ok: true; contract: BuildingModuleContract } | { ok: false; error: string } {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return { ok: false, error: "no JSON object in model output" };
  try {
    return { ok: true, contract: validateModuleContract(JSON.parse(match[0])) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

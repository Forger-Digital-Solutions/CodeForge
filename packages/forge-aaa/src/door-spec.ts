import { FORGE_AAA_ERRORS, ForgeAaaError } from "./types.js";

/**
 * Modular door contract (mission §6): the spec is the single source of truth that both
 * the Blender generator and the Unreal interaction harness consume. A model may author
 * it, but nothing downstream trusts it until validateDoorSpec has run — the schema is
 * the interface between MODEL_IMPLEMENTED output and TOOL_EXECUTED work.
 * All dimensions are centimeters (UE world units).
 */
export interface DoorSpec {
  /** Logical module id, e.g. "dtw/building/door-western/v1". */
  moduleId: string;
  opening: {
    /** Clear width of the doorway opening. */
    widthCm: number;
    /** Clear height of the doorway opening. */
    heightCm: number;
  };
  leaf: {
    thicknessCm: number;
    /** Gap between leaf edges and frame, per side. */
    clearanceCm: number;
    /** Number of horizontal ledgers/battens on the period plank leaf (0 = plain slab). */
    battens: number;
  };
  frame: {
    /** Jamb thickness (wall direction). */
    depthCm: number;
    /** Jamb face width visible in the opening plane. */
    jambWidthCm: number;
  };
  hinge: {
    /** Which jamb carries the hinge, looking at the leaf's pull face. */
    side: "left" | "right";
    /** Pivot measured from the hinge-side opening edge, cm. */
    pivotOffsetCm: number;
  };
  motion: {
    /** Signed degrees the leaf travels; sign sets swing direction. */
    openAngleDeg: number;
    transitionS: number;
  };
}

export const DOOR_SPEC_LIMITS = {
  openingWidthCm: [60, 300] as const,
  openingHeightCm: [150, 300] as const,
  leafThicknessCm: [2, 15] as const,
  leafClearanceCm: [0.2, 5] as const,
  battens: [0, 6] as const,
  frameDepthCm: [5, 60] as const,
  jambWidthCm: [3, 40] as const,
  pivotOffsetCm: [0, 20] as const,
  openAngleDeg: [30, 135] as const,
  transitionS: [0.2, 10] as const,
};

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function range(name: string, v: unknown, [lo, hi]: readonly [number, number]): number {
  if (!num(v) || v < lo || v > hi) {
    throw new ForgeAaaError(FORGE_AAA_ERRORS.MANIFEST_INVALID, `doorSpec.${name} must be a number in [${lo}, ${hi}] — got ${JSON.stringify(v)}`);
  }
  return v;
}

/** Validates a model-produced (or hand-authored) door spec; returns a normalized copy. */
export function validateDoorSpec(raw: unknown): DoorSpec {
  if (typeof raw !== "object" || raw === null) {
    throw new ForgeAaaError(FORGE_AAA_ERRORS.MANIFEST_INVALID, "doorSpec must be an object");
  }
  const s = raw as Record<string, unknown>;
  const opening = (s.opening ?? {}) as Record<string, unknown>;
  const leaf = (s.leaf ?? {}) as Record<string, unknown>;
  const frame = (s.frame ?? {}) as Record<string, unknown>;
  const hinge = (s.hinge ?? {}) as Record<string, unknown>;
  const motion = (s.motion ?? {}) as Record<string, unknown>;
  if (typeof s.moduleId !== "string" || !/^[A-Za-z0-9/_-]{3,96}$/.test(s.moduleId)) {
    throw new ForgeAaaError(FORGE_AAA_ERRORS.MANIFEST_INVALID, `doorSpec.moduleId invalid: ${JSON.stringify(s.moduleId)}`);
  }
  const openAngleDeg = num(motion.openAngleDeg)
    && Math.abs(motion.openAngleDeg) >= DOOR_SPEC_LIMITS.openAngleDeg[0]
    && Math.abs(motion.openAngleDeg) <= DOOR_SPEC_LIMITS.openAngleDeg[1]
    ? (motion.openAngleDeg as number)
    : (() => { throw new ForgeAaaError(FORGE_AAA_ERRORS.MANIFEST_INVALID, `doorSpec.motion.openAngleDeg must be signed with |angle| in [${DOOR_SPEC_LIMITS.openAngleDeg[0]}, ${DOOR_SPEC_LIMITS.openAngleDeg[1]}] — got ${JSON.stringify(motion.openAngleDeg)}`); })();
  const spec: DoorSpec = {
    moduleId: s.moduleId,
    opening: {
      widthCm: range("opening.widthCm", opening.widthCm, DOOR_SPEC_LIMITS.openingWidthCm),
      heightCm: range("opening.heightCm", opening.heightCm, DOOR_SPEC_LIMITS.openingHeightCm),
    },
    leaf: {
      thicknessCm: range("leaf.thicknessCm", leaf.thicknessCm, DOOR_SPEC_LIMITS.leafThicknessCm),
      clearanceCm: range("leaf.clearanceCm", leaf.clearanceCm, DOOR_SPEC_LIMITS.leafClearanceCm),
      battens: Math.round(range("leaf.battens", leaf.battens, DOOR_SPEC_LIMITS.battens)),
    },
    frame: {
      depthCm: range("frame.depthCm", frame.depthCm, DOOR_SPEC_LIMITS.frameDepthCm),
      jambWidthCm: range("frame.jambWidthCm", frame.jambWidthCm, DOOR_SPEC_LIMITS.jambWidthCm),
    },
    hinge: {
      side: hinge.side === "left" || hinge.side === "right" ? hinge.side : (() => { throw new ForgeAaaError(FORGE_AAA_ERRORS.MANIFEST_INVALID, `doorSpec.hinge.side must be "left"|"right"`); })(),
      pivotOffsetCm: range("hinge.pivotOffsetCm", hinge.pivotOffsetCm, DOOR_SPEC_LIMITS.pivotOffsetCm),
    },
    motion: {
      openAngleDeg,
      transitionS: range("motion.transitionS", motion.transitionS, DOOR_SPEC_LIMITS.transitionS),
    },
  };
  return spec;
}

/** Parses a door spec out of raw model output text (tolerates fences/preamble). */
export function parseDoorSpecFromText(raw: string): { ok: true; spec: DoorSpec } | { ok: false; error: string } {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return { ok: false, error: "no JSON object in model output" };
  try {
    return { ok: true, spec: validateDoorSpec(JSON.parse(match[0])) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Period-appropriate defaults for a Western hinged door — used when no model spec exists. */
export function defaultDoorSpec(): DoorSpec {
  return validateDoorSpec({
    moduleId: "dtw/building/door-western/v1",
    opening: { widthCm: 100, heightCm: 210 },
    leaf: { thicknessCm: 5, clearanceCm: 1, battens: 3 },
    frame: { depthCm: 20, jambWidthCm: 10 },
    hinge: { side: "left", pivotOffsetCm: 3 },
    motion: { openAngleDeg: -95, transitionS: 0.8 },
  });
}

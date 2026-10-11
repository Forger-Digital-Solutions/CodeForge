import type { ForgeAaaEngineTarget, ForgeAaaSpecialtyId } from "./types.js";

/**
 * The twelve logical specialists (mission §5). These are capabilities, not processes —
 * a single qualified model may serve several specialties, and a tool-only specialist may
 * serve none. `rosterRole` maps the specialty onto the existing orchestrator's role
 * vocabulary so ForgeAAA work dispatches through the proven spawn/allowance path.
 */
export interface ForgeAaaSpecialty {
  id: ForgeAaaSpecialtyId;
  displayName: string;
  summary: string;
  /** Orchestrator role this specialty's tasks execute under. */
  rosterRole: "PLANNER" | "CODER" | "REVIEWER" | "EXPLORER" | "TESTER" | "LEAD";
  /** Engines the specialty's tool adapters may be granted. Empty = pure reasoning. */
  engines: ForgeAaaEngineTarget[];
  execution: "model" | "tool" | "hybrid";
  /** Deterministic planner signals — a goal mentioning these routes to the specialty. */
  signals: readonly string[];
}

export const FORGE_AAA_SPECIALTIES: readonly ForgeAaaSpecialty[] = [
  {
    id: "forge-architect", displayName: "ForgeArchitect", rosterRole: "PLANNER", execution: "model", engines: ["any"],
    summary: "Game architecture, engine systems, dependency and migration design.",
    signals: ["architecture", "design", "system", "module", "dependency", "migration", "framework", "structure"],
  },
  {
    id: "forge-modeler", displayName: "ForgeModeler", rosterRole: "CODER", execution: "hybrid", engines: ["blender-4.5"],
    summary: "3D meshes, props, buildings, modular kit construction and repair.",
    signals: ["mesh", "model", "prop", "building", "modular", "geometry", "vertex", "uv", "blend", "farmhouse"],
  },
  {
    id: "forge-material", displayName: "ForgeMaterial", rosterRole: "CODER", execution: "hybrid", engines: ["blender-4.5", "ue-4.27"],
    summary: "PBR materials, textures, UV layout, surface consistency.",
    signals: ["material", "texture", "pbr", "shader", "uv map", "surface", "albedo", "roughness"],
  },
  {
    id: "forge-world", displayName: "ForgeWorld", rosterRole: "CODER", execution: "hybrid", engines: ["blender-4.5", "ue-4.27"],
    summary: "Terrain, foliage, biomes, landscape composition.",
    signals: ["terrain", "landscape", "foliage", "biome", "vegetation", "world", "level", "forest", "ground"],
  },
  {
    id: "forge-atmosphere", displayName: "ForgeAtmosphere", rosterRole: "CODER", execution: "hybrid", engines: ["ue-4.27"],
    summary: "Time of day, lighting, clouds, weather, astronomy, seasons.",
    signals: ["weather", "lighting", "sky", "cloud", "atmosphere", "season", "time of day", "astronomy", "fog", "rain"],
  },
  {
    id: "forge-character", displayName: "ForgeCharacter", rosterRole: "CODER", execution: "hybrid", engines: ["blender-4.5"],
    summary: "Characters, animals, skeletons, rigs, animation and retargeting.",
    signals: ["character", "rig", "skeleton", "animation", "animal", "retarget", "skin", "bone", "npc model"],
  },
  {
    id: "forge-gameplay", displayName: "ForgeGameplay", rosterRole: "CODER", execution: "model", engines: ["ue-4.27"],
    summary: "C++, Blueprints, interactions, gameplay mechanics.",
    signals: ["gameplay", "blueprint", "c++", "interaction", "mechanic", "ability", "input", "door", "collision"],
  },
  {
    id: "forge-simulation", displayName: "ForgeSimulation", rosterRole: "CODER", execution: "model", engines: ["ue-4.27"],
    summary: "Farming, ranching, economies, wildlife behavior, NPC navigation, physics.",
    signals: ["farming", "ranching", "economy", "simulation", "physics", "npc", "navigation", "behavior", "wildlife"],
  },
  {
    id: "forge-audio", displayName: "ForgeAudio", rosterRole: "CODER", execution: "hybrid", engines: ["ue-4.27"],
    summary: "Soundscapes, dialogue, music, spatial audio.",
    signals: ["audio", "sound", "music", "dialogue", "voice", "ambient", "spatial audio"],
  },
  {
    id: "forge-cinematic", displayName: "ForgeCinematic", rosterRole: "CODER", execution: "hybrid", engines: ["ue-4.27"],
    summary: "Cameras, sequencing, cinematics.",
    signals: ["cinematic", "camera", "sequence", "cutscene", "shot"],
  },
  {
    id: "forge-optimizer", displayName: "ForgeOptimizer", rosterRole: "CODER", execution: "hybrid", engines: ["blender-4.5", "ue-4.27"],
    summary: "LODs, memory, frame time, draw calls, streaming, asset budgets.",
    signals: ["performance", "optimization", "lod", "frame", "memory", "draw call", "streaming", "vram"],
  },
  {
    id: "forge-verify", displayName: "ForgeVerify", rosterRole: "REVIEWER", execution: "hybrid", engines: ["blender-4.5", "ue-4.27"],
    summary: "Independent tests, visual QA, geometric validation, regression protection.",
    signals: ["verify", "test", "validate", "inspect", "review", "screenshot", "compare", "regression", "qa"],
  },
];

const byId = new Map(FORGE_AAA_SPECIALTIES.map((s) => [s.id, s]));

export function forgeAaaSpecialty(id: string): ForgeAaaSpecialty | undefined {
  return byId.get(id as ForgeAaaSpecialtyId);
}

export const FORGE_AAA_SPECIALTY_IDS = FORGE_AAA_SPECIALTIES.map((s) => s.id) as readonly ForgeAaaSpecialtyId[];

/**
 * Deterministic goal→specialty classification for the vertical-slice planner. Scores
 * each specialty by distinct signal hits; returns ranked ids, strongest first. A goal with
 * no signal still yields `forge-architect` — decomposition itself is architecture work.
 */
export function classifyGoalSpecialties(goal: string): ForgeAaaSpecialtyId[] {
  const text = goal.toLowerCase();
  const scored = FORGE_AAA_SPECIALTIES
    .map((s) => ({ id: s.id, score: s.signals.reduce((n, sig) => n + (text.includes(sig) ? 1 : 0), 0) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const ids = scored.map((s) => s.id);
  return ids.length > 0 ? ids : ["forge-architect"];
}

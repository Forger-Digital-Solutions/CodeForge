import { validateModuleContract, type BuildingModuleContract } from "./module-contract.js";
import { FORGE_AAA_ERRORS, ForgeAaaError } from "./types.js";

export interface BuildingModuleDefinition extends BuildingModuleContract {
  moduleVersion: 1;
  sourceAsset: string;
  engineAsset: string;
  coordinateSystem: "unreal-cm-z-up";
  materials: string[];
  dependencies: string[];
  validationStatus: "geometry-verified";
  contentSha256?: string;
  nativeClass?: "/Script/ForgeGameplay.ForgeInteractableDoor" | "/Script/ForgeGameplay.ForgeInteractableWindow";
  leafAsset?: string;
}

export interface BuildingModuleInstance {
  instanceId: string;
  moduleId: string;
  moduleVersion: 1;
  positionCm: [number, number, number];
  yawDeg: number;
  attachment?: { instanceId: string; socketId: string };
}

export interface BuildingDefinition {
  schemaVersion: 1;
  buildingInstanceId: string;
  attachmentToleranceCm: number;
  instances: BuildingModuleInstance[];
}

const idPattern = /^[A-Za-z0-9_-]{1,64}$/;
const assetPattern = /^\/Game\/ForgeAAA\/[A-Za-z0-9_/-]+$/;
function bad(message: string): never { throw new ForgeAaaError(FORGE_AAA_ERRORS.MANIFEST_INVALID, message); }
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const vector = (value: unknown): value is [number, number, number] => Array.isArray(value) && value.length === 3 && value.every(finite);

export function validateBuildingDefinition(raw: unknown, registry: readonly BuildingModuleDefinition[]): BuildingDefinition {
  if (!raw || typeof raw !== "object") bad("building must be an object");
  const b = raw as BuildingDefinition;
  if (b.schemaVersion !== 1 || typeof b.buildingInstanceId !== "string" || !idPattern.test(b.buildingInstanceId)) bad("unsupported building schema or identity");
  if (!finite(b.attachmentToleranceCm) || b.attachmentToleranceCm < 0 || b.attachmentToleranceCm > 5) bad("invalid attachment tolerance");
  if (!Array.isArray(b.instances) || b.instances.length === 0 || b.instances.length > 256) bad("building requires 1..256 instances");
  const modules = new Map<string, BuildingModuleDefinition>();
  for (const m of registry) {
    validateModuleContract(m);
    if (modules.has(m.moduleId) || m.moduleVersion !== 1) bad("duplicate module or unsupported module version");
    if (m.coordinateSystem !== "unreal-cm-z-up" || m.validationStatus !== "geometry-verified") bad("module geometry or coordinates unverified");
    if (typeof m.sourceAsset !== "string" || !m.sourceAsset || typeof m.engineAsset !== "string" || !assetPattern.test(m.engineAsset) || (m.leafAsset && !assetPattern.test(m.leafAsset))) bad("unresolved or unauthorized asset reference");
    if (!Array.isArray(m.materials) || !m.materials.every((s) => typeof s === "string" && s.length > 0) || !Array.isArray(m.dependencies)) bad("invalid materials or dependencies");
    if (m.contentSha256 !== undefined && !/^[a-f0-9]{64}$/.test(m.contentSha256)) bad("invalid asset hash");
    if (m.nativeClass && !["/Script/ForgeGameplay.ForgeInteractableDoor", "/Script/ForgeGameplay.ForgeInteractableWindow"].includes(m.nativeClass)) bad("unsupported native class");
    if (m.nativeClass && (!m.leafAsset || m.persistence?.identityFrom !== "instanceId")) bad("native module requires leaf asset and explicit persistent identity");
    if (m.nativeClass && m.nativeClass !== `/Script/ForgeGameplay.ForgeInteractable${m.moduleType === "door" ? "Door" : m.moduleType === "window" ? "Window" : "Unsupported"}`) bad("native class does not match module type");
    if (!m.engines?.unreal?.includes("4.27")) bad("module does not support Unreal 4.27");
    if (!m.nativeClass && m.pivot.kind !== "center") bad("structural assembly requires center pivots");
    if (!["floor", "wall", "roof", "door", "window"].includes(m.moduleType)) bad("module type unsupported by assembly");
    if (new Set(m.sockets.map((s) => s.id)).size !== m.sockets.length) bad("duplicate socket identity");
    modules.set(m.moduleId, m);
  }
  for (const m of modules.values()) for (const dep of m.dependencies) if (!modules.has(dep)) bad("missing module dependency");
  const instances = new Map<string, BuildingModuleInstance>();
  for (const i of b.instances) {
    if (!i || typeof i.instanceId !== "string" || !idPattern.test(i.instanceId) || instances.has(i.instanceId)) bad("duplicate or invalid instance identity");
    if (i.moduleVersion !== 1 || !modules.has(i.moduleId)) bad("missing module or unsupported instance version");
    if (!vector(i.positionCm) || i.positionCm.some((n) => Math.abs(n) > 100000) || !finite(i.yawDeg) || i.yawDeg % 90 !== 0) bad("invalid transform: assembly supports orthogonal yaw only");
    instances.set(i.instanceId, i);
  }
  for (const i of instances.values()) {
    if (!i.attachment) continue;
    const parent = instances.get(i.attachment.instanceId);
    if (!parent || parent === i) bad("attachment parent missing or self-referenced");
    const parentModule = modules.get(parent.moduleId)!;
    const socket = parentModule.sockets.find((s) => s.id === i.attachment!.socketId);
    if (!socket || (socket.accepts && !socket.accepts.includes(modules.get(i.moduleId)!.moduleType))) bad("missing or incompatible attachment socket");
    const a = parent.yawDeg * Math.PI / 180;
    const [x, y, z] = socket.localPosCm;
    const expected = [parent.positionCm[0] + x * Math.cos(a) - y * Math.sin(a), parent.positionCm[1] + x * Math.sin(a) + y * Math.cos(a), parent.positionCm[2] + z];
    if (Math.hypot(...i.positionCm.map((n, k) => n - expected[k]!)) > b.attachmentToleranceCm) bad("attachment misaligned");
    const seen = new Set([i.instanceId]);
    let cursor: BuildingModuleInstance | undefined = parent;
    while (cursor) {
      if (seen.has(cursor.instanceId)) bad("cyclic attachment");
      seen.add(cursor.instanceId);
      cursor = cursor.attachment ? instances.get(cursor.attachment.instanceId) : undefined;
    }
  }
  const solid = [...instances.values()].filter((i) => !modules.get(i.moduleId)!.nativeClass);
  const bounds = (i: BuildingModuleInstance) => {
    const d = modules.get(i.moduleId)!.dimensions;
    const swapped = Math.abs(i.yawDeg % 180) === 90;
    return [swapped ? d.depthCm : d.widthCm, swapped ? d.widthCm : d.depthCm, d.heightCm];
  };
  for (let n = 0; n < solid.length; n++) for (let k = n + 1; k < solid.length; k++) {
    const a = solid[n]!, c = solid[k]!, ad = bounds(a), cd = bounds(c);
    if (a.positionCm.every((v, axis) => Math.abs(v - c.positionCm[axis]!) < (ad[axis]! + cd[axis]!) / 2 - 0.01)) bad(`structural overlap: ${a.instanceId}/${c.instanceId}`);
  }
  return structuredClone(b);
}

export function buildingActorIdentity(buildingId: string, instanceId: string): string {
  if (typeof buildingId !== "string" || typeof instanceId !== "string" || !idPattern.test(buildingId) || !idPattern.test(instanceId)) bad("invalid actor identity");
  return `forge-building:${buildingId}:${instanceId}`;
}

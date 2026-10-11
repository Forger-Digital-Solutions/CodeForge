import { createHash } from "node:crypto";
import { buildingActorIdentity, validateBuildingDefinition, type BuildingDefinition, type BuildingModuleDefinition, type BuildingModuleInstance } from "./building-definition.js";
import { FORGE_AAA_ERRORS, ForgeAaaError } from "./types.js";

export interface BuildingRoom {
  roomId: string;
  purpose: string;
  floorInstanceId: string;
  ceilingInstanceId: string;
  centerCm: [number, number, number];
  interiorCm: [number, number, number];
  instanceIds: string[];
}

export interface BuildingRoomConnection {
  connectionId: string;
  rooms: [string, string];
  walls: ["east" | "north", "west" | "south"];
  normalAxis: "x" | "y";
  centerCm: [number, number, number];
  openingWidthCm: number;
  openingHeightCm: number;
  wallThicknessCm: number;
  doorInstanceId: string;
  thresholdInstanceId: string;
  wallInstanceIds: [string, string, string];
  supersededInstanceId: string;
  swingClearanceCm: number;
}

export interface ConnectedBuildingDefinition extends BuildingDefinition {
  revision: number;
  rooms: BuildingRoom[];
  connections: BuildingRoomConnection[];
  migration: { sourceRevision: number; preservedInstanceIds: string[]; removedInstanceIds: string[] };
}

export function persistentBuildingIdentity(buildingId: string, instanceId: string): string {
  return createHash("sha256").update(buildingActorIdentity(buildingId, instanceId)).digest("hex").slice(0, 32);
}

function reject(message: string): never {
  throw new ForgeAaaError(FORGE_AAA_ERRORS.MANIFEST_INVALID, message);
}
const validId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const finitePositive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
const vector = (value: unknown): value is [number, number, number] => Array.isArray(value) && value.length === 3 && value.every(v => typeof v === "number" && Number.isFinite(v));

export function validateConnectedBuilding(raw: unknown, registry: readonly BuildingModuleDefinition[]): ConnectedBuildingDefinition {
  const base = validateBuildingDefinition(raw, registry);
  const spec = base as ConnectedBuildingDefinition;
  if (spec.revision !== 2 || spec.migration?.sourceRevision !== 1) reject("unsupported connected building revision");
  if (!Array.isArray(spec.rooms) || spec.rooms.length < 2 || spec.rooms.length > 16 || !Array.isArray(spec.connections) || !spec.connections.length) reject("connected building requires rooms and explicit connections");
  if (!Array.isArray(spec.migration.preservedInstanceIds) || !Array.isArray(spec.migration.removedInstanceIds)) reject("missing migration identities");
  const instances = new Map(spec.instances.map(i => [i.instanceId, i]));
  const modules = new Map(registry.map(m => [m.moduleId, m]));
  const rooms = new Map<string, BuildingRoom>();
  const tolerance = Math.min(spec.attachmentToleranceCm, 0.5);
  const near = (a: number, b: number) => Math.abs(a - b) <= tolerance + 1e-6;
  const get = (id: string): BuildingModuleInstance => instances.get(id) ?? reject(`unresolved room instance: ${id}`);
  const dimensions = (i: BuildingModuleInstance): [number, number, number] => {
    const d = modules.get(i.moduleId)!.dimensions;
    return Math.abs(i.yawDeg % 180) === 90 ? [d.depthCm, d.widthCm, d.heightCm] : [d.widthCm, d.depthCm, d.heightCm];
  };
  for (const room of spec.rooms) {
    if (!room || !validId(room.roomId) || rooms.has(room.roomId)) reject("duplicate or invalid room identity");
    if (typeof room.purpose !== "string" || !room.purpose || !vector(room.centerCm) || !vector(room.interiorCm) || !room.interiorCm.every(finitePositive) || room.interiorCm[2] < 200) reject("invalid room dimensions or ceiling clearance");
    if (!Array.isArray(room.instanceIds) || !room.instanceIds.length || new Set(room.instanceIds).size !== room.instanceIds.length) reject("invalid room membership");
    for (const id of room.instanceIds) get(id);
    const floor = get(room.floorInstanceId), ceiling = get(room.ceilingInstanceId);
    if (!room.instanceIds.includes(floor.instanceId) || !room.instanceIds.includes(ceiling.instanceId) || modules.get(floor.moduleId)!.moduleType !== "floor" || modules.get(ceiling.moduleId)!.moduleType !== "roof") reject("missing room floor or ceiling");
    const fd = dimensions(floor), cd = dimensions(ceiling);
    if (!near(floor.positionCm[2] + fd[2] / 2, room.centerCm[2]) || !near(ceiling.positionCm[2] - cd[2] / 2, room.centerCm[2] + room.interiorCm[2])) reject("room floor or ceiling misaligned");
    for (const axis of [0, 1] as const) {
      if (!near(floor.positionCm[axis], room.centerCm[axis]) || !near(fd[axis], room.interiorCm[axis]) || Math.abs(ceiling.positionCm[axis] - room.centerCm[axis]) + room.interiorCm[axis] / 2 > cd[axis] / 2 + tolerance) reject("room geometry does not cover declared footprint");
    }
    rooms.set(room.roomId, room);
  }
  const seenConnections = new Set<string>(), seenDoors = new Set<string>();
  const graph = new Map([...rooms.keys()].map(id => [id, new Set<string>()]));
  for (const c of spec.connections) {
    if (!c || !validId(c.connectionId) || seenConnections.has(c.connectionId) || !Array.isArray(c.rooms) || c.rooms.length !== 2 || c.rooms[0] === c.rooms[1]) reject("duplicate or invalid connection identity");
    seenConnections.add(c.connectionId);
    const a = rooms.get(c.rooms[0]), b = rooms.get(c.rooms[1]);
    if (!a || !b || !vector(c.centerCm) || !["x", "y"].includes(c.normalAxis)) reject("unresolved connection rooms or orientation");
    const axis = c.normalAxis === "x" ? 0 : 1, along = axis === 0 ? 1 : 0;
    if (!Array.isArray(c.walls) || c.walls[0] !== (axis === 0 ? "east" : "north") || c.walls[1] !== (axis === 0 ? "west" : "south")) reject("invalid connecting wall orientation");
    if (![c.openingWidthCm, c.openingHeightCm, c.wallThicknessCm, c.swingClearanceCm].every(finitePositive) || c.openingWidthCm < 70 || c.openingHeightCm < 200 || c.openingHeightCm > Math.min(a.interiorCm[2], b.interiorCm[2])) reject("incompatible doorway dimensions");
    if (!near(a.centerCm[2], b.centerCm[2]) || !near(a.interiorCm[2], b.interiorCm[2]) || !near(c.centerCm[2], a.centerCm[2])) reject("connected floors or ceilings misaligned");
    if (!near(a.centerCm[axis] + a.interiorCm[axis] / 2 + c.wallThicknessCm / 2, c.centerCm[axis]) || !near(b.centerCm[axis] - b.interiorCm[axis] / 2 - c.wallThicknessCm / 2, c.centerCm[axis])) reject("rooms do not share the declared wall");
    for (const r of [a, b]) if (Math.abs(c.centerCm[along] - r.centerCm[along]) + c.openingWidthCm / 2 > r.interiorCm[along] / 2 || c.swingClearanceCm > r.interiorCm[axis]) reject("doorway or swing clearance outside room");
    const door = get(c.doorInstanceId), doorModule = modules.get(door.moduleId)!;
    if (seenDoors.has(door.instanceId) || doorModule.moduleType !== "door" || !doorModule.nativeClass || !door.attachment || !near(door.yawDeg % 180, axis === 0 ? 90 : 0) || !door.positionCm.every((v, n) => near(v, c.centerCm[n]!))) reject("invalid native interior door placement or identity");
    seenDoors.add(door.instanceId);
    if (doorModule.dimensions.widthCm > c.openingWidthCm || doorModule.dimensions.heightCm > c.openingHeightCm || c.swingClearanceCm < doorModule.dimensions.widthCm) reject("door or swing incompatible with opening");
    if (instances.has(c.supersededInstanceId) || !spec.migration.removedInstanceIds.includes(c.supersededInstanceId)) reject("solid shared wall was not superseded");
    if (!Array.isArray(c.wallInstanceIds) || c.wallInstanceIds.length !== 3 || new Set(c.wallInstanceIds).size !== 3) reject("shared wall requires two jamb segments and lintel");
    const [front, back, lintel] = c.wallInstanceIds.map(get) as [BuildingModuleInstance, BuildingModuleInstance, BuildingModuleInstance];
    const low = a.centerCm[along] - a.interiorCm[along] / 2 - c.wallThicknessCm;
    const high = a.centerCm[along] + a.interiorCm[along] / 2 + c.wallThicknessCm;
    for (const segment of [front, back, lintel]) if (modules.get(segment.moduleId)!.moduleType !== "wall" || !near(segment.positionCm[axis], c.centerCm[axis]) || !near(dimensions(segment)[axis], c.wallThicknessCm)) reject("invalid shared wall orientation or thickness");
    const f = dimensions(front), d = dimensions(back), l = dimensions(lintel);
    if (!near(front.positionCm[along] - f[along] / 2, low) || !near(front.positionCm[along] + f[along] / 2, c.centerCm[along] - c.openingWidthCm / 2) || !near(back.positionCm[along] - d[along] / 2, c.centerCm[along] + c.openingWidthCm / 2) || !near(back.positionCm[along] + d[along] / 2, high) || !near(front.positionCm[2] - f[2] / 2, c.centerCm[2]) || !near(back.positionCm[2] - d[2] / 2, c.centerCm[2]) || !near(f[2], a.interiorCm[2]) || !near(d[2], a.interiorCm[2]) || !near(l[along], c.openingWidthCm) || !near(lintel.positionCm[along], c.centerCm[along]) || !near(lintel.positionCm[2] - l[2] / 2, c.centerCm[2] + c.openingHeightCm) || !near(lintel.positionCm[2] + l[2] / 2, c.centerCm[2] + a.interiorCm[2])) reject("shared wall does not bound the declared traversable opening");
    const threshold = get(c.thresholdInstanceId), td = dimensions(threshold);
    if (modules.get(threshold.moduleId)!.moduleType !== "floor" || !near(td[axis], c.wallThicknessCm) || !near(td[along], c.openingWidthCm) || !near(threshold.positionCm[axis], c.centerCm[axis]) || !near(threshold.positionCm[along], c.centerCm[along]) || !near(threshold.positionCm[2] + td[2] / 2, c.centerCm[2])) reject("missing continuous doorway floor");
    for (const i of spec.instances) {
      if (modules.get(i.moduleId)!.nativeClass || i.instanceId === threshold.instanceId) continue;
      const size = dimensions(i);
      if (Math.abs(i.positionCm[axis] - c.centerCm[axis]) < (size[axis] + c.wallThicknessCm) / 2 - 0.01 && Math.abs(i.positionCm[along] - c.centerCm[along]) < (size[along] + c.openingWidthCm) / 2 - 0.01 && i.positionCm[2] + size[2] / 2 > c.centerCm[2] + 0.01 && i.positionCm[2] - size[2] / 2 < c.centerCm[2] + c.openingHeightCm - 0.01) reject("solid geometry blocks shared opening");
    }
    graph.get(a.roomId)!.add(b.roomId); graph.get(b.roomId)!.add(a.roomId);
  }
  const reached = new Set<string>();
  const visit = (id: string): void => { if (reached.has(id)) return; reached.add(id); for (const next of graph.get(id)!) visit(next); };
  visit(spec.rooms[0]!.roomId);
  if (reached.size !== rooms.size) reject("building contains disconnected rooms");
  for (const i of spec.instances) if (modules.get(i.moduleId)!.nativeClass && !i.attachment) reject("gameplay module requires explicit attachment");
  const nativeIds = spec.instances.filter(i => modules.get(i.moduleId)!.nativeClass).map(i => persistentBuildingIdentity(spec.buildingInstanceId, i.instanceId));
  if (new Set(nativeIds).size !== nativeIds.length) reject("conflicting persistent identities");
  if (new Set(spec.migration.preservedInstanceIds).size !== spec.migration.preservedInstanceIds.length || new Set(spec.migration.removedInstanceIds).size !== spec.migration.removedInstanceIds.length || spec.migration.preservedInstanceIds.some(id => !instances.has(id)) || spec.migration.removedInstanceIds.some(id => instances.has(id))) reject("invalid migration identity mapping");
  return structuredClone(spec);
}

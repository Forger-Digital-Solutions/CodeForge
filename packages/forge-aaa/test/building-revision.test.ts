import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { BuildingDefinition, BuildingModuleDefinition } from "../src/building-definition.js";
import {
  planMigration,
  validateMigration,
  applyMigration,
  verifyMigration,
  commitMigration,
  rollbackMigration,
  isMigrationIdempotent,
  migrationAssemblyScript,
  computeBuildingFingerprint,
  type BuildingRevisionMigration,
  type SavedLevelVerification,
} from "../src/building-revision.js";
import { FORGE_AAA_ERRORS, ForgeAaaError } from "../src/types.js";

function makeLevelEvidence(migration: BuildingRevisionMigration, phase: "COMMITTED" | "ROLLED_BACK", dir: string): SavedLevelVerification {
  const revision = phase === "COMMITTED" ? migration.targetRevision : migration.previousRevision;
  const levelFilePath = join(dir, "level.umap");
  const levelContent = Buffer.from(`fake-level:${revision.fingerprint}`);
  writeFileSync(levelFilePath, levelContent);
  const levelFileSha256 = createHash("sha256").update(levelContent).digest("hex");
  const receiptPath = join(dir, `${phase.toLowerCase()}-receipt.json`);
  const evidence: SavedLevelVerification = {
    migrationId: migration.migrationId,
    buildingId: migration.buildingId,
    fingerprint: revision.fingerprint,
    instanceCount: revision.instanceCount,
    levelPath: "/Game/Maps/TestLevel",
    levelFilePath,
    levelFileSha256,
    receiptPath,
    phase,
    level_saved: true,
    reloaded: true,
    actors_verified: true,
  };
  writeFileSync(receiptPath, JSON.stringify(evidence, null, 2));
  return evidence;
}

const floorModule: BuildingModuleDefinition = {
  contractVersion: 1,
  moduleVersion: 1,
  moduleId: "forge/floor/v1",
  moduleType: "floor",
  displayName: "Modular Floor",
  dimensions: { widthCm: 400, depthCm: 400, heightCm: 20 },
  pivot: { kind: "center" },
  sockets: [
    { id: "edge-pos-x", localPosCm: [400, 0, 0], accepts: ["floor"] },
  ],
  collision: { profile: "block-all" },
  provenance: { authoredBy: "deterministic" },
  engines: { unreal: ["4.27"] },
  sourceAsset: "floor.fbx",
  engineAsset: "/Game/ForgeAAA/R82/SM_Floor",
  coordinateSystem: "unreal-cm-z-up",
  materials: ["concrete"],
  dependencies: [],
  validationStatus: "geometry-verified",
};

const wallModule: BuildingModuleDefinition = {
  contractVersion: 1,
  moduleVersion: 1,
  moduleId: "forge/wall/v1",
  moduleType: "wall",
  displayName: "Modular Wall",
  dimensions: { widthCm: 400, depthCm: 20, heightCm: 260 },
  pivot: { kind: "center" },
  sockets: [
    { id: "end", localPosCm: [400, 0, 0], accepts: ["wall"] },
  ],
  collision: { profile: "block-all" },
  provenance: { authoredBy: "deterministic" },
  engines: { unreal: ["4.27"] },
  sourceAsset: "wall.fbx",
  engineAsset: "/Game/ForgeAAA/R82/SM_Wall",
  coordinateSystem: "unreal-cm-z-up",
  materials: ["drywall"],
  dependencies: [],
  validationStatus: "geometry-verified",
};

const registry: BuildingModuleDefinition[] = [floorModule, wallModule];

const createSingleRoom = (): BuildingDefinition => ({
  schemaVersion: 1,
  buildingInstanceId: "bldg-complex-1",
  attachmentToleranceCm: 0.5,
  instances: [
    {
      instanceId: "floor-1",
      moduleId: "forge/floor/v1",
      moduleVersion: 1,
      positionCm: [0, 0, 0],
      yawDeg: 0,
    },
    {
      instanceId: "wall-1",
      moduleId: "forge/wall/v1",
      moduleVersion: 1,
      positionCm: [0, 190, 140],
      yawDeg: 0,
    },
    {
      instanceId: "wall-2",
      moduleId: "forge/wall/v1",
      moduleVersion: 1,
      positionCm: [0, -190, 140],
      yawDeg: 0,
    },
  ],
});

const createTwoRoom = (): BuildingDefinition => ({
  schemaVersion: 1,
  buildingInstanceId: "bldg-complex-1",
  attachmentToleranceCm: 0.5,
  instances: [
    {
      instanceId: "floor-1",
      moduleId: "forge/floor/v1",
      moduleVersion: 1,
      positionCm: [0, 0, 0],
      yawDeg: 0,
    },
    {
      instanceId: "wall-1",
      moduleId: "forge/wall/v1",
      moduleVersion: 1,
      positionCm: [0, 190, 140],
      yawDeg: 0,
    },
    {
      instanceId: "wall-2",
      moduleId: "forge/wall/v1",
      moduleVersion: 1,
      positionCm: [0, -190, 140],
      yawDeg: 0,
    },
    {
      instanceId: "floor-2",
      moduleId: "forge/floor/v1",
      moduleVersion: 1,
      positionCm: [400, 0, 0],
      yawDeg: 0,
    },
    {
      instanceId: "wall-3",
      moduleId: "forge/wall/v1",
      moduleVersion: 1,
      positionCm: [400, 190, 140],
      yawDeg: 0,
    },
    {
      instanceId: "wall-4",
      moduleId: "forge/wall/v1",
      moduleVersion: 1,
      positionCm: [400, -190, 140],
      yawDeg: 0,
    },
  ],
});

describe("building revision migration system", () => {
  it("1. migrates valid 1-room to 2-room building, preserving original instances and adding new ones", () => {
    const singleRoom = createSingleRoom();
    const twoRoom = createTwoRoom();

    const migration = validateMigration(singleRoom, twoRoom, registry);

    expect(migration.buildingId).toBe("bldg-complex-1");
    expect(migration.status).toBe("VALIDATED");
    expect(migration.previousRevision.instanceCount).toBe(3);
    expect(migration.targetRevision.instanceCount).toBe(6);
    expect(migration.preservedInstances).toEqual(["floor-1", "wall-1", "wall-2"]);
    expect(migration.addedInstances).toEqual(["floor-2", "wall-3", "wall-4"]);
    expect(migration.modifiedInstances).toEqual([]);
    expect(migration.removedInstances).toEqual([]);
    expect(migration.validatedAt).toBeDefined();

    const pythonScript = migrationAssemblyScript(migration, twoRoom, registry, "/Game/Maps/TestLevel");
    expect(pythonScript).toContain("FORGEAAA_MIGRATION_REPORT:");
    expect(pythonScript).toContain(migration.previousRevision.fingerprint);
    expect(pythonScript).toContain(migration.targetRevision.fingerprint);
    expect(pythonScript).toContain("forge-revision:");
    expect(pythonScript).toContain("forge-building:bldg-complex-1:floor-1");
    expect(pythonScript).toContain("forge-building:bldg-complex-1:floor-2");
    expect(pythonScript).toContain("EditorLevelLibrary");
    expect(pythonScript).toContain("EditorAssetLibrary");
  });

  it("2. detects fingerprint conflicts when previous fingerprint does not match", () => {
    const singleRoom = createSingleRoom();
    const twoRoom = createTwoRoom();

    const migration = validateMigration(singleRoom, twoRoom, registry);

    const staleFingerprint = "0000000000000000000000000000000000000000000000000000000000000000";
    expect(() => applyMigration(migration, staleFingerprint)).toThrowError(ForgeAaaError);
    try {
      applyMigration(migration, staleFingerprint);
      expect.unreachable();
    } catch (err) {
      expect((err as ForgeAaaError).code).toBe(FORGE_AAA_ERRORS.MANIFEST_INVALID);
    }

    expect(() =>
      validateMigration(singleRoom, twoRoom, registry, {
        expectedPreviousFingerprint: staleFingerprint,
      })
    ).toThrowError(ForgeAaaError);
  });

  it("3. detects idempotent migrations accurately", () => {
    const singleRoom = createSingleRoom();
    const twoRoom = createTwoRoom();

    const forwardMigration = validateMigration(singleRoom, twoRoom, registry);
    expect(isMigrationIdempotent(forwardMigration).idempotent).toBe(false);

    expect(isMigrationIdempotent(forwardMigration, forwardMigration.targetRevision.fingerprint).idempotent).toBe(true);

    const identicalMigration = validateMigration(singleRoom, singleRoom, registry);
    expect(isMigrationIdempotent(identicalMigration).idempotent).toBe(true);
  });

  it("4. rejects invalid state transitions (e.g. applying already-committed migration)", () => {
    const singleRoom = createSingleRoom();
    const twoRoom = createTwoRoom();
    const dir = mkdtempSync(join(tmpdir(), "forge-migration-test-"));
    try {
      const migration = validateMigration(singleRoom, twoRoom, registry);
      const applying = applyMigration(migration, migration.previousRevision.fingerprint);
      const verifying = verifyMigration(applying);
      const evidence = makeLevelEvidence(migration, "COMMITTED", dir);
      const committed = commitMigration(verifying, evidence);

      expect(committed.status).toBe("COMMITTED");

      expect(() => applyMigration(committed, migration.previousRevision.fingerprint)).toThrowError(ForgeAaaError);
      try {
        applyMigration(committed, migration.previousRevision.fingerprint);
        expect.unreachable();
      } catch (err) {
        expect((err as ForgeAaaError).code).toBe(FORGE_AAA_ERRORS.OPERATION_DENIED);
      }

      expect(() => commitMigration(committed, evidence)).toThrowError(ForgeAaaError);
      expect(() => verifyMigration(committed)).toThrowError(ForgeAaaError);
      expect(() => commitMigration(migration, evidence)).toThrowError(ForgeAaaError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("5. handles removed instances during reverse migration", () => {
    const singleRoom = createSingleRoom();
    const twoRoom = createTwoRoom();

    const reverseMigration = validateMigration(twoRoom, singleRoom, registry);

    expect(reverseMigration.preservedInstances).toEqual(["floor-1", "wall-1", "wall-2"]);
    expect(reverseMigration.addedInstances).toEqual([]);
    expect(reverseMigration.modifiedInstances).toEqual([]);
    expect(reverseMigration.removedInstances).toEqual(["floor-2", "wall-3", "wall-4"]);

    const script = migrationAssemblyScript(reverseMigration, singleRoom, registry, "/Game/Maps/TestLevel");
    expect(script).toContain("spec[\"removedInstances\"]");
  });

  it("6. detects modified instances when transform or module changes", () => {
    const prev = createSingleRoom();
    const modified: BuildingDefinition = {
      ...createSingleRoom(),
      instances: [
        { ...prev.instances[0]!, yawDeg: 90 },
        { ...prev.instances[1]! },
        { ...prev.instances[2]! },
      ],
    };

    const migration = validateMigration(prev, modified, registry);
    expect(migration.modifiedInstances).toEqual(["floor-1"]);
    expect(migration.preservedInstances).toEqual(["wall-1", "wall-2"]);
    expect(migration.addedInstances).toEqual([]);
    expect(migration.removedInstances).toEqual([]);
  });

  it("7. rejects migration when module dependency is missing", () => {
    const singleRoom = createSingleRoom();
    const twoRoom = createTwoRoom();

    const moduleWithMissingDep: BuildingModuleDefinition = {
      ...floorModule,
      moduleId: "forge/floor/v2",
      dependencies: ["forge/dep-missing/v1"],
    };

    const registryWithMissingDep = [...registry, moduleWithMissingDep];

    const targetWithNewModule: BuildingDefinition = {
      ...twoRoom,
      instances: [
        ...singleRoom.instances,
        {
          instanceId: "floor-2",
          moduleId: "forge/floor/v2",
          moduleVersion: 1,
          positionCm: [400, 0, 0],
          yawDeg: 0,
        },
      ],
    };

    expect(() => validateMigration(singleRoom, targetWithNewModule, registryWithMissingDep)).toThrowError(ForgeAaaError);
    try {
      validateMigration(singleRoom, targetWithNewModule, registryWithMissingDep);
      expect.unreachable();
    } catch (err) {
      expect((err as ForgeAaaError).code).toBe(FORGE_AAA_ERRORS.MANIFEST_INVALID);
    }
  });

  it("8. advances to ROLLED_BACK with valid rollback evidence; blocks without it", () => {
    const singleRoom = createSingleRoom();
    const twoRoom = createTwoRoom();
    const dir = mkdtempSync(join(tmpdir(), "forge-migration-test-"));
    try {
      const migration = validateMigration(singleRoom, twoRoom, registry);
      const applying = applyMigration(migration, migration.previousRevision.fingerprint);
      const verifying = verifyMigration(applying);

      const blocked = commitMigration(verifying, false as unknown as SavedLevelVerification);
      expect(blocked.status).toBe("BLOCKED");

      const rollbackEvidence = makeLevelEvidence(migration, "ROLLED_BACK", dir);
      const rolledBack = rollbackMigration(verifying, rollbackEvidence);
      expect(rolledBack.status).toBe("ROLLED_BACK");
      expect(rolledBack.rolledBackAt).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("9. executes status transitions: PLANNED -> VALIDATED -> APPLYING -> VERIFYING -> COMMITTED", () => {
    const singleRoom = createSingleRoom();
    const twoRoom = createTwoRoom();
    const dir = mkdtempSync(join(tmpdir(), "forge-migration-test-"));
    try {
      const planned = planMigration(singleRoom, twoRoom, registry);
      expect(planned.status).toBe("PLANNED");

      const validated = validateMigration(planned, twoRoom, registry);
      expect(validated.status).toBe("VALIDATED");
      expect(validated.validatedAt).toBeDefined();

      const applying = applyMigration(validated, validated.previousRevision.fingerprint);
      expect(applying.status).toBe("APPLYING");
      expect(applying.appliedAt).toBeDefined();

      const verifying = verifyMigration(applying);
      expect(verifying.status).toBe("VERIFYING");

      const evidence = makeLevelEvidence(validated, "COMMITTED", dir);
      const committed = commitMigration(verifying, evidence);
      expect(committed.status).toBe("COMMITTED");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("10. executes status transitions: PLANNED -> VALIDATED -> APPLYING -> VERIFYING -> ROLLED_BACK", () => {
    const singleRoom = createSingleRoom();
    const twoRoom = createTwoRoom();
    const dir = mkdtempSync(join(tmpdir(), "forge-migration-test-"));
    try {
      const planned = planMigration(singleRoom, twoRoom, registry);
      expect(planned.status).toBe("PLANNED");

      const validated = validateMigration(planned, twoRoom, registry);
      expect(validated.status).toBe("VALIDATED");

      const applying = applyMigration(validated, validated.previousRevision.fingerprint);
      expect(applying.status).toBe("APPLYING");

      const verifying = verifyMigration(applying);
      expect(verifying.status).toBe("VERIFYING");

      const rollbackEvidence = makeLevelEvidence(validated, "ROLLED_BACK", dir);
      const rolledBack = rollbackMigration(verifying, rollbackEvidence);
      expect(rolledBack.status).toBe("ROLLED_BACK");
      expect(rolledBack.rolledBackAt).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

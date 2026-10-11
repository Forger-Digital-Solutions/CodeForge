/**
 * R83-F1/F2: Native two-room gameplay and SaveGame persistence verification.
 *
 * Uses ForgeGameplay C++ plugin and the two-room level assembled by r83-assemble-live.mjs.
 * Tests:
 *   F1a — Traversal Room A → through interior door → Room B
 *   F1b — Exterior door interaction (open)
 *   F1c — Interior door interaction (open, verify 90° yaw)
 *   F1d — Threshold crossing (real CharacterMovement)
 *   F1e — Wall collision (character cannot pass solid walls)
 *   F1f — Room B entry and movement
 *   F1g — Return Room B → Room A
 *   F1h — Window interaction
 *   F2a — Save gameplay state
 *   F2b — Restore in new process
 *   F2c — Instance independence (3 interactable actors separate)
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { UnrealAdapter } from "../../packages/forge-aaa/dist/index.js";

const root = path.resolve(".scratch");
const pilot = path.join(root, "r83pilot");
const project = path.join(pilot, "DeadTrailsWest.uproject");
const evidenceDir = "docs/evidence/r83-forgeaaa-autonomous-multiroom";
await mkdir(evidenceDir, { recursive: true });

const report = { startedAt: new Date().toISOString(), kind: "R83_NATIVE_GAMEPLAY" };
const evidenceFile = `${evidenceDir}/r83-gameplay-${Date.now()}.json`;
const persist = () => writeFile(evidenceFile, JSON.stringify(report, null, 2));

const unreal = new UnrealAdapter();
const install = (await unreal.detect()).installs.find(
  (i) => i.version.major === 4 && i.version.minor === 27
);
if (!install) throw new Error("UE4.27 not found");
report.engine = install;
await persist();

const R83_LEVEL = "/Game/ForgeAAA/Maps/FAAA_R83_TwoRoom";
const SAVE_SLOT = "ForgeR83TwoRoomTest";

// ──────────────────────────────────────────────────────────────────────
// Run 1: Full traversal from outside → Room A → Room B → save
// ──────────────────────────────────────────────────────────────────────
console.log("Run 1: Full traversal and save...");
report.run1 = await unreal.runNativeGameplay({
  projectPath: project,
  levelPath: R83_LEVEL,
  specPath: path.join(root, "r83-gameplay-spec.json"),
  reportPath: path.join(root, "r83-gameplay-report.json"),
  saveSlot: SAVE_SLOT,
  install,
  logPath: path.join(root, "r83-gameplay-run1.log"),
  timeoutMs: 240_000,
  actions: [
    // Start outside, move to door
    { op: "moveTo", target: [0, -60, 0], timeoutS: 10,
      expect: { arrived: true, minDisp: 50 } },
    // Face and open exterior door
    { op: "face", target: [0, -10, 107] },
    { op: "press", key: "E",
      expect: { dispatched: true, targetName: "forge-building:western-room-a:door" } },
    { op: "wait", durationS: 0.5 },
    { op: "expectDoor", door: "forge-building:western-room-a:door",
      state: "open", toleranceDeg: 5 },
    // Enter Room A
    { op: "moveTo", target: [0, 100, 0], timeoutS: 10,
      expect: { arrived: true } },
    // Cross Room A to interior door
    { op: "moveTo", target: [220, 260, 0], timeoutS: 15,
      expect: { arrived: true, minDisp: 200 } },
    // Face and open interior door (at X=290, yaw=90)
    { op: "face", target: [290, 260, 107] },
    { op: "press", key: "E",
      expect: { dispatched: true, targetName: "forge-building:western-room-a:door-interior" } },
    { op: "wait", durationS: 0.5 },
    { op: "expectDoor", door: "forge-building:western-room-a:door-interior",
      state: "open", toleranceDeg: 5 },
    // Cross threshold into Room B
    { op: "moveTo", target: [380, 260, 0], timeoutS: 10,
      expect: { arrived: true, minDisp: 80 } },
    // Move around Room B
    { op: "moveTo", target: [580, 260, 0], timeoutS: 10,
      expect: { arrived: true, minDisp: 180 } },
    // Verify cannot pass Room B east wall (wall-right-b at X=870)
    { op: "probe", from: [580, 260, 88], to: [900, 260, 88],
      expect: { blockingHit: true } },
    // Return through interior door to Room A
    { op: "moveTo", target: [180, 260, 0], timeoutS: 10,
      expect: { arrived: true, minDisp: 200 } },
    // Interact with window (back wall of Room A)
    { op: "face", target: [0, 520, 160] },
    { op: "press", key: "E",
      expect: { dispatched: true, targetName: "forge-building:western-room-a:window" } },
    { op: "wait", durationS: 0.5 },
    { op: "expectWindow", window: "forge-building:western-room-a:window",
      state: "open" },
    // Save state
    { op: "save",
      expect: {
        minSavedDoors: 2,  // exterior door + interior door
        minSavedWindows: 1,
      } },
    { op: "exit" },
  ],
});
await persist();

if (report.run1.state !== "pass") {
  console.error("Run 1 failed:", report.run1.state);
  // Do not abort — record and continue to restore test
  report.run1Failed = true;
}
console.log("Run 1:", report.run1.state, "metrics:", JSON.stringify(report.run1.metrics));

// ──────────────────────────────────────────────────────────────────────
// Run 2: Separate-process SaveGame restore
// ──────────────────────────────────────────────────────────────────────
console.log("Run 2: SaveGame restore in separate process...");
report.run2 = await unreal.runNativeGameplay({
  projectPath: project,
  levelPath: R83_LEVEL,
  specPath: path.join(root, "r83-gameplay-spec-restore.json"),
  reportPath: path.join(root, "r83-gameplay-report-restore.json"),
  saveSlot: SAVE_SLOT,
  install,
  logPath: path.join(root, "r83-gameplay-run2.log"),
  timeoutMs: 180_000,
  actions: [
    // Restore saved state — doors and window should be in saved states
    { op: "slotVerify",
      expect: {
        slotExists: true,
        loaded: true,
        doorStates: {
          "forge-building:western-room-a:door": 1,        // open
          "forge-building:western-room-a:door-interior": 1, // open
        },
        windowStates: {
          "forge-building:western-room-a:window": 1,      // open
        },
      } },
    // Verify exterior door still open from restored state
    { op: "expectDoor", door: "forge-building:western-room-a:door",
      state: "open", toleranceDeg: 5 },
    // Verify interior door still open
    { op: "expectDoor", door: "forge-building:western-room-a:door-interior",
      state: "open", toleranceDeg: 5 },
    // Verify window still open
    { op: "expectWindow", window: "forge-building:western-room-a:window",
      state: "open" },
    // Movement still works
    { op: "moveTo", target: [0, 100, 0], timeoutS: 10,
      expect: { arrived: true } },
    { op: "exit" },
  ],
});
await persist();
console.log("Run 2:", report.run2.state, "metrics:", JSON.stringify(report.run2.metrics));

// ──────────────────────────────────────────────────────────────────────
// Summary
// ──────────────────────────────────────────────────────────────────────
report.summary = {
  traversalOk: report.run1.state === "pass",
  saveGameRestoreOk: report.run2.state === "pass",
  run1State: report.run1.state,
  run2State: report.run2.state,
  level: R83_LEVEL,
  saveSlot: SAVE_SLOT,
};
report.finishedAt = new Date().toISOString();
await persist();
console.log(JSON.stringify({ evidenceFile, summary: report.summary }));

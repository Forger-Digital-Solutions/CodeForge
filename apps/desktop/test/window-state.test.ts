import { describe, expect, it } from "vitest";
import { parsePersistedWindowState, restoreWindowState, type WindowDisplay } from "../src/window-state.js";

const primary: WindowDisplay = { workArea: { x: 0, y: 0, width: 1366, height: 768 } };

describe("desktop window state", () => {
  it("centers and fits a first launch inside a 1366 by 768 work area", () => {
    const restored = restoreWindowState(undefined, primary, [primary]);
    expect(restored.bounds).toMatchObject({ width: 1318, height: 720 });
    expect(restored.bounds.x).toBeGreaterThanOrEqual(24);
    expect(restored.bounds.y).toBeGreaterThanOrEqual(24);
  });

  it("recovers a saved window from a removed display", () => {
    const restored = restoreWindowState({
      bounds: { x: -1600, y: 40, width: 1200, height: 800 },
      isMaximized: true,
    }, primary, [primary]);
    expect(restored.isMaximized).toBe(false);
    expect(restored.bounds.x).toBeGreaterThanOrEqual(24);
    expect(restored.bounds.y).toBeGreaterThanOrEqual(24);
  });

  it("clamps an oversized saved window after a resolution shrink", () => {
    const restored = restoreWindowState({
      bounds: { x: 800, y: 400, width: 2560, height: 1440 },
      isMaximized: false,
    }, primary, [primary]);
    expect(restored.bounds).toMatchObject({ width: 1318, height: 720, x: 24, y: 24 });
  });

  it("rejects malformed persisted state", () => {
    expect(parsePersistedWindowState({ bounds: { x: 1, y: 2, width: 0, height: 4 }, isMaximized: false })).toBeUndefined();
    expect(parsePersistedWindowState({ bounds: { x: 1, y: 2, width: 4, height: 4 }, isMaximized: "false" })).toBeUndefined();
  });
});

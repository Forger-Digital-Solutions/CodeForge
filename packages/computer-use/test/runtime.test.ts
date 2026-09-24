import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { GovernedComputerRuntime } from "../src/runtime.js";
import type { ComputerBackend, CapturedFrame, ScreenBounds, UiaElement } from "../src/backend.js";
import { COMPUTER_USE_ERRORS } from "../src/policy.js";

const BOUNDS: ScreenBounds = { x: 0, y: 0, width: 1920, height: 1080 };
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function uiaEl(partial: Partial<UiaElement> & { runtimeId: string }): UiaElement {
  return {
    name: "",
    automationId: "",
    controlType: "ControlType.Button",
    className: "Button",
    processId: 1,
    enabled: true,
    offscreen: false,
    hasKeyboardFocus: false,
    bounds: { x: 100, y: 100, width: 80, height: 30 },
    ...partial,
  };
}

class FakeBackend implements ComputerBackend {
  supported = true;
  calls: string[] = [];
  uiTrees: UiaElement[][] = [[]];
  isSupported(): boolean { return this.supported; }
  async screenBounds(): Promise<ScreenBounds> { return BOUNDS; }
  async capturePng(): Promise<CapturedFrame> { this.calls.push("capture"); return { png: PNG_BYTES, bounds: BOUNDS }; }
  async uiaElements(max: number): Promise<UiaElement[]> {
    this.calls.push("uia");
    const tree = this.uiTrees.length > 1 ? this.uiTrees.shift()! : this.uiTrees[0];
    return tree.slice(0, max);
  }
  async setCursorPosition(x: number, y: number): Promise<void> { this.calls.push(`move:${x},${y}`); }
  async click(x: number, y: number, b: string, c: number): Promise<void> { this.calls.push(`click:${b}x${c}@${x},${y}`); }
  async typeText(t: string): Promise<void> { this.calls.push(`type:${t}`); }
  async pressKeys(vks: number[]): Promise<void> { this.calls.push(`keys:${vks.join(",")}`); }
}

function runtime(backend: FakeBackend, extra: Record<string, unknown> = {}, now: () => number = () => Date.now()) {
  return new GovernedComputerRuntime({
    backend,
    evidenceDir: mkdtempSync(path.join(os.tmpdir(), "cf-cu-evid-")),
    now,
    ...extra,
  });
}

describe("GovernedComputerRuntime", () => {
  let backend: FakeBackend;
  beforeEach(() => { backend = new FakeBackend(); });

  it("reports unsupported platform without touching the backend", async () => {
    backend.supported = false;
    const rt = runtime(backend);
    const status = await rt.status();
    expect(status.supported).toBe(false);
    await expect(rt.screenshot()).rejects.toMatchObject({ code: COMPUTER_USE_ERRORS.COMPUTER_UNSUPPORTED });
    await expect(rt.click(10, 10, "left", 1)).rejects.toMatchObject({ code: COMPUTER_USE_ERRORS.COMPUTER_UNSUPPORTED });
    expect(backend.calls).toHaveLength(0);
  });

  it("persists screenshots as sha256-hashed evidence with a receipt", async () => {
    const rt = runtime(backend);
    const receipt = await rt.screenshot();
    expect(receipt.sha256).toBe(createHash("sha256").update(PNG_BYTES).digest("hex"));
    expect(existsSync(receipt.path)).toBe(true);
    expect(readFileSync(receipt.path).equals(PNG_BYTES)).toBe(true);
    expect(receipt.bounds).toEqual(BOUNDS);
    const status = await rt.status();
    expect(status.screenshotsTaken).toBe(1);
  });

  it("rejects coordinates outside screen bounds before any backend call", async () => {
    const rt = runtime(backend);
    await expect(rt.moveMouse(-5, 10)).rejects.toMatchObject({ code: COMPUTER_USE_ERRORS.COMPUTER_INVALID_TARGET });
    await expect(rt.moveMouse(10, 2000)).rejects.toMatchObject({ code: COMPUTER_USE_ERRORS.COMPUTER_INVALID_TARGET });
    await expect(rt.click(5000, 10, "left", 1)).rejects.toMatchObject({ code: COMPUTER_USE_ERRORS.COMPUTER_INVALID_TARGET });
    expect(backend.calls).toHaveLength(0);
  });

  it("rejects non-finite coordinates", async () => {
    const rt = runtime(backend);
    await expect(rt.moveMouse(Number.NaN, 10)).rejects.toMatchObject({ code: COMPUTER_USE_ERRORS.COMPUTER_INVALID_TARGET });
    await expect(rt.moveMouse(10, Number.POSITIVE_INFINITY)).rejects.toMatchObject({ code: COMPUTER_USE_ERRORS.COMPUTER_INVALID_TARGET });
  });

  it("enforces the session input-action budget", async () => {
    let t = 0;
    const rt = runtime(backend, { policy: { maxActionsPerSession: 2, minActionIntervalMs: 0 } }, () => t);
    await rt.moveMouse(1, 1);
    t += 10;
    await rt.moveMouse(2, 2);
    t += 10;
    await expect(rt.moveMouse(3, 3)).rejects.toMatchObject({ code: COMPUTER_USE_ERRORS.COMPUTER_BUDGET_EXHAUSTED });
    expect(backend.calls.filter((c) => c.startsWith("move"))).toHaveLength(2);
  });

  it("rate-limits consecutive input actions", async () => {
    let t = 1000;
    const rt = runtime(backend, { policy: { minActionIntervalMs: 500 } }, () => t);
    await rt.moveMouse(1, 1);
    t += 100;
    await expect(rt.moveMouse(2, 2)).rejects.toMatchObject({ code: COMPUTER_USE_ERRORS.COMPUTER_RATE_LIMITED });
    t += 500;
    await rt.moveMouse(2, 2);
    expect(backend.calls.filter((c) => c.startsWith("move"))).toHaveLength(2);
  });

  it("does not rate-limit screenshots against input actions", async () => {
    const rt = runtime(backend, { policy: { minActionIntervalMs: 60_000 } });
    await rt.moveMouse(1, 1);
    await rt.screenshot();
    expect(backend.calls).toEqual(["move:1,1", "capture"]);
  });

  it("caps type_text length at the policy maximum", async () => {
    const rt = runtime(backend, { policy: { maxTypeLength: 5, minActionIntervalMs: 0 } });
    await expect(rt.typeText("123456")).rejects.toMatchObject({ code: COMPUTER_USE_ERRORS.COMPUTER_INVALID_TARGET });
    await expect(rt.typeText("")).rejects.toMatchObject({ code: COMPUTER_USE_ERRORS.COMPUTER_INVALID_TARGET });
    await rt.typeText("12345");
    expect(backend.calls).toEqual(["type:12345"]);
  });

  it("maps allowed key names to VK codes and rejects unknown names", async () => {
    const rt = runtime(backend, { policy: { minActionIntervalMs: 0 } });
    await rt.keyPress(["ctrl", "c"]);
    expect(backend.calls).toEqual(["keys:17,67"]);
    await expect(rt.keyPress(["rm", "-rf"])).rejects.toMatchObject({ code: COMPUTER_USE_ERRORS.COMPUTER_INVALID_KEY });
    await expect(rt.keyPress([])).rejects.toMatchObject({ code: COMPUTER_USE_ERRORS.COMPUTER_INVALID_KEY });
    await expect(rt.keyPress(["a", "b", "c", "d", "e", "f", "g"])).rejects.toMatchObject({ code: COMPUTER_USE_ERRORS.COMPUTER_INVALID_KEY });
  });

  it("clicks carry button and count through to the backend", async () => {
    const rt = runtime(backend, { policy: { minActionIntervalMs: 0 } });
    await rt.click(100, 200, "right", 2);
    expect(backend.calls).toEqual(["click:rightx2@100,200"]);
  });

  it("inspects the UI Automation tree without consuming action budget", async () => {
    backend.uiTrees = [[
      uiaEl({ runtimeId: "1.1", name: "Save", controlType: "ControlType.Button", automationId: "saveBtn" }),
      uiaEl({ runtimeId: "1.2", name: "Search", controlType: "ControlType.Edit", automationId: "searchBox", bounds: { x: 10, y: 10, width: 200, height: 24 } }),
    ]];
    const rt = runtime(backend, { policy: { minActionIntervalMs: 0, maxActionsPerSession: 1 } });
    const inspection = await rt.inspectUi();
    expect(inspection.elementCount).toBe(2);
    expect(inspection.treeHash).toMatch(/^[0-9a-f]{64}$/);
    const filtered = await rt.inspectUi({ controlType: "Edit" });
    expect(filtered.elementCount).toBe(1);
    expect(filtered.elements[0].automationId).toBe("searchBox");
    expect(backend.calls).toEqual(["uia", "uia"]);
    const status = await rt.status();
    expect(status.actionsUsed).toBe(0);
  });

  it("excludes offscreen elements by default but includes them on request", async () => {
    backend.uiTrees = [[
      uiaEl({ runtimeId: "1.1", name: "Hidden Btn", offscreen: true }),
      uiaEl({ runtimeId: "1.2", name: "Visible Btn" }),
    ]];
    const rt = runtime(backend, { policy: { minActionIntervalMs: 0 } });
    expect((await rt.inspectUi()).elementCount).toBe(1);
    expect((await rt.inspectUi({ includeOffscreen: true })).elementCount).toBe(2);
  });

  it("resolves a semantic target to its centre and clicks it with verification", async () => {
    backend.uiTrees = [[
      uiaEl({ runtimeId: "1.1", name: "OK", automationId: "okBtn", bounds: { x: 200, y: 300, width: 100, height: 40 } }),
      // After the click the dialog closed: the element is gone from the re-grounded tree.
    ], []];
    const rt = runtime(backend, { policy: { minActionIntervalMs: 0 } });
    const receipt = await rt.clickElement({ name: "OK" }, "left", 1);
    expect(backend.calls).toEqual(["uia", "click:leftx1@250,320", "uia"]);
    expect(receipt.point).toEqual({ x: 250, y: 320 });
    expect(receipt.target?.automationId).toBe("okBtn");
    expect(receipt.verification.targetAfter).toBe("gone");
    expect(receipt.verification.uiChanged).toBe(true);
  });

  it("fails closed when a semantic query matches nothing", async () => {
    backend.uiTrees = [[uiaEl({ runtimeId: "1.1", name: "Cancel" })]];
    const rt = runtime(backend, { policy: { minActionIntervalMs: 0 } });
    await expect(rt.clickElement({ name: "OK" }, "left", 1)).rejects.toMatchObject({ code: COMPUTER_USE_ERRORS.COMPUTER_TARGET_NOT_FOUND });
    expect(backend.calls.filter((c) => c.startsWith("click"))).toHaveLength(0);
  });

  it("fails closed when a semantic query is ambiguous", async () => {
    backend.uiTrees = [[
      uiaEl({ runtimeId: "1.1", name: "OK", processId: 1 }),
      uiaEl({ runtimeId: "1.2", name: "OK", processId: 2 }),
    ]];
    const rt = runtime(backend, { policy: { minActionIntervalMs: 0 } });
    await expect(rt.clickElement({ name: "OK" }, "left", 1)).rejects.toMatchObject({ code: COMPUTER_USE_ERRORS.COMPUTER_AMBIGUOUS_TARGET });
    // processId disambiguates the same query.
    const receipt = await rt.clickElement({ name: "OK", processId: 2 }, "left", 1);
    expect(receipt.target?.bounds).toBeDefined();
    expect(backend.calls.filter((c) => c.startsWith("click"))).toHaveLength(1);
  });

  it("re-grounds after UI change: a stale target fails closed instead of acting on coordinates", async () => {
    backend.uiTrees = [
      [uiaEl({ runtimeId: "1.1", name: "Submit", bounds: { x: 100, y: 100, width: 80, height: 30 } })],
      [uiaEl({ runtimeId: "2.9", name: "Submit", bounds: { x: 900, y: 900, width: 80, height: 30 } })],
    ];
    const rt = runtime(backend, { policy: { minActionIntervalMs: 0 } });
    const first = await rt.locateElement({ name: "Submit" });
    expect(first.element.runtimeId).toBe("1.1");
    // The UI changed (dialog rebuilt): the same semantic query resolves the NEW element —
    // grounding happens per call, never from a cached element.
    const second = await rt.locateElement({ name: "Submit" });
    expect(second.element.runtimeId).toBe("2.9");
    expect(second.center).toEqual({ x: 940, y: 915 });
  });

  it("types into an element after focusing it, and reports focus in verification", async () => {
    backend.uiTrees = [[
      uiaEl({ runtimeId: "1.1", name: "Search", controlType: "ControlType.Edit", bounds: { x: 10, y: 10, width: 200, height: 24 } }),
    ], [
      uiaEl({ runtimeId: "1.1", name: "Search", controlType: "ControlType.Edit", hasKeyboardFocus: true, bounds: { x: 10, y: 10, width: 200, height: 24 } }),
    ]];
    const rt = runtime(backend, { policy: { minActionIntervalMs: 0 } });
    const receipt = await rt.typeIntoElement({ controlType: "Edit" }, "hello");
    expect(backend.calls).toEqual(["uia", "click:leftx1@110,22", "type:hello", "uia"]);
    expect(receipt.verification.hasKeyboardFocus).toBe(true);
    expect(receipt.verification.targetAfter).toBe("changed");
  });

  it("enforces the action budget and interval on semantic actions too", async () => {
    backend.uiTrees = [[uiaEl({ runtimeId: "1.1", name: "Btn" })]];
    let t = 0;
    const rt = runtime(backend, { policy: { maxActionsPerSession: 1, minActionIntervalMs: 0 } }, () => t);
    await rt.clickElement({ name: "Btn" }, "left", 1);
    await expect(rt.clickElement({ name: "Btn" }, "left", 1)).rejects.toMatchObject({ code: COMPUTER_USE_ERRORS.COMPUTER_BUDGET_EXHAUSTED });
    const rt2 = runtime(backend, { policy: { minActionIntervalMs: 1000 } }, () => t);
    t = 1000;
    await rt2.clickElement({ name: "Btn" }, "left", 1);
    t += 100;
    await expect(rt2.clickElement({ name: "Btn" }, "left", 1)).rejects.toMatchObject({ code: COMPUTER_USE_ERRORS.COMPUTER_RATE_LIMITED });
  });

  it("requires at least one query field for a semantic action", async () => {
    const rt = runtime(backend, { policy: { minActionIntervalMs: 0 } });
    await expect(rt.clickElement({}, "left", 1)).rejects.toMatchObject({ code: COMPUTER_USE_ERRORS.COMPUTER_INVALID_TARGET });
  });
});

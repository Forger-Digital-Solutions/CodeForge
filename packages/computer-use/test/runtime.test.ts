import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { GovernedComputerRuntime } from "../src/runtime.js";
import type { ComputerBackend, CapturedFrame, ScreenBounds } from "../src/backend.js";
import { COMPUTER_USE_ERRORS } from "../src/policy.js";

const BOUNDS: ScreenBounds = { x: 0, y: 0, width: 1920, height: 1080 };
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

class FakeBackend implements ComputerBackend {
  supported = true;
  calls: string[] = [];
  isSupported(): boolean { return this.supported; }
  async screenBounds(): Promise<ScreenBounds> { return BOUNDS; }
  async capturePng(): Promise<CapturedFrame> { this.calls.push("capture"); return { png: PNG_BYTES, bounds: BOUNDS }; }
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
});

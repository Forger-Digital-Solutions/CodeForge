import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GovernedComputerRuntime } from "../src/runtime.js";
import { createComputerToolExecutor, COMPUTER_TOOL_DEFINITIONS } from "../src/tools.js";
import { WindowsComputerBackend, type RunnerResult } from "../src/backend.js";
import type { ComputerBackend, CapturedFrame, ScreenBounds, UiaElement } from "../src/backend.js";
import { COMPUTER_USE_ERRORS, keyNameToVk } from "../src/policy.js";

const BOUNDS: ScreenBounds = { x: 0, y: 0, width: 800, height: 600 };

class FakeBackend implements ComputerBackend {
  elements: UiaElement[] = [];
  isSupported(): boolean { return true; }
  async screenBounds(): Promise<ScreenBounds> { return BOUNDS; }
  async capturePng(): Promise<CapturedFrame> { return { png: Buffer.from("PNGDATA"), bounds: BOUNDS }; }
  async uiaElements(max: number): Promise<UiaElement[]> { return this.elements.slice(0, max); }
  async setCursorPosition(): Promise<void> {}
  async click(): Promise<void> {}
  async typeText(): Promise<void> {}
  async pressKeys(): Promise<void> {}
}

function makeExecutor() {
  const rt = new GovernedComputerRuntime({
    backend: new FakeBackend(),
    evidenceDir: mkdtempSync(path.join(os.tmpdir(), "cf-cu-evid-")),
    policy: { minActionIntervalMs: 0 },
  });
  return createComputerToolExecutor(rt);
}

describe("computer tool definitions", () => {
  it("exposes a nine-tool surface, all executeCommand-gated", () => {
    expect(COMPUTER_TOOL_DEFINITIONS.map((d) => d.name)).toEqual([
      "computer_status",
      "computer_screenshot",
      "computer_inspect_ui",
      "computer_click_element",
      "computer_type_into_element",
      "computer_mouse_move",
      "computer_mouse_click",
      "computer_type_text",
      "computer_key_press",
    ]);
    for (const def of COMPUTER_TOOL_DEFINITIONS) {
      expect(def.requiredPermission).toBe("executeCommand");
    }
    expect(COMPUTER_TOOL_DEFINITIONS.find((d) => d.name === "computer_screenshot")?.readOnly).toBe(true);
    expect(COMPUTER_TOOL_DEFINITIONS.find((d) => d.name === "computer_inspect_ui")?.readOnly).toBe(true);
    expect(COMPUTER_TOOL_DEFINITIONS.find((d) => d.name === "computer_mouse_click")?.readOnly).toBe(false);
    expect(COMPUTER_TOOL_DEFINITIONS.find((d) => d.name === "computer_click_element")?.readOnly).toBe(false);
  });
});

describe("computer tool executor", () => {
  it("returns undefined for non-computer tools", async () => {
    const exec = makeExecutor();
    expect(await exec("browser_launch", {})).toBeUndefined();
    expect(await exec("run_command", {})).toBeUndefined();
  });

  it("wraps outputs as untrusted data", async () => {
    const exec = makeExecutor();
    const out = await exec("computer_status", {});
    expect(out).toContain("supported");
    expect(out).toMatch(/untrusted/i);
  });

  it("screenshot returns a receipt, not image bytes", async () => {
    const exec = makeExecutor();
    const out = await exec("computer_screenshot", {});
    expect(out).toContain("sha256");
    expect(out).toContain(".png");
    expect(out).not.toContain("UE5HREFUQQ"); // no base64 image payload
  });

  it("validates coordinate args", async () => {
    const exec = makeExecutor();
    await expect(exec("computer_mouse_move", { x: "abc", y: 1 })).rejects.toMatchObject({ code: COMPUTER_USE_ERRORS.COMPUTER_INVALID_TARGET });
    await expect(exec("computer_mouse_click", { x: 1 })).rejects.toMatchObject({ code: COMPUTER_USE_ERRORS.COMPUTER_INVALID_TARGET });
  });

  it("validates type_text arg type", async () => {
    const exec = makeExecutor();
    await expect(exec("computer_type_text", { text: 42 })).rejects.toMatchObject({ code: COMPUTER_USE_ERRORS.COMPUTER_INVALID_TARGET });
  });

  it("keyPress rejects unknown key names through the executor", async () => {
    const exec = makeExecutor();
    await expect(exec("computer_key_press", { keys: ["definitely-not-a-key"] })).rejects.toMatchObject({ code: COMPUTER_USE_ERRORS.COMPUTER_INVALID_KEY });
    await exec("computer_key_press", { keys: ["ctrl", "shift", "escape"] });
  });

  it("validates semantic query args", async () => {
    const exec = makeExecutor();
    await expect(exec("computer_click_element", { name: 42 })).rejects.toMatchObject({ code: COMPUTER_USE_ERRORS.COMPUTER_INVALID_TARGET });
    await expect(exec("computer_type_into_element", { name: "x" })).rejects.toMatchObject({ code: COMPUTER_USE_ERRORS.COMPUTER_INVALID_TARGET });
  });

  it("dispatches semantic tools and returns verification receipts", async () => {
    const rt = new GovernedComputerRuntime({
      backend: new FakeBackend(),
      evidenceDir: mkdtempSync(path.join(os.tmpdir(), "cf-cu-evid-")),
      policy: { minActionIntervalMs: 0 },
    });
    const exec = createComputerToolExecutor(rt);
    const out = await exec("computer_inspect_ui", { controlType: "Edit" });
    expect(out).toMatch(/untrusted/i);
    expect(out).toContain("elementCount");
    await expect(exec("computer_click_element", { name: "nope" })).rejects.toMatchObject({ code: COMPUTER_USE_ERRORS.COMPUTER_TARGET_NOT_FOUND });
  });
});

describe("keyNameToVk", () => {
  it("maps named keys and single characters", () => {
    expect(keyNameToVk("enter")).toBe(0x0d);
    expect(keyNameToVk("ctrl")).toBe(0x11);
    expect(keyNameToVk("f5")).toBe(0x74);
    expect(keyNameToVk("c")).toBe(67);
    expect(keyNameToVk("5")).toBe(53);
    expect(keyNameToVk("notakey")).toBeUndefined();
    expect(keyNameToVk(";")).toBeUndefined();
  });
});

describe("WindowsComputerBackend", () => {
  const okRunner = (captured: string[]) => async (script: string): Promise<RunnerResult> => {
    captured.push(script);
    return { code: 0, stdout: '{"X":0,"Y":0,"Width":1920,"Height":1080}', stderr: "" };
  };

  it("is supported only on win32", () => {
    const backend = new WindowsComputerBackend(async () => ({ code: 0, stdout: "", stderr: "" }));
    expect(backend.isSupported()).toBe(process.platform === "win32");
  });

  it("parses screen bounds from backend output", async () => {
    const backend = new WindowsComputerBackend(okRunner([]));
    if (process.platform === "win32") {
      const bounds = await backend.screenBounds();
      expect(bounds).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
    }
  });

  it("fails closed on non-zero backend exits", async () => {
    const backend = new WindowsComputerBackend(async () => ({ code: 1, stdout: "", stderr: "access denied" }));
    if (process.platform === "win32") {
      await expect(backend.screenBounds()).rejects.toMatchObject({ code: COMPUTER_USE_ERRORS.COMPUTER_BACKEND_FAILED });
    }
  });

  it("emits SendInput UNICODE units for typeText", async () => {
    const scripts: string[] = [];
    const backend = new WindowsComputerBackend(okRunner(scripts));
    if (process.platform === "win32") {
      await backend.typeText("Hi");
      expect(scripts[0]).toContain("SendUnicodeKey(72)"); // 'H'
      expect(scripts[0]).toContain("SendUnicodeKey(105)"); // 'i'
    }
  });
});

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  ComputerUseError,
  COMPUTER_USE_ERRORS,
  DEFAULT_COMPUTER_USE_POLICY,
  keyNameToVk,
  type ComputerUsePolicy,
} from "./policy.js";
import type { ComputerBackend, ScreenBounds, UiaElement } from "./backend.js";
import { WindowsComputerBackend } from "./backend.js";

/**
 * Governed computer-use runtime. Every action passes policy checks before reaching the
 * backend: coordinates must land inside the live screen bounds, input actions draw down a
 * session budget, and a minimum interval paces them. Screenshots persist as hashed evidence
 * — the model receives a receipt, never raw image bytes through this surface.
 */

export interface ComputerActionReceipt {
  action: string;
  at: string;
  detail?: string;
}

export interface ScreenshotReceipt {
  path: string;
  sha256: string;
  bounds: ScreenBounds;
  takenAt: string;
}

export interface ComputerStatus {
  supported: boolean;
  bounds?: ScreenBounds;
  actionsUsed: number;
  maxActionsPerSession: number;
  minActionIntervalMs: number;
  screenshotsTaken: number;
}

/**
 * A semantic target: the operator names what they see, the runtime resolves it against the
 * live UI Automation tree. `name` matches exactly (case-insensitive); `nameContains` is a
 * substring test. `controlType` matches the tail of UIA programmatic names ("Button" covers
 * "ControlType.Button"). Every field narrows the match — the query must resolve to exactly
 * one element before any input is dispatched.
 */
export interface UiaQuery {
  name?: string;
  nameContains?: string;
  automationId?: string;
  controlType?: string;
  processId?: number;
  includeOffscreen?: boolean;
}

export interface UiInspection {
  elementCount: number;
  truncated: boolean;
  elements: UiaElement[];
  /** Hash of the serialized element set — two inspections can be diffed for UI changes. */
  treeHash: string;
  takenAt: string;
}

export interface VerifiedActionReceipt extends ComputerActionReceipt {
  target?: { name: string; automationId: string; controlType: string; bounds: ScreenBounds };
  point?: { x: number; y: number };
  verification: {
    /** Whether the post-action tree differs from the pre-action tree. */
    uiChanged: boolean;
    /** State of the targeted element after the action, re-resolved by runtimeId. */
    targetAfter: "unchanged" | "changed" | "gone";
    hasKeyboardFocus?: boolean;
  };
}

export interface GovernedComputerRuntimeOptions {
  backend?: ComputerBackend;
  policy?: Partial<ComputerUsePolicy>;
  evidenceDir: string;
  now?: () => number;
}

export class GovernedComputerRuntime {
  private readonly backend: ComputerBackend;
  private readonly policy: ComputerUsePolicy;
  private readonly evidenceDir: string;
  private readonly now: () => number;
  private actionsUsed = 0;
  private lastActionAt = 0;
  private screenshotsTaken = 0;

  constructor(options: GovernedComputerRuntimeOptions) {
    this.backend = options.backend ?? new WindowsComputerBackend();
    this.policy = { ...DEFAULT_COMPUTER_USE_POLICY, ...options.policy };
    this.evidenceDir = options.evidenceDir;
    this.now = options.now ?? (() => Date.now());
  }

  private requireSupported(): void {
    if (!this.backend.isSupported()) {
      throw new ComputerUseError(
        COMPUTER_USE_ERRORS.COMPUTER_UNSUPPORTED,
        `computer use is not supported on platform '${process.platform}'`,
      );
    }
  }

  private async checkTarget(x: number, y: number): Promise<void> {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new ComputerUseError(COMPUTER_USE_ERRORS.COMPUTER_INVALID_TARGET, "coordinates must be finite numbers");
    }
    const bounds = await this.backend.screenBounds();
    if (x < bounds.x || y < bounds.y || x >= bounds.x + bounds.width || y >= bounds.y + bounds.height) {
      throw new ComputerUseError(
        COMPUTER_USE_ERRORS.COMPUTER_INVALID_TARGET,
        `(${x},${y}) is outside screen bounds ${JSON.stringify(bounds)}`,
      );
    }
  }

  private consumeActionBudget(): void {
    const elapsed = this.now() - this.lastActionAt;
    if (this.lastActionAt !== 0 && elapsed < this.policy.minActionIntervalMs) {
      throw new ComputerUseError(
        COMPUTER_USE_ERRORS.COMPUTER_RATE_LIMITED,
        `input actions are limited to one per ${this.policy.minActionIntervalMs}ms`,
      );
    }
    if (this.actionsUsed >= this.policy.maxActionsPerSession) {
      throw new ComputerUseError(
        COMPUTER_USE_ERRORS.COMPUTER_BUDGET_EXHAUSTED,
        `session input-action budget (${this.policy.maxActionsPerSession}) exhausted`,
      );
    }
    this.actionsUsed += 1;
    this.lastActionAt = this.now();
  }

  async status(): Promise<ComputerStatus> {
    const supported = this.backend.isSupported();
    let bounds: ScreenBounds | undefined;
    if (supported) {
      try {
        bounds = await this.backend.screenBounds();
      } catch {
        bounds = undefined;
      }
    }
    return {
      supported,
      bounds,
      actionsUsed: this.actionsUsed,
      maxActionsPerSession: this.policy.maxActionsPerSession,
      minActionIntervalMs: this.policy.minActionIntervalMs,
      screenshotsTaken: this.screenshotsTaken,
    };
  }

  async screenshot(): Promise<ScreenshotReceipt> {
    this.requireSupported();
    const frame = await this.backend.capturePng(this.policy.allowMultiMonitor);
    if (frame.png.length === 0) {
      throw new ComputerUseError(COMPUTER_USE_ERRORS.COMPUTER_BACKEND_FAILED, "capture returned an empty frame");
    }
    const sha256 = createHash("sha256").update(frame.png).digest("hex");
    mkdirSync(this.evidenceDir, { recursive: true });
    const file = path.join(this.evidenceDir, `computer-${new Date(this.now()).toISOString().replace(/[:.]/g, "-")}-${sha256.slice(0, 8)}.png`);
    writeFileSync(file, frame.png);
    this.screenshotsTaken += 1;
    return { path: file, sha256, bounds: frame.bounds, takenAt: new Date(this.now()).toISOString() };
  }

  async moveMouse(x: number, y: number): Promise<ComputerActionReceipt> {
    this.requireSupported();
    await this.checkTarget(x, y);
    this.consumeActionBudget();
    await this.backend.setCursorPosition(x, y);
    return { action: "computer_mouse_move", at: new Date(this.now()).toISOString(), detail: `(${x},${y})` };
  }

  async click(x: number, y: number, button: "left" | "right" | "middle", clicks: number): Promise<ComputerActionReceipt> {
    this.requireSupported();
    await this.checkTarget(x, y);
    this.consumeActionBudget();
    await this.backend.click(x, y, button, clicks);
    return { action: "computer_mouse_click", at: new Date(this.now()).toISOString(), detail: `${button} x${clicks} at (${x},${y})` };
  }

  async typeText(text: string): Promise<ComputerActionReceipt> {
    this.requireSupported();
    if (text.length === 0 || text.length > this.policy.maxTypeLength) {
      throw new ComputerUseError(
        COMPUTER_USE_ERRORS.COMPUTER_INVALID_TARGET,
        `text length must be 1..${this.policy.maxTypeLength} characters`,
      );
    }
    this.consumeActionBudget();
    await this.backend.typeText(text);
    return { action: "computer_type_text", at: new Date(this.now()).toISOString(), detail: `${text.length} chars` };
  }

  async keyPress(keyNames: string[]): Promise<ComputerActionReceipt> {
    this.requireSupported();
    if (keyNames.length === 0 || keyNames.length > 6) {
      throw new ComputerUseError(COMPUTER_USE_ERRORS.COMPUTER_INVALID_KEY, "key list must contain 1..6 key names");
    }
    const vks: number[] = [];
    for (const name of keyNames) {
      const vk = keyNameToVk(name);
      if (vk === undefined) {
        throw new ComputerUseError(COMPUTER_USE_ERRORS.COMPUTER_INVALID_KEY, `unknown key name '${name}'`);
      }
      vks.push(vk);
    }
    this.consumeActionBudget();
    await this.backend.pressKeys(vks);
    return { action: "computer_key_press", at: new Date(this.now()).toISOString(), detail: keyNames.join("+") };
  }

  // ---- Semantic grounding (UI Automation) ----

  private matchesQuery(element: UiaElement, query: UiaQuery): boolean {
    if (!query.includeOffscreen && element.offscreen) return false;
    if (query.name !== undefined && element.name.toLowerCase() !== query.name.toLowerCase()) return false;
    if (query.nameContains !== undefined && !element.name.toLowerCase().includes(query.nameContains.toLowerCase())) return false;
    if (query.automationId !== undefined && element.automationId !== query.automationId) return false;
    if (query.controlType !== undefined) {
      const wanted = query.controlType.toLowerCase();
      const actual = element.controlType.toLowerCase();
      if (actual !== wanted && !actual.endsWith(`.${wanted}`) && !actual.endsWith(wanted)) return false;
    }
    if (query.processId !== undefined && element.processId !== query.processId) return false;
    return true;
  }

  private async enumerateUi(): Promise<{ elements: UiaElement[]; treeHash: string }> {
    const elements = await this.backend.uiaElements(this.policy.maxUiaElements);
    const treeHash = createHash("sha256")
      .update(elements.map((e) => `${e.runtimeId}|${e.name}|${e.controlType}|${e.enabled}|${e.offscreen}|${e.hasKeyboardFocus}|${e.bounds.x},${e.bounds.y},${e.bounds.width},${e.bounds.height}`).join("\n"))
      .digest("hex");
    return { elements, treeHash };
  }

  /**
   * Resolve a semantic query against a UI Automation enumeration — re-grounding is
   * structural: callers always pass a fresh element list (nothing is cached between calls),
   * so a target that moved, vanished, or was duplicated by a UI change simply fails closed
   * here instead of acting on stale coordinates.
   */
  private resolveElement(query: UiaQuery, elements: UiaElement[]): UiaElement {
    if (query.name === undefined && query.nameContains === undefined && query.automationId === undefined && query.controlType === undefined && query.processId === undefined) {
      throw new ComputerUseError(COMPUTER_USE_ERRORS.COMPUTER_INVALID_TARGET, "a semantic target needs at least one query field (name, nameContains, automationId, controlType, processId)");
    }
    const matches = elements.filter((element) => this.matchesQuery(element, query));
    if (matches.length === 0) {
      throw new ComputerUseError(
        COMPUTER_USE_ERRORS.COMPUTER_TARGET_NOT_FOUND,
        `no UI element matches ${JSON.stringify(query)} — re-inspect with computer_inspect_ui; the interface may have changed`,
      );
    }
    if (matches.length > 1) {
      const sample = matches.slice(0, 5).map((m) => `"${m.name}" (${m.controlType} @ ${Math.round(m.bounds.x)},${Math.round(m.bounds.y)})`).join("; ");
      throw new ComputerUseError(
        COMPUTER_USE_ERRORS.COMPUTER_AMBIGUOUS_TARGET,
        `${matches.length} UI elements match ${JSON.stringify(query)} — refine the query (automationId or processId disambiguates). Matches: ${sample}`,
      );
    }
    return matches[0]!;
  }

  private describeTarget(element: UiaElement): VerifiedActionReceipt["target"] {
    return { name: element.name, automationId: element.automationId, controlType: element.controlType, bounds: element.bounds };
  }

  /** Re-enumerate after an action and report what actually changed — never claims "success". */
  private async verifyAction(before: { elements: UiaElement[]; treeHash: string }, target: UiaElement): Promise<VerifiedActionReceipt["verification"]> {
    const after = await this.enumerateUi();
    const still = after.elements.find((element) => element.runtimeId === target.runtimeId);
    const targetAfter = !still
      ? "gone" as const
      : JSON.stringify({ n: still.name, c: still.controlType, e: still.enabled, f: still.hasKeyboardFocus, b: still.bounds }) ===
        JSON.stringify({ n: target.name, c: target.controlType, e: target.enabled, f: target.hasKeyboardFocus, b: target.bounds })
        ? "unchanged" as const
        : "changed" as const;
    return {
      uiChanged: after.treeHash !== before.treeHash,
      targetAfter,
      ...(still ? { hasKeyboardFocus: still.hasKeyboardFocus } : {}),
    };
  }

  /** Observe the UI Automation tree — the semantic equivalent of a screenshot. No action budget. */
  async inspectUi(query: UiaQuery = {}): Promise<UiInspection> {
    this.requireSupported();
    const { elements, treeHash } = await this.enumerateUi();
    const filtered = elements.filter((element) => this.matchesQuery(element, query));
    return {
      elementCount: filtered.length,
      truncated: elements.length >= this.policy.maxUiaElements,
      elements: filtered,
      treeHash,
      takenAt: new Date(this.now()).toISOString(),
    };
  }

  /** Resolve a semantic target to its centre point — fails closed on zero or many matches. */
  async locateElement(query: UiaQuery): Promise<{ element: UiaElement; center: { x: number; y: number } }> {
    this.requireSupported();
    const { elements } = await this.enumerateUi();
    const element = this.resolveElement(query, elements);
    return {
      element,
      center: { x: Math.round(element.bounds.x + element.bounds.width / 2), y: Math.round(element.bounds.y + element.bounds.height / 2) },
    };
  }

  async clickElement(query: UiaQuery, button: "left" | "right" | "middle", clicks: number): Promise<VerifiedActionReceipt> {
    this.requireSupported();
    const before = await this.enumerateUi();
    const target = this.resolveElement(query, before.elements);
    const x = Math.round(target.bounds.x + target.bounds.width / 2);
    const y = Math.round(target.bounds.y + target.bounds.height / 2);
    await this.checkTarget(x, y);
    this.consumeActionBudget();
    await this.backend.click(x, y, button, clicks);
    const verification = await this.verifyAction(before, target);
    return {
      action: "computer_click_element",
      at: new Date(this.now()).toISOString(),
      detail: `${button} x${clicks} on "${target.name}" (${target.controlType})`,
      target: this.describeTarget(target),
      point: { x, y },
      verification,
    };
  }

  async typeIntoElement(query: UiaQuery, text: string): Promise<VerifiedActionReceipt> {
    this.requireSupported();
    if (text.length === 0 || text.length > this.policy.maxTypeLength) {
      throw new ComputerUseError(COMPUTER_USE_ERRORS.COMPUTER_INVALID_TARGET, `text length must be 1..${this.policy.maxTypeLength} characters`);
    }
    const before = await this.enumerateUi();
    const target = this.resolveElement(query, before.elements);
    const x = Math.round(target.bounds.x + target.bounds.width / 2);
    const y = Math.round(target.bounds.y + target.bounds.height / 2);
    await this.checkTarget(x, y);
    this.consumeActionBudget();
    await this.backend.click(x, y, "left", 1);
    await this.backend.typeText(text);
    const verification = await this.verifyAction(before, target);
    return {
      action: "computer_type_into_element",
      at: new Date(this.now()).toISOString(),
      detail: `${text.length} chars into "${target.name}" (${target.controlType})`,
      target: this.describeTarget(target),
      point: { x, y },
      verification,
    };
  }

  async shutdown(): Promise<void> {}
}

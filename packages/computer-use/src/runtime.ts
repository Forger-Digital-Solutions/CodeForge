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
import type { ComputerBackend, ScreenBounds } from "./backend.js";
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

  async shutdown(): Promise<void> {}
}

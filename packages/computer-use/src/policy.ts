/**
 * Computer-use policy. Injected input drives the real desktop session — every action is a
 * trust crossing. The policy bounds *how much* and *how fast* a run may act; whether it may
 * act at all is decided upstream by the permission gate (executeCommand flag + Tier 3
 * approval classification), which this layer never bypasses.
 */

export interface ComputerUsePolicy {
  /** Input actions (click/move/type/key) allowed per runtime lifetime. Screenshots are exempt. */
  maxActionsPerSession: number;
  /** Minimum delay between consecutive input actions — prevents machine-speed click storms. */
  minActionIntervalMs: number;
  /** Maximum characters a single computer_type_text call may inject. */
  maxTypeLength: number;
  /** Capture all monitors (virtual screen) or the primary display only. */
  allowMultiMonitor: boolean;
  /** Maximum UI Automation elements a single grounding enumeration may return. */
  maxUiaElements: number;
}

export const DEFAULT_COMPUTER_USE_POLICY: ComputerUsePolicy = {
  maxActionsPerSession: 120,
  minActionIntervalMs: 250,
  maxTypeLength: 2000,
  allowMultiMonitor: true,
  maxUiaElements: 600,
};

export const COMPUTER_USE_ERRORS = {
  COMPUTER_UNSUPPORTED: "COMPUTER_UNSUPPORTED",
  COMPUTER_INVALID_TARGET: "COMPUTER_INVALID_TARGET",
  COMPUTER_INVALID_KEY: "COMPUTER_INVALID_KEY",
  COMPUTER_TARGET_NOT_FOUND: "COMPUTER_TARGET_NOT_FOUND",
  COMPUTER_AMBIGUOUS_TARGET: "COMPUTER_AMBIGUOUS_TARGET",
  COMPUTER_BUDGET_EXHAUSTED: "COMPUTER_BUDGET_EXHAUSTED",
  COMPUTER_RATE_LIMITED: "COMPUTER_RATE_LIMITED",
  COMPUTER_BACKEND_FAILED: "COMPUTER_BACKEND_FAILED",
} as const;

export type ComputerUseErrorCode = (typeof COMPUTER_USE_ERRORS)[keyof typeof COMPUTER_USE_ERRORS];

export class ComputerUseError extends Error {
  constructor(
    public readonly code: ComputerUseErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ComputerUseError";
  }
}

/** Virtual-key names the key_press tool accepts. Values are Windows VK codes. */
export const KEY_NAME_TO_VK: Readonly<Record<string, number>> = {
  enter: 0x0d,
  escape: 0x1b,
  tab: 0x09,
  backspace: 0x08,
  delete: 0x2e,
  space: 0x20,
  insert: 0x2d,
  home: 0x24,
  end: 0x23,
  pageup: 0x21,
  pagedown: 0x22,
  up: 0x26,
  down: 0x28,
  left: 0x25,
  right: 0x27,
  ctrl: 0x11,
  alt: 0x12,
  shift: 0x10,
  win: 0x5b,
  capslock: 0x14,
  printscreen: 0x2c,
  f1: 0x70,
  f2: 0x71,
  f3: 0x72,
  f4: 0x73,
  f5: 0x74,
  f6: 0x75,
  f7: 0x76,
  f8: 0x77,
  f9: 0x78,
  f10: 0x79,
  f11: 0x7a,
  f12: 0x7b,
};

/** Single printable characters resolve to their uppercase virtual-key code. */
export function keyNameToVk(name: string): number | undefined {
  const lower = name.toLowerCase();
  const named = KEY_NAME_TO_VK[lower];
  if (named !== undefined) return named;
  if (lower.length === 1) {
    const code = lower.toUpperCase().charCodeAt(0);
    if ((code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a)) return code;
  }
  return undefined;
}

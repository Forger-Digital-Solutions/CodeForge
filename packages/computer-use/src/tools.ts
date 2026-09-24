import { formatUntrustedData } from "@codeforge/agent";
import type { ToolDefinition } from "@codeforge/tools";
import { ComputerUseError, COMPUTER_USE_ERRORS } from "./policy.js";
import type { GovernedComputerRuntime, UiaQuery } from "./runtime.js";

/**
 * Agent-facing computer-use tools. Registration into the tool surface is the wiring seam:
 * the definitions only exist where a governed runtime is attached, so a host that did not
 * opt in never advertises desktop control to the model.
 *
 * Permission posture:
 * - every tool requires the `executeCommand` flag — driving the real desktop session is at
 *   least as privileged as spawning a shell;
 * - observation tools are readOnly; input-injection tools are mutating and map to the
 *   highest approval tier through `describeAction` in the runtime host (external/high risk —
 *   a mis-aimed click can alter real user state);
 * - screenshots persist as hashed evidence files; only receipts cross the tool boundary, so
 *   image bytes never become untrusted instruction content.
 */

type ComputerToolName =
  | "computer_status"
  | "computer_screenshot"
  | "computer_inspect_ui"
  | "computer_click_element"
  | "computer_type_into_element"
  | "computer_mouse_move"
  | "computer_mouse_click"
  | "computer_type_text"
  | "computer_key_press";

const COORDINATE_PARAMS = {
  x: { type: "number", description: "Horizontal pixel coordinate inside screen bounds" },
  y: { type: "number", description: "Vertical pixel coordinate inside screen bounds" },
} as const;

const UIA_TARGET_PARAMS = {
  name: { type: "string", description: "Exact element name (case-insensitive)" },
  nameContains: { type: "string", description: "Substring the element name must contain" },
  automationId: { type: "string", description: "UI Automation AutomationId — the most stable disambiguator" },
  controlType: { type: "string", description: "Control type tail, e.g. Button/Edit/MenuItem/Text/ListItem/TabItem" },
  processId: { type: "number", description: "Owning process id — narrows matches to one application" },
} as const;

export const COMPUTER_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "computer_status",
    description: "Report computer-use support, screen bounds, and session action budget.",
    parameters: { type: "object", properties: {} },
    requiredPermission: "executeCommand",
    readOnly: true,
    executionClass: "read",
  },
  {
    name: "computer_screenshot",
    description: "Capture the desktop to a hashed evidence PNG. Returns the file path, sha256, and screen bounds — not image bytes.",
    parameters: { type: "object", properties: {} },
    requiredPermission: "executeCommand",
    readOnly: true,
    executionClass: "read",
  },
  {
    name: "computer_inspect_ui",
    description: "Ground against the live UI Automation tree: list controls with their names, automation ids, control types, bounds, and focus state. Optional filters narrow the result. Use before acting and re-inspect whenever the UI may have changed.",
    parameters: {
      type: "object",
      properties: {
        ...UIA_TARGET_PARAMS,
        includeOffscreen: { type: "boolean", description: "Include off-screen elements (default false)" },
      },
    },
    requiredPermission: "executeCommand",
    readOnly: true,
    executionClass: "read",
  },
  {
    name: "computer_click_element",
    description: "Click a UI control by what it IS, not where it sits: the query must resolve to exactly one UI Automation element, its centre is clicked, and the action is verified by re-grounding after the click. Prefer this over computer_mouse_click whenever a semantic target exists.",
    parameters: {
      type: "object",
      properties: {
        ...UIA_TARGET_PARAMS,
        includeOffscreen: { type: "boolean", description: "Allow targeting off-screen elements (default false)" },
        button: { type: "string", enum: ["left", "right", "middle"], description: "Mouse button (default left)" },
        clicks: { type: "number", description: "Click count 1..3 (default 1)" },
      },
    },
    requiredPermission: "executeCommand",
    readOnly: false,
    executionClass: "command",
  },
  {
    name: "computer_type_into_element",
    description: "Focus a UI control by semantic query (its centre is clicked) and type literal text into it, then verify by re-grounding. The query must resolve to exactly one UI Automation element.",
    parameters: {
      type: "object",
      properties: {
        ...UIA_TARGET_PARAMS,
        includeOffscreen: { type: "boolean", description: "Allow targeting off-screen elements (default false)" },
        text: { type: "string", description: "Literal text to type" },
      },
      required: ["text"],
    },
    requiredPermission: "executeCommand",
    readOnly: false,
    executionClass: "command",
  },
  {
    name: "computer_mouse_move",
    description: "Move the real mouse cursor to a screen coordinate.",
    parameters: {
      type: "object",
      properties: { ...COORDINATE_PARAMS },
      required: ["x", "y"],
    },
    requiredPermission: "executeCommand",
    readOnly: false,
    executionClass: "command",
  },
  {
    name: "computer_mouse_click",
    description: "Move to a screen coordinate and click. Injects real input into the desktop session.",
    parameters: {
      type: "object",
      properties: {
        ...COORDINATE_PARAMS,
        button: { type: "string", enum: ["left", "right", "middle"], description: "Mouse button (default left)" },
        clicks: { type: "number", description: "Click count 1..3 (default 1)" },
      },
      required: ["x", "y"],
    },
    requiredPermission: "executeCommand",
    readOnly: false,
    executionClass: "command",
  },
  {
    name: "computer_type_text",
    description: "Type literal text via real keyboard input into whatever currently has focus.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "Literal text to type" },
      },
      required: ["text"],
    },
    requiredPermission: "executeCommand",
    readOnly: false,
    executionClass: "command",
  },
  {
    name: "computer_key_press",
    description: "Press a key combination (e.g. [ctrl,c] or [alt,f4]) via real keyboard input.",
    parameters: {
      type: "object",
      properties: {
        keys: {
          type: "array",
          items: { type: "string" },
          description: "Key names: enter/escape/tab/backspace/delete/space/arrows/home/end/pageup/pagedown/ctrl/alt/shift/win/f1-f12 or single letters/digits",
        },
      },
      required: ["keys"],
    },
    requiredPermission: "executeCommand",
    readOnly: false,
    executionClass: "command",
  },
];

export function isComputerTool(name: string): boolean {
  return name.startsWith("computer_");
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ComputerUseError(COMPUTER_USE_ERRORS.COMPUTER_INVALID_TARGET, `${field} must be a finite number`);
  }
  return value;
}

/** Semantic query fields arrive untyped from the model — build a strict UiaQuery or throw. */
function parseUiaQuery(args: Record<string, unknown>): UiaQuery {
  const query: UiaQuery = {};
  for (const field of ["name", "nameContains", "automationId", "controlType"] as const) {
    const value = args[field];
    if (value !== undefined) {
      if (typeof value !== "string" || value.length === 0) {
        throw new ComputerUseError(COMPUTER_USE_ERRORS.COMPUTER_INVALID_TARGET, `${field} must be a non-empty string`);
      }
      query[field] = value;
    }
  }
  if (args.processId !== undefined) {
    if (typeof args.processId !== "number" || !Number.isInteger(args.processId) || args.processId <= 0) {
      throw new ComputerUseError(COMPUTER_USE_ERRORS.COMPUTER_INVALID_TARGET, "processId must be a positive integer");
    }
    query.processId = args.processId;
  }
  if (args.includeOffscreen === true) query.includeOffscreen = true;
  return query;
}

/**
 * Executor for the ToolBroker `customExecutor` seam. Returns undefined for non-computer tools
 * so the broker falls through. All payloads are wrapped as untrusted data — receipts are
 * evidence, never instruction.
 */
export function createComputerToolExecutor(
  runtime: GovernedComputerRuntime,
): (name: string, args: Record<string, unknown>) => Promise<string | undefined> {
  return async (name, args) => {
    if (!isComputerTool(name)) return undefined;
    switch (name as ComputerToolName) {
      case "computer_status": {
        return formatUntrustedData(JSON.stringify(await runtime.status()), "computer status");
      }
      case "computer_screenshot": {
        const receipt = await runtime.screenshot();
        return formatUntrustedData(JSON.stringify(receipt), "desktop screenshot");
      }
      case "computer_inspect_ui": {
        const inspection = await runtime.inspectUi(parseUiaQuery(args));
        return formatUntrustedData(JSON.stringify(inspection), "UI Automation inspection");
      }
      case "computer_click_element": {
        const button = args.button === "right" || args.button === "middle" ? args.button : "left";
        const clicks = typeof args.clicks === "number" && args.clicks >= 1 && args.clicks <= 3 ? Math.round(args.clicks) : 1;
        const receipt = await runtime.clickElement(parseUiaQuery(args), button, clicks);
        return formatUntrustedData(JSON.stringify(receipt), "computer action");
      }
      case "computer_type_into_element": {
        if (typeof args.text !== "string") {
          throw new ComputerUseError(COMPUTER_USE_ERRORS.COMPUTER_INVALID_TARGET, "text must be a string");
        }
        const receipt = await runtime.typeIntoElement(parseUiaQuery(args), args.text);
        return formatUntrustedData(JSON.stringify(receipt), "computer action");
      }
      case "computer_mouse_move": {
        const receipt = await runtime.moveMouse(finiteNumber(args.x, "x"), finiteNumber(args.y, "y"));
        return formatUntrustedData(JSON.stringify(receipt), "computer action");
      }
      case "computer_mouse_click": {
        const button = args.button === "right" || args.button === "middle" ? args.button : "left";
        const clicks = typeof args.clicks === "number" && args.clicks >= 1 && args.clicks <= 3 ? Math.round(args.clicks) : 1;
        const receipt = await runtime.click(finiteNumber(args.x, "x"), finiteNumber(args.y, "y"), button, clicks);
        return formatUntrustedData(JSON.stringify(receipt), "computer action");
      }
      case "computer_type_text": {
        if (typeof args.text !== "string") {
          throw new ComputerUseError(COMPUTER_USE_ERRORS.COMPUTER_INVALID_TARGET, "text must be a string");
        }
        const receipt = await runtime.typeText(args.text);
        return formatUntrustedData(JSON.stringify(receipt), "computer action");
      }
      case "computer_key_press": {
        const keys = Array.isArray(args.keys) ? args.keys.map(String) : [];
        const receipt = await runtime.keyPress(keys);
        return formatUntrustedData(JSON.stringify(receipt), "computer action");
      }
      default:
        return undefined;
    }
  };
}

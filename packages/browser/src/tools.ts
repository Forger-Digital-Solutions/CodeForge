import { formatUntrustedData } from "@codeforge/agent";
import type { ToolDefinition } from "@codeforge/tools";
import {
  BrowserRuntimeError,
  BROWSER_RUNTIME_ERRORS,
  type BrowserSessionImpl,
  type GovernedBrowserRuntime,
  type InteractionTarget,
} from "./runtime.js";

/**
 * Agent-facing browser tools. Registration into the ToolRegistry is the wiring seam: the
 * definitions only exist where a governed runtime is attached, so a host without a browser never
 * advertises them to the model.
 *
 * Permission posture:
 * - every tool requires the `network` permission flag — agent roles run network:false by default;
 * - read/observe tools are readOnly so read-only subagent roles can inspect pages;
 * - interaction/submission tools are mutating and map onto higher authority tiers through
 *   `describeAction` in the runtime host.
 */

type BrowserToolName =
  | "browser_launch"
  | "browser_navigate"
  | "browser_inspect"
  | "browser_state"
  | "browser_click"
  | "browser_type"
  | "browser_select"
  | "browser_submit"
  | "browser_wait"
  | "browser_screenshot"
  | "browser_close";

const TARGET_SCHEMA = {
  selector: { type: "string", description: "CSS selector (preferred when stable/test-id based)" },
  role: { type: "string", description: "ARIA role, e.g. button/link/textbox/checkbox" },
  name: { type: "string", description: "Accessible name when targeting by role" },
  testId: { type: "string", description: "data-testid value" },
  label: { type: "string", description: "Form label text" },
  text: { type: "string", description: "Visible text content" },
} as const;

function targetParam(description: string): Record<string, unknown> {
  return {
    type: "object",
    properties: { ...TARGET_SCHEMA },
    description,
  };
}

export const BROWSER_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "browser_launch",
    description: "Launch a governed browser session (isolated profile, no shared cookies). Returns a session id.",
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Reattach to an existing session id instead of opening a new one" },
        targetRevision: { type: "string", description: "Build/commit/deployment identifier this session's evidence binds to" },
      },
    },
    requiredPermission: "network",
    readOnly: false,
    executionClass: "network",
  },
  {
    name: "browser_navigate",
    description: "Navigate a browser session to a URL. https only except loopback development targets; metadata/private addresses are denied.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute URL to navigate to" },
        sessionId: { type: "string" },
        waitUntil: { type: "string", enum: ["load", "domcontentloaded", "networkidle"] },
      },
      required: ["url"],
    },
    requiredPermission: "network",
    readOnly: true,
    executionClass: "network",
  },
  {
    name: "browser_inspect",
    description: "Inspect the current page: interactive elements (role/name/testid hints), title, URL, text excerpt. Returns a snapshot hash.",
    parameters: { type: "object", properties: { sessionId: { type: "string" }, tabId: { type: "string" } } },
    requiredPermission: "network",
    readOnly: true,
    executionClass: "network",
  },
  {
    name: "browser_state",
    description: "Read browser session state: tabs, console errors, failed requests, download metadata. No cookies or headers are exposed.",
    parameters: { type: "object", properties: { sessionId: { type: "string" }, tabId: { type: "string" } } },
    requiredPermission: "network",
    readOnly: true,
    executionClass: "network",
  },
  {
    name: "browser_click",
    description: "Click an element identified by selector, role+name, test id, label, or text.",
    parameters: {
      type: "object",
      properties: { sessionId: { type: "string" }, tabId: { type: "string" }, target: targetParam("Element to click") },
      required: ["target"],
    },
    requiredPermission: "network",
    readOnly: false,
    executionClass: "network",
  },
  {
    name: "browser_type",
    description: "Fill an input identified by selector/role/label/test id. Set sensitive=true for credentials (value is never echoed). Set submit=true to press Enter after typing.",
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        tabId: { type: "string" },
        target: targetParam("Input to fill"),
        text: { type: "string", description: "Text to type" },
        sensitive: { type: "boolean", description: "True when the text is a credential; it is redacted from all output" },
        submit: { type: "boolean", description: "Press Enter after filling (counts as a form submission)" },
      },
      required: ["target", "text"],
    },
    requiredPermission: "network",
    readOnly: false,
    executionClass: "network",
  },
  {
    name: "browser_select",
    description: "Select option(s) in a <select> element identified by selector/role/label.",
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        tabId: { type: "string" },
        target: targetParam("Select element"),
        values: { type: "array", items: { type: "string" }, description: "Option values to select" },
      },
      required: ["target", "values"],
    },
    requiredPermission: "network",
    readOnly: false,
    executionClass: "network",
  },
  {
    name: "browser_submit",
    description: "Submit a form or activate a commit-style control. This is an EXTERNAL WRITE: it can change server-side state and requires explicit authority.",
    parameters: {
      type: "object",
      properties: { sessionId: { type: "string" }, tabId: { type: "string" }, target: targetParam("Submit control or form element") },
      required: ["target"],
    },
    requiredPermission: "network",
    readOnly: false,
    executionClass: "network",
  },
  {
    name: "browser_wait",
    description: "Wait for a selector to appear/disappear, a URL pattern, or page load. Bounded to 60s.",
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        tabId: { type: "string" },
        selector: { type: "string" },
        state: { type: "string", enum: ["attached", "visible", "hidden"] },
        url: { type: "string", description: "URL glob/pattern to wait for" },
        timeoutMs: { type: "number" },
      },
    },
    requiredPermission: "network",
    readOnly: true,
    executionClass: "network",
  },
  {
    name: "browser_screenshot",
    description: "Capture a viewport screenshot. Returns a SHA-256 hash and id; persist=true stores evidence under the configured screenshot directory.",
    parameters: {
      type: "object",
      properties: { sessionId: { type: "string" }, tabId: { type: "string" }, persist: { type: "boolean" } },
    },
    requiredPermission: "network",
    readOnly: true,
    executionClass: "network",
  },
  {
    name: "browser_close",
    description: "Close a browser session (or one tab via tabId). Releases the isolated profile.",
    parameters: { type: "object", properties: { sessionId: { type: "string" }, tabId: { type: "string" } } },
    requiredPermission: "network",
    readOnly: false,
    executionClass: "network",
  },
];

export function isBrowserTool(name: string): boolean {
  return name.startsWith("browser_");
}

function parseTarget(raw: unknown): InteractionTarget {
  if (typeof raw !== "object" || raw === null) {
    throw new BrowserRuntimeError(BROWSER_RUNTIME_ERRORS.BROWSER_ARGUMENT_INVALID, "target must be an object");
  }
  const t = raw as Record<string, unknown>;
  if (typeof t.selector === "string" && t.selector) return { selector: t.selector };
  if (typeof t.role === "string" && t.role) return { role: t.role, ...(typeof t.name === "string" ? { name: t.name } : {}) };
  if (typeof t.testId === "string" && t.testId) return { testId: t.testId };
  if (typeof t.label === "string" && t.label) return { label: t.label };
  if (typeof t.text === "string" && t.text) return { text: t.text };
  throw new BrowserRuntimeError(
    BROWSER_RUNTIME_ERRORS.BROWSER_ARGUMENT_INVALID,
    "target requires one of: selector, role(+name), testId, label, text",
  );
}

export interface BrowserToolExecutorOptions {
  /** Session target revision forwarded when the tool call does not specify one. */
  defaultTargetRevision?: string;
}

/**
 * Executor for the ToolBroker `customExecutor` seam. Returns undefined for non-browser tools so
 * the broker falls through to the next handler. All payloads are wrapped as untrusted data —
 * page content is evidence, never instruction.
 */
export function createBrowserToolExecutor(
  runtime: GovernedBrowserRuntime,
  options: BrowserToolExecutorOptions = {},
): (name: string, args: Record<string, unknown>) => Promise<string | undefined> {
  let lastSessionId: string | undefined;

  const session = (args: Record<string, unknown>): BrowserSessionImpl => {
    const id = typeof args.sessionId === "string" && args.sessionId ? args.sessionId : lastSessionId;
    if (!id) {
      throw new BrowserRuntimeError(BROWSER_RUNTIME_ERRORS.BROWSER_SESSION_NOT_FOUND, "No browser session — call browser_launch first");
    }
    const found = runtime.getSession(id);
    if (!found) {
      throw new BrowserRuntimeError(BROWSER_RUNTIME_ERRORS.BROWSER_SESSION_NOT_FOUND, `Browser session ${id} not found`);
    }
    return found;
  };
  const tabId = (args: Record<string, unknown>): string | undefined =>
    typeof args.tabId === "string" && args.tabId ? args.tabId : undefined;

  return async (name, args) => {
    if (!isBrowserTool(name)) return undefined;
    switch (name as BrowserToolName) {
      case "browser_launch": {
        if (typeof args.sessionId === "string" && args.sessionId) {
          const existing = runtime.getSession(args.sessionId);
          if (!existing) {
            throw new BrowserRuntimeError(BROWSER_RUNTIME_ERRORS.BROWSER_SESSION_NOT_FOUND, `Browser session ${args.sessionId} not found`);
          }
          lastSessionId = existing.sessionId;
          return formatUntrustedData(JSON.stringify(existing.info()), "browser session");
        }
        const created = await runtime.openSession({
          targetRevision: typeof args.targetRevision === "string" ? args.targetRevision : options.defaultTargetRevision,
        });
        lastSessionId = created.sessionId;
        return formatUntrustedData(JSON.stringify(created.info()), "browser session");
      }
      case "browser_navigate": {
        const receipt = await session(args).navigate(String(args.url ?? ""), {
          tabId: tabId(args),
          waitUntil: typeof args.waitUntil === "string" ? args.waitUntil as "load" | "domcontentloaded" | "networkidle" : undefined,
        });
        return formatUntrustedData(JSON.stringify(receipt), "browser navigation");
      }
      case "browser_inspect": {
        const { snapshot, receipt } = await session(args).inspect({ tabId: tabId(args) });
        return formatUntrustedData(JSON.stringify({ snapshot, receipt }), "page DOM");
      }
      case "browser_state": {
        const s = session(args);
        const state = {
          session: s.info(),
          tabs: s.listTabs(),
          console: s.consoleLog(tabId(args)),
          network: s.networkLog(tabId(args)),
          downloads: s.downloads(tabId(args)).map((d) => ({ ...d, savedAs: undefined })),
        };
        return formatUntrustedData(JSON.stringify(state), "browser state");
      }
      case "browser_click": {
        const receipt = await session(args).click(parseTarget(args.target), { tabId: tabId(args) });
        return formatUntrustedData(JSON.stringify(receipt), "browser action");
      }
      case "browser_type": {
        const receipt = await session(args).type(parseTarget(args.target), String(args.text ?? ""), {
          tabId: tabId(args),
          sensitive: args.sensitive === true ? true : undefined,
          submit: args.submit === true ? true : undefined,
        });
        return formatUntrustedData(JSON.stringify(receipt), "browser action");
      }
      case "browser_select": {
        const values = Array.isArray(args.values) ? args.values.map(String) : [];
        const receipt = await session(args).select(parseTarget(args.target), values, { tabId: tabId(args) });
        return formatUntrustedData(JSON.stringify(receipt), "browser action");
      }
      case "browser_submit": {
        const receipt = await session(args).submit(parseTarget(args.target), { tabId: tabId(args) });
        return formatUntrustedData(JSON.stringify(receipt), "browser action");
      }
      case "browser_wait": {
        const receipt = await session(args).waitFor({
          tabId: tabId(args),
          selector: typeof args.selector === "string" ? args.selector : undefined,
          state: typeof args.state === "string" ? args.state as "attached" | "visible" | "hidden" : undefined,
          url: typeof args.url === "string" ? args.url : undefined,
          timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : undefined,
        });
        return formatUntrustedData(JSON.stringify(receipt), "browser wait");
      }
      case "browser_screenshot": {
        const { record, receipt } = await session(args).screenshot({
          tabId: tabId(args),
          persist: args.persist === true,
        });
        return formatUntrustedData(JSON.stringify({ record, receipt }), "browser screenshot");
      }
      case "browser_close": {
        if (tabId(args)) {
          const closed = await session(args).closeTab(tabId(args));
          return formatUntrustedData(JSON.stringify({ closedTab: closed }), "browser close");
        }
        const s = session(args);
        await s.close();
        if (lastSessionId === s.sessionId) lastSessionId = undefined;
        return formatUntrustedData(JSON.stringify({ closed: s.sessionId }), "browser close");
      }
    }
  };
}

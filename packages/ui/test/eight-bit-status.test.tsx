import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  resolveEightBitStatusAsset,
  deriveLatestEightBitStatus,
  isEightBitStatusEvent,
  type EightBitStatusPayload,
} from "../src/eight-bit-status.js";
import { resolveAssetUrlByName } from "../src/emoji-assets.js";
import { EightBitStatusBadge } from "../src/EightBitStatusBadge.js";
import type { WorkspaceEvent } from "@codeforge/protocol";

function statusEvent(payload: EightBitStatusPayload, seq: number): WorkspaceEvent {
  return {
    type: "eightbit.status",
    timestamp: new Date().toISOString(),
    seq,
    sessionId: "s1",
    payload,
  } as unknown as WorkspaceEvent;
}

describe("8-Bit status — event to certified visual mapping (presentation only)", () => {
  it("[PASS] maps every known runtime event to a certified 8bit asset name", () => {
    expect(resolveEightBitStatusAsset("CATALOG_SCAN_STARTED")).toBe("8bit-loading");
    expect(resolveEightBitStatusAsset("ROUTE_DEGRADED")).toBe("8bit-warning");
    expect(resolveEightBitStatusAsset("ROUTE_COOLDOWN")).toBe("8bit-waiting");
    expect(resolveEightBitStatusAsset("PROVIDER_OFFLINE")).toBe("8bit-offline");
    expect(resolveEightBitStatusAsset("PROVIDER_ONLINE")).toBe("8bit-online");
    expect(resolveEightBitStatusAsset("FREE_ELIGIBILITY_REMOVED")).toBe("8bit-warning");
    expect(resolveEightBitStatusAsset("ROUTE_ROTATION_STARTED")).toBe("8bit-swapping-model");
    expect(resolveEightBitStatusAsset("ROUTE_ROTATED")).toBe("8bit-success");
    expect(resolveEightBitStatusAsset("ROUTE_READY")).toBe("8bit-online");
    expect(resolveEightBitStatusAsset("NO_ELIGIBLE_FREE_MODEL")).toBe("8bit-error");
    // Every mapped asset must resolve to a real bundled URL (already-certified pack, no new art).
    for (const asset of ["8bit-loading", "8bit-warning", "8bit-waiting", "8bit-offline", "8bit-online", "8bit-swapping-model", "8bit-success", "8bit-error"] as const) {
      expect(resolveAssetUrlByName(asset)).toContain("8bit/20/");
    }
  });

  it("[PASS] an unrecognized/future event resolves to a safe fallback instead of throwing", () => {
    expect(() => resolveEightBitStatusAsset("SOME_FUTURE_EVENT_TYPE")).not.toThrow();
    expect(resolveEightBitStatusAsset("SOME_FUTURE_EVENT_TYPE")).toBe("8bit-tool-use");
  });

  it("[PASS] deriveLatestEightBitStatus picks the most recent eightbit.status event and ignores others", () => {
    const events: WorkspaceEvent[] = [
      statusEvent({ event: "ROUTE_ROTATION_STARTED", role: "CODER", reasonCodes: ["QUOTA_EXHAUSTED"], accessibleText: "Switching..." }, 1),
      { type: "tool.started", timestamp: new Date().toISOString(), seq: 2, sessionId: "s1", payload: { toolCallId: "x", tool: "read_file", taskId: "t1" } } as unknown as WorkspaceEvent,
      statusEvent({ event: "ROUTE_READY", role: "CODER", reasonCodes: ["QUOTA_EXHAUSTED"], accessibleText: "8-Bit switched the CODER route." }, 3),
    ];
    const latest = deriveLatestEightBitStatus(events);
    expect(latest?.event).toBe("ROUTE_READY");
  });

  it("[PASS] returns undefined (nothing to show, not an error) when no 8-Bit event has occurred", () => {
    expect(deriveLatestEightBitStatus([])).toBeUndefined();
    expect(deriveLatestEightBitStatus(undefined)).toBeUndefined();
  });

  it("[PASS] isEightBitStatusEvent narrows correctly", () => {
    const e = statusEvent({ event: "PROVIDER_OFFLINE", role: "CODER", reasonCodes: [], accessibleText: "offline" }, 1);
    expect(isEightBitStatusEvent(e)).toBe(true);
  });

  it("[PASS] EightBitStatusBadge renders nothing when there is no status (not an error state)", () => {
    const html = renderToStaticMarkup(<EightBitStatusBadge status={undefined} />);
    expect(html).toBe("");
  });

  it("[PASS] EightBitStatusBadge exposes accessible text via role=status/aria-live, with the emoji decorative", () => {
    const status: EightBitStatusPayload = {
      event: "ROUTE_READY",
      role: "CODER",
      previous: { providerId: "openrouter", modelId: "a" },
      selected: { providerId: "groq", modelId: "b" },
      reasonCodes: ["QUOTA_EXHAUSTED"],
      accessibleText: "8-Bit switched the CODER route because the previous provider exhausted its free quota.",
    };
    const html = renderToStaticMarkup(<EightBitStatusBadge status={status} />);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("8-Bit switched the CODER route because the previous provider exhausted its free quota.");
    expect(html).toContain('alt=""');
    expect(html).toContain('aria-hidden="true"');
  });

  it("[PASS] a missing/broken visual asset name cannot crash rendering — accessible text still renders", () => {
    const status: EightBitStatusPayload = {
      // Cast to simulate a future server sending an event this UI build does not know.
      event: "SOME_NEW_EVENT" as EightBitStatusPayload["event"],
      role: "CODER",
      reasonCodes: [],
      accessibleText: "8-Bit is doing something new.",
    };
    const html = renderToStaticMarkup(<EightBitStatusBadge status={status} />);
    expect(html).toContain("8-Bit is doing something new.");
  });
});

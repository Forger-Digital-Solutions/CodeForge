import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivityIcon, ForgeWorkingIndicator, activityLabel, resolveActivityKind } from "../src/activity-icons.js";
import { isForgeWorkActive } from "../src/forge-activity.js";

describe("activity presentation", () => {
  it.each([
    ["search", "search"],
    ["read_file", "read"],
    ["reason_about_change", "reason"],
    ["edit_file", "edit"],
    ["run_command", "execute"],
    ["forge_verify", "verify"],
  ] as const)("maps %s to the %s marker", (tool, kind) => {
    expect(resolveActivityKind(tool)).toBe(kind);
  });

  it("falls back safely for an unknown event/tool", () => {
    expect(resolveActivityKind("mystery_tool")).toBe("generic");
    expect(activityLabel("generic")).toBe("Activity");
  });

  it("keeps status text available while the SVG remains decorative", () => {
    const markup = renderToStaticMarkup(<ForgeWorkingIndicator active label="Forging..." />);
    expect(markup).toContain('role="status"');
    expect(markup).toContain("Forging...");
    expect(markup).toContain("CodeForge is actively working.");
    expect(markup).toContain('aria-hidden="true"');
  });

  it("renders no torch after completion, failure, cancellation, or approval wait", () => {
    const base = { isRunning: true, isPaused: false, activePhase: "implementing", pendingApproval: null, isEventStreamConnected: true };
    expect(isForgeWorkActive(base)).toBe(true);
    expect(isForgeWorkActive({ ...base, activePhase: "complete" })).toBe(false);
    expect(isForgeWorkActive({ ...base, activePhase: "failed" })).toBe(false);
    expect(isForgeWorkActive({ ...base, activePhase: "cancelled" })).toBe(false);
    expect(isForgeWorkActive({ ...base, activePhase: "awaiting_approval", pendingApproval: {} })).toBe(false);
    expect(isForgeWorkActive({ ...base, pendingApproval: {} })).toBe(false);
    expect(isForgeWorkActive({ ...base, isEventStreamConnected: false })).toBe(false);
  });

  it("does not animate historical completed activity", () => {
    const markup = renderToStaticMarkup(<ActivityIcon kind="edit" state="completed" />);
    expect(markup).toContain('data-activity-state="completed"');
    expect(markup).not.toContain("forge-working-indicator");
    expect(markup).not.toContain("forge-spark");
  });

  it("removes the forge indicator when inactive", () => {
    expect(renderToStaticMarkup(<ForgeWorkingIndicator active={false} />)).toBe("");
  });
});

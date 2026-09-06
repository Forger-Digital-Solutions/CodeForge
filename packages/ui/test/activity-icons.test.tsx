import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivityIcon, ForgeWorkingIndicator, activityLabel, resolveActivityKind, type ActivityKind } from "../src/activity-icons.js";
import { resolveActivityAsset, resolveActivityAssetName, resolveFileAssetName, type ActivityEmojiTheme } from "../src/emoji-assets.js";
import { isForgeWorkActive } from "../src/forge-activity.js";

describe("activity presentation", () => {
  it.each([
    ["search", "search"],
    ["read_file", "read"],
    ["reason_about_change", "reason"],
    ["edit_file", "edit"],
    ["run_command", "execute"],
    ["build_workspace", "build"],
    ["forge_verify", "verify"],
  ] as const)("maps %s to the %s marker", (tool, kind) => {
    expect(resolveActivityKind(tool)).toBe(kind);
  });

  it("falls back safely for an unknown event/tool", () => {
    expect(resolveActivityKind("mystery_tool")).toBe("generic");
    expect(activityLabel("generic")).toBe("Activity");
  });

  it("maps every semantic kind to an 8bit activity emoji by default", () => {
    expect(resolveActivityAssetName("search")).toBe("8bit-search");
    expect(resolveActivityAssetName("read")).toBe("8bit-read");
    expect(resolveActivityAssetName("reason")).toBe("8bit-reasoning");
    expect(resolveActivityAssetName("plan")).toBe("8bit-planning");
    expect(resolveActivityAssetName("tool")).toBe("8bit-tool-use");
    expect(resolveActivityAssetName("edit")).toBe("8bit-edit-file");
    expect(resolveActivityAssetName("delete")).toBe("8bit-delete-file");
    expect(resolveActivityAssetName("execute")).toBe("8bit-running-command");
    expect(resolveActivityAssetName("forge")).toBe("8bit-running-command");
    expect(resolveActivityAssetName("fetch")).toBe("8bit-fetch");
    expect(resolveActivityAssetName("build")).toBe("8bit-build");
    expect(resolveActivityAssetName("test")).toBe("8bit-testing");
    expect(resolveActivityAssetName("verify")).toBe("8bit-verifying");
    expect(resolveActivityAssetName("git")).toBe("8bit-git");
    expect(resolveActivityAssetName("commit")).toBe("8bit-git");
    expect(resolveActivityAssetName("error")).toBe("8bit-error");
    expect(resolveActivityAssetName("waiting")).toBe("8bit-waiting");
    expect(resolveActivityAssetName("queued")).toBe("8bit-waiting");
    expect(resolveActivityAssetName("paused")).toBe("8bit-paused");
    expect(resolveActivityAssetName("approval")).toBe("8bit-thumbs-up");
    expect(resolveActivityAssetName("complete")).toBe("8bit-success");
    expect(resolveActivityAssetName("success")).toBe("8bit-success");
    expect(resolveActivityAssetName("warning")).toBe("8bit-warning");
    expect(resolveActivityAssetName("cancelled")).toBe("8bit-cancelled");
    expect(resolveActivityAssetName("parallel")).toBe("8bit-multi-model");
    expect(resolveActivityAssetName("generic")).toBe("8bit-tool-use");
    expect(resolveActivityAssetName("unknown")).toBe("8bit-tool-use");
  });

  it("keeps extension-aware create marks for the 8bit theme with a safe generic fallback", () => {
    expect(resolveActivityAssetName("create", "src/App.tsx")).toBe("8bit-file-typescript");
    expect(resolveActivityAssetName("create", "worker.py")).toBe("8bit-file-python");
    expect(resolveActivityAssetName("create", "index.js")).toBe("8bit-file-javascript");
    expect(resolveActivityAssetName("create", "lib.rs")).toBe("8bit-file-rust");
    expect(resolveFileAssetName("README.md")).toBe("8bit-create-file");
    expect(resolveFileAssetName("unknown.data")).toBe("8bit-create-file");
    expect(resolveFileAssetName("no-extension")).toBe("8bit-create-file");
  });

  it("serves 8bit asset URLs from the bundled 8bit asset folder", () => {
    expect(resolveActivityAsset("read")).toContain("/activity-emoji/8bit/20/8bit-read.png");
    expect(resolveActivityAsset("create", "a.ts")).toContain("8bit-file-typescript.png");
  });

  it("preserves the legacyForge theme for rollback", () => {
    const legacy: ActivityEmojiTheme = "legacyForge";
    expect(resolveActivityAssetName("search", undefined, legacy)).toBe("search-metal-detector");
    expect(resolveActivityAssetName("execute", undefined, legacy)).toBe("command-execution-welding-torch");
    expect(resolveActivityAssetName("paused", undefined, legacy)).toBe("paused-raised-hammer");
    expect(resolveActivityAssetName("approval", undefined, legacy)).toBe("approval-forge-seal");
    expect(resolveActivityAssetName("create", "src/App.tsx", legacy)).toBe("create-file-typescript");
    expect(resolveFileAssetName("README.md", legacy)).toBe("create-file-markdown");
    expect(resolveActivityAsset("read", undefined, legacy)).toContain("/emojipack/20/read-monocle-reader.png");
  });

  it("never returns an unmapped kind for either theme", () => {
    for (const theme of ["8bit", "legacyForge"] as const) {
      expect(resolveActivityAssetName("generic", undefined, theme)).toBeTruthy();
      expect(resolveActivityAssetName("unknown", undefined, theme)).toBeTruthy();
    }
  });

  it.each([
    "search", "read", "reason", "plan", "edit", "create", "delete", "tool", "execute", "fetch", "build",
    "test", "verify", "git", "commit", "error", "waiting", "queued", "paused", "approval", "complete", "warning",
    "cancelled", "parallel", "success", "generic", "unknown", "forge",
  ] as ActivityKind[])("has a production asset for semantic kind %s", (kind) => {
    expect(resolveActivityAssetName(kind)).toMatch(/\.png$|^[a-z0-9-]+$/);
  });

  it("keeps status text available while the PNG remains decorative", () => {
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
    expect(markup).toContain("<img");
    expect(markup).toContain('alt=""');
  });

  it("removes the forge indicator when inactive", () => {
    expect(renderToStaticMarkup(<ForgeWorkingIndicator active={false} />)).toBe("");
  });
});

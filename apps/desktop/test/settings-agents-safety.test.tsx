import { describe, expect, it } from "vitest";
import { AgentsSection } from "../src/renderer/settings/sections/AgentsSection.js";
import { VerificationSafetySection } from "../src/renderer/settings/sections/VerificationSafetySection.js";
import { ApplicationBackgroundSection } from "../src/renderer/settings/sections/ApplicationBackgroundSection.js";
import { DataPrivacySection } from "../src/renderer/settings/sections/DataPrivacySection.js";
import { WorkspacesSection } from "../src/renderer/settings/sections/WorkspacesSection.js";
import { RuntimeExecutionSection } from "../src/renderer/settings/sections/RuntimeExecutionSection.js";
import { NotificationsSection } from "../src/renderer/settings/sections/NotificationsSection.js";
import { renderSection, createSettingsContext, FIXTURE_SETTINGS } from "./settings-test-harness.js";

describe("Agents page", () => {
  it("shows the steering control with only the values the runtime distinguishes", () => {
    const markup = renderSection(<AgentsSection />, createSettingsContext());
    expect(markup).toContain("Agent steering while typing");
    // The selected value is the collapsed trigger label; the two-value enum is covered by the schema tests.
    expect(markup).toContain("On — while I type");
    // "Always" was removed entirely: it behaved identically to expensive-actions-only, a dead control.
    expect(markup).not.toContain(">Always<");
    expect(markup).not.toContain("value=\"always\"");
  });

  it("offers the real Agent/Chat modes and states the approval policy truthfully", () => {
    const markup = renderSection(<AgentsSection />, createSettingsContext());
    expect(markup).toContain("Default new task mode");
    expect(markup).toContain("Ask before risky actions");
    expect(markup).toContain("Enforced");
  });

  it("shows pending approvals from live runtime status when any exist", () => {
    const context = createSettingsContext({
      runtimeStatus: {
        activeWork: true, activeWorkflows: 0, activeAgentTurns: 1, activeCommands: 0,
        pendingApprovals: 2, activeVerifications: 0, hostedContinuations: 0, backgroundTasks: 0,
        recoverable: true, unrecoverableResources: [],
      },
    });
    const markup = renderSection(<AgentsSection />, context);
    expect(markup).toContain("2 pending");
  });
});

describe("Verification & Safety page", () => {
  it("presents the mandatory verification stack as always-on status, not fake toggles", () => {
    const markup = renderSection(<VerificationSafetySection />, createSettingsContext());
    expect(markup).toContain("ForgeVerify");
    expect(markup).toContain("Completion gate");
    expect(markup).toContain("Secret redaction");
    expect(markup).toContain("Workspace boundaries");
    expect(markup).toContain("Active");
    // No switch can disable these protections.
    expect(markup).not.toMatch(/role="switch"/);
  });

  it("surfaces unrecoverable runtime resources when the runtime reports them", () => {
    const context = createSettingsContext({
      runtimeStatus: {
        activeWork: true, activeWorkflows: 1, activeAgentTurns: 0, activeCommands: 0,
        pendingApprovals: 0, activeVerifications: 0, hostedContinuations: 0, backgroundTasks: 0,
        recoverable: false, unrecoverableResources: ["A local command cannot be interrupted safely"],
      },
    });
    const markup = renderSection(<VerificationSafetySection />, context);
    expect(markup).toContain("A local command cannot be interrupted safely");
  });
});

describe("Application & Background page", () => {
  it("binds the close-behavior dropdown to the canonical close behavior", () => {
    const context = createSettingsContext({ closeBehavior: "tray" });
    const markup = renderSection(<ApplicationBackgroundSection />, context);
    expect(markup).toContain("Minimize to tray");
    expect(markup).toContain("When tasks are active and I close CodeForge");
  });

  it("states honestly that Windows startup registration does not exist", () => {
    const markup = renderSection(<ApplicationBackgroundSection />, createSettingsContext());
    expect(markup).toContain("does not register itself to start with Windows");
  });
});

describe("Data & Privacy page", () => {
  it("exposes the privacy routing control with the current mode selected", () => {
    const markup = renderSection(<DataPrivacySection />, createSettingsContext());
    expect(markup).toContain("Privacy routing mode");
    // Collapsed dropdown shows the current canonical value (STANDARD's label).
    expect(markup).toContain("Standard · normal provider retention");
  });

  it("states the truthful no-telemetry position", () => {
    const markup = renderSection(<DataPrivacySection />, createSettingsContext());
    expect(markup).toContain("collects no product telemetry");
  });
});

describe("Workspaces page", () => {
  it("shows the current workspace, git state, and recent projects", () => {
    const context = createSettingsContext({
      recentProjects: [
        { id: "p1", path: "C:/work/demo", name: "demo", lastOpened: "2026-09-11T00:00:00.000Z" },
        { id: "p2", path: "C:/work/other", name: "other", lastOpened: "2026-09-10T00:00:00.000Z" },
      ],
    });
    const markup = renderSection(<WorkspacesSection />, context);
    expect(markup).toContain("demo");
    expect(markup).toContain("branch: main");
    expect(markup).toContain("other");
    expect(markup).toContain("Repository Intelligence");
  });
});

describe("Runtime & Execution page", () => {
  it("renders real system information and runtime status facts", () => {
    const markup = renderSection(<RuntimeExecutionSection />, createSettingsContext());
    expect(markup).toContain("win32 (x64)");
    expect(markup).toContain("Safe command timeout");
    expect(markup).toContain("The local runtime has not reported status yet.");
  });

  it("summarizes live runtime counters when the runtime reports them", () => {
    const context = createSettingsContext({
      runtimeStatus: {
        activeWork: true, activeWorkflows: 1, activeAgentTurns: 1, activeCommands: 0,
        pendingApprovals: 0, activeVerifications: 1, hostedContinuations: 0, backgroundTasks: 0,
        recoverable: true, unrecoverableResources: [],
      },
    });
    const markup = renderSection(<RuntimeExecutionSection />, context);
    expect(markup).toContain("1 workflow · 1 agent turn · 1 verification");
    expect(markup).toContain("Working");
  });
});

describe("Notifications page", () => {
  it("binds the notification toggles to the canonical preferences", () => {
    const markup = renderSection(<NotificationsSection />, createSettingsContext());
    expect(markup).toContain("System notifications");
    expect(markup).toContain("Agent needs approval");
    expect(markup).toContain("Agent work finished");
    expect(markup).toContain("Only when CodeForge is in the background");
  });

  it("disables dependent toggles when notifications are off", () => {
    const context = createSettingsContext({
      settings: { ...FIXTURE_SETTINGS, notifications: { ...FIXTURE_SETTINGS.notifications, enabled: false } },
    });
    const markup = renderSection(<NotificationsSection />, context);
    expect(markup).toMatch(/disabled=""[^>]*role="switch"|role="switch"[^>]*disabled=""/);
  });
});

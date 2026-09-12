import { describe, it, expect } from "vitest";
import {
  APP_SETTINGS_SCHEMA_VERSION,
  applySettingsPatch,
  migrateLegacyAppSettings,
  parseAppSettings,
  parseAppSettingsPatch,
} from "../src/app-settings.js";

describe("canonical app settings schema", () => {
  it("falls back to documented defaults for an empty store", () => {
    const settings = parseAppSettings(undefined);
    expect(settings.schemaVersion).toBe(APP_SETTINGS_SCHEMA_VERSION);
    expect(settings.general.openLastWorkspaceOnStartup).toBe(true);
    expect(settings.general.continueInterruptedAgents).toBe(true);
    expect(settings.general.defaultSteeringPolicy).toBe("expensive_actions_only");
    expect(settings.appearance.chatTextScale).toBe("medium");
    expect(settings.appearance.reducedMotion).toBe(false);
    expect(settings.models.defaultModelId).toBe("auto");
    expect(settings.notifications).toEqual({
      enabled: true,
      onApprovalNeeded: true,
      onAgentCompleted: true,
      onlyWhenInBackground: true,
    });
    expect(settings.privacy.routingMode).toBe("STANDARD");
  });

  it("degrades field-by-field instead of discarding good groups on a corrupt store", () => {
    const settings = parseAppSettings({
      schemaVersion: 99,
      general: { openLastWorkspaceOnStartup: false, bogus: "ignored" },
      appearance: "not-an-object",
      models: { defaultModelId: "openrouter::z/free" },
      privacy: { routingMode: "PAID_PLEASE" },
    });
    expect(settings.schemaVersion).toBe(APP_SETTINGS_SCHEMA_VERSION);
    expect(settings.general.openLastWorkspaceOnStartup).toBe(false);
    expect(settings.appearance).toEqual(parseAppSettings(undefined).appearance);
    expect(settings.models.defaultModelId).toBe("openrouter::z/free");
    expect(settings.privacy.routingMode).toBe("STANDARD");
  });

  it("rejects invalid patches with a readable message", () => {
    expect(() => parseAppSettingsPatch({ models: { defaultModelId: "" } })).toThrow(/defaultModelId/);
    expect(() => parseAppSettingsPatch({ privacy: { routingMode: "OFF" } })).toThrow(/routingMode/);
    expect(() => parseAppSettingsPatch({ unknownGroup: {} })).toThrow(/Invalid settings update/);
  });

  it("applies patches immutably and only to the targeted groups", () => {
    const current = parseAppSettings({});
    const patch = parseAppSettingsPatch({
      general: { continueInterruptedAgents: false },
      notifications: { onAgentCompleted: false },
    });
    const next = applySettingsPatch(current, patch);
    expect(next.general.continueInterruptedAgents).toBe(false);
    expect(next.notifications.onAgentCompleted).toBe(false);
    expect(next.general.openLastWorkspaceOnStartup).toBe(true);
    expect(next.notifications.onApprovalNeeded).toBe(true);
    expect(current.general.continueInterruptedAgents).toBe(true);
  });

  it("migrates the legacy steering policy, mapping the dead 'always' value truthfully", () => {
    expect(migrateLegacyAppSettings("always")).toEqual({
      general: { defaultSteeringPolicy: "expensive_actions_only" },
    });
    expect(migrateLegacyAppSettings("off")).toEqual({ general: { defaultSteeringPolicy: "off" } });
    expect(migrateLegacyAppSettings("expensive_actions_only")).toEqual({
      general: { defaultSteeringPolicy: "expensive_actions_only" },
    });
    expect(migrateLegacyAppSettings("garbage")).toBeNull();
    expect(migrateLegacyAppSettings(undefined)).toBeNull();
  });

  it("keeps close behavior out of the canonical object — it owns its own key", () => {
    // Close behavior is the close-lifecycle safety preference with its own established store;
    // duplicating it here would create two sources of truth for one safety decision.
    const settings = parseAppSettings({});
    expect(JSON.stringify(settings)).not.toContain("closeBehavior");
  });
});

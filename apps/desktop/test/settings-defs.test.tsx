import { describe, expect, it } from "vitest";
import React from "react";
import { AppSettingsSchema } from "../src/app-settings.js";
import { SETTING_DEFS, getSectionSettings, resolveKeyPath } from "../src/renderer/settings/settings-defs.js";
import { getSettingsSection, searchSettings } from "../src/renderer/settings/settings-registry.js";
import { renderSection, createSettingsContext } from "./settings-test-harness.js";
import { ExtensionsSection } from "../src/renderer/settings/sections/ExtensionsSection.js";

/** Every leaf path of the parsed settings object, e.g. "notifications.enabled". */
function leafPaths(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    leafPaths(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe("canonical settings registry", () => {
  const defaults = AppSettingsSchema.parse({});

  it("assigns every persisted settings leaf exactly one registry def", () => {
    const persisted = leafPaths(defaults).filter((p) => p !== "schemaVersion");
    for (const keyPath of persisted) {
      const defs = SETTING_DEFS.filter((d) => d.keyPath === keyPath);
      expect(defs, `no def registers persisted key ${keyPath}`).toHaveLength(1);
    }
  });

  it("keeps every def's keyPath resolvable against the real schema defaults", () => {
    for (const def of SETTING_DEFS) {
      if (def.storage !== "app-settings") continue;
      expect(def.keyPath, `app-settings def ${def.id} must declare keyPath`).toBeTruthy();
      expect(resolveKeyPath(defaults, def.keyPath!), `keyPath ${def.keyPath} must exist in schema`).not.toBeUndefined();
    }
  });

  it("keeps every def anchored to a real section", () => {
    for (const def of SETTING_DEFS) {
      expect(getSettingsSection(def.sectionId), `def ${def.id} points at unknown section ${def.sectionId}`).toBeTruthy();
    }
    expect(new Set(SETTING_DEFS.map((d) => d.id)).size).toBe(SETTING_DEFS.length);
  });

  it("groups defs by their owning section only", () => {
    expect(getSectionSettings("notifications").map((d) => d.id)).toEqual([
      "notifications-enabled",
      "notify-approval",
      "notify-completed",
      "notify-background-only",
    ]);
  });

  it("searches at the setting level and returns deep-link targets", () => {
    const results = searchSettings("motion");
    const reduceMotion = results.find((r) => r.settingId === "reduce-motion");
    expect(reduceMotion).toBeTruthy();
    expect(reduceMotion!.id).toBe("appearance");
    expect(reduceMotion!.isSection).toBe(false);

    // Setting-level: "tray" lands on the close-behavior row inside Application & Background.
    const tray = searchSettings("tray").find((r) => r.settingId === "close-behavior");
    expect(tray).toBeTruthy();
    expect(tray!.group).toBe("Application & Background");

    // Aliases resolve to the setting, not just its page.
    expect(searchSettings("resume").some((r) => r.settingId === "continue-interrupted-agents")).toBe(true);
    expect(searchSettings("plugin").some((r) => r.id === "extensions")).toBe(true);
  });
});

describe("Extensions settings page", () => {
  it("renders the empty state and the security model when no extensions are installed", () => {
    const markup = renderSection(<ExtensionsSection />, createSettingsContext());
    expect(markup).toContain("No extensions installed");
    expect(markup).toContain("Load extension folder");
    expect(markup).toContain("no Node, filesystem, network, or shell access");
    expect(markup).toContain("Sandboxed host");
  });

  it("renders installed extensions with permissions, status, and controls", () => {
    const context = createSettingsContext({
      extensions: [
        {
          id: "acme.demo",
          name: "Demo Extension",
          version: "1.0.0",
          description: "Does demo things",
          enabled: true,
          status: "active",
          permissions: ["commands:register", "notifications:show"],
          devMode: false,
          commands: [{ id: "demo.run", title: "Run demo" }],
          settings: [{ key: "loud", type: "boolean", label: "Loud mode" }],
        },
      ],
    });
    const markup = renderSection(<ExtensionsSection />, context);
    expect(markup).toContain("Demo Extension");
    expect(markup).toContain("v1.0.0");
    expect(markup).toContain("Register commands");
    expect(markup).toContain("Show notifications");
    expect(markup).toContain("Loud mode");
    expect(markup).toContain("Uninstall");
  });

  it("surfaces an errored extension truthfully", () => {
    const context = createSettingsContext({
      extensions: [
        {
          id: "acme.broken",
          name: "Broken",
          version: "0.1.0",
          description: "",
          enabled: true,
          status: "error",
          lastError: "activate() threw: boom",
          permissions: [],
          devMode: true,
          commands: [],
          settings: [],
        },
      ],
    });
    const markup = renderSection(<ExtensionsSection />, context);
    expect(markup).toContain("activate() threw: boom");
    expect(markup).toContain("dev");
    expect(markup).toContain("Remove link");
  });
});

import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SettingsApp from "../src/renderer/settings/SettingsApp.js";
import { SETTINGS_SECTIONS, SETTINGS_GROUP_ORDER, getSettingsSection, searchSettings } from "../src/renderer/settings/settings-registry.js";
import { createSettingsContext } from "./settings-test-harness.js";

describe("settings registry", () => {
  it("defines the real category set with unique ids", () => {
    const labels = SETTINGS_SECTIONS.map((s) => s.label);
    expect(labels).toEqual([
      "General",
      "Profile & Account",
      "Appearance",
      "Models & Routing",
      "Agents",
      "Verification & Safety",
      "GEMS",
      "Workspaces",
      "Git & GitHub",
      "Runtime & Execution",
      "Notifications",
      "Application & Background",
      "Data & Privacy",
      "Connected Providers",
      "Advanced",
      "About",
    ]);
    expect(new Set(SETTINGS_SECTIONS.map((s) => s.id)).size).toBe(SETTINGS_SECTIONS.length);
  });

  it("groups sections in the documented order and keeps every component resolvable", () => {
    const groups = [...new Set(SETTINGS_SECTIONS.map((s) => s.group))];
    expect(groups.sort()).toEqual([...SETTINGS_GROUP_ORDER].sort());
    for (const section of SETTINGS_SECTIONS) {
      expect(typeof section.component).toBe("function");
      expect(section.keywords.length).toBeGreaterThan(0);
    }
  });

  it("resolves deep links by section id", () => {
    expect(getSettingsSection("profile")?.label).toBe("Profile & Account");
    expect(getSettingsSection("nonexistent")).toBeUndefined();
  });

  it("searches by section name, setting names, and aliases", () => {
    const ids = (query: string) => searchSettings(query).map((r) => r.id);

    // "model" reaches routing, the 8-Bit catalog, ForgeZero, favorites — not just one page.
    expect(ids("model")).toContain("models");
    expect(ids("favorites")).toContain("models");
    expect(ids("forgeauto")).toContain("models");

    // "tray" finds the close-behavior surface.
    expect(ids("tray")).toContain("application");

    // "github" reaches both account identity and Git integration.
    expect(ids("github")).toContain("profile");
    expect(ids("github")).toContain("git");

    // "avatar"/"email" land on the profile; "approve" lands on agents.
    expect(ids("avatar")).toContain("profile");
    expect(ids("email")).toContain("profile");
    expect(ids("approval")).toContain("agents");
  });

  it("returns nothing for nonsense queries and requires every term to match", () => {
    expect(searchSettings("zzzznotathing")).toEqual([]);
    expect(searchSettings("")).toEqual([]);
  });
});

describe("settings shell", () => {
  it("renders the persistent left navigation with groups, search, and a back affordance", () => {
    const markup = renderToStaticMarkup(<SettingsApp context={createSettingsContext()} />);
    expect(markup).toContain("CodeForge Settings");
    expect(markup).toContain("Search settings");
    expect(markup).toContain("← Back");
    for (const label of ["General", "Agents", "GEMS", "Workspaces", "Notifications", "Connected Providers", "About"]) {
      expect(markup).toContain(label);
    }
    // Ampersand-bearing labels render escaped in static markup.
    expect(markup).toContain("Models &amp; Routing");
    expect(markup).toContain("Verification &amp; Safety");
    expect(markup).toContain("Git &amp; GitHub");
    expect(markup).toContain("Application &amp; Background");
    expect(markup).toContain("Data &amp; Privacy");
    // Current section is highlighted with aria-current.
    expect(markup).toMatch(/aria-current="page"/);
  });

  it("deep-links to the requested section", () => {
    const markup = renderToStaticMarkup(<SettingsApp context={createSettingsContext()} initialSection="about" />);
    expect(markup).toContain("CodeForge — free-first autonomous software engineering agent");
  });

  it("ignores unknown deep-link sections and falls back to General", () => {
    const markup = renderToStaticMarkup(<SettingsApp context={createSettingsContext()} initialSection="nope" />);
    expect(markup).toContain("Core CodeForge behavior");
  });
});

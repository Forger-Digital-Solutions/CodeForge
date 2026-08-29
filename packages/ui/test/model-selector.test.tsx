import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import {
  ModelSelector,
  isModelUsable,
  resolveModelSelection,
  type ModelSelectorItem,
  type ModelSection,
} from "../src/ModelSelector.js";
import { DEFAULT_UPGRADE_URL, getUpgradeUrl } from "../src/upgrade-url.js";

const freeModel: ModelSelectorItem = {
  id: "free-model-1",
  displayName: "CodeForge Free Model",
  tier: "free",
};

const unentitledGemsModel: ModelSelectorItem = {
  id: "topaz",
  displayName: "Topaz",
  tier: "gems_paid",
  entitlementStatus: "requires_subscription",
};

const entitledGemsModel: ModelSelectorItem = {
  id: "topaz",
  displayName: "Topaz",
  tier: "gems_paid",
  entitlementStatus: "included",
};

const trialGemsModel: ModelSelectorItem = {
  id: "garnet",
  displayName: "Garnet",
  tier: "gems_paid",
  entitlementStatus: "trial",
};

describe("isModelUsable", () => {
  it("allows free-tier models", () => {
    expect(isModelUsable(freeModel)).toBe(true);
  });

  it("denies unentitled GEMS models", () => {
    expect(isModelUsable(unentitledGemsModel)).toBe(false);
    expect(isModelUsable({ ...unentitledGemsModel, entitlementStatus: "not_entitled" })).toBe(false);
    expect(isModelUsable({ ...unentitledGemsModel, entitlementStatus: undefined })).toBe(false);
  });

  it("allows entitled and trial GEMS models", () => {
    expect(isModelUsable(entitledGemsModel)).toBe(true);
    expect(isModelUsable(trialGemsModel)).toBe(true);
  });
});

describe("resolveModelSelection", () => {
  const options = { upgradeUrl: "https://example.com/pricing" };

  it("allows selection of free models", () => {
    const intent = resolveModelSelection(freeModel, options);
    expect(intent.allowed).toBe(true);
    expect(intent.navigateToUpgrade).toBe(false);
  });

  it("routes unentitled GEMS models to upgrade instead of execution", () => {
    const intent = resolveModelSelection(unentitledGemsModel, options);
    expect(intent.allowed).toBe(false);
    expect(intent.navigateToUpgrade).toBe(true);
    expect(intent.url).toBe("https://example.com/pricing");
  });

  it("allows entitled and trial GEMS models", () => {
    expect(resolveModelSelection(entitledGemsModel, options).allowed).toBe(true);
    expect(resolveModelSelection(trialGemsModel, options).allowed).toBe(true);
  });
});

describe("ModelSelector rendering", () => {
  it("renders paid lock badges for unentitled GEMS models in dropdown", () => {
    const markup = renderToStaticMarkup(
      React.createElement(ModelSelector, {
        models: [freeModel, unentitledGemsModel],
        selectedId: null,
        onSelect: () => {},
        isOpen: true,
      }),
    );
    expect(markup).toContain("Unavailable");
    expect(markup).toContain("aria-disabled=\"true\"");
    expect(markup).toContain("Free");
  });

  it("does not render lock badge for entitled GEMS models", () => {
    const markup = renderToStaticMarkup(
      React.createElement(ModelSelector, {
        models: [entitledGemsModel],
        selectedId: null,
        onSelect: () => {},
        isOpen: true,
      }),
    );
    expect(markup).not.toContain("Unavailable");
    expect(markup).not.toContain("aria-disabled");
  });

  it("renders the Auto entry in trigger button with its description", () => {
    const auto: ModelSelectorItem = {
      id: "auto",
      displayName: "Auto",
      tier: "free",
      description: "Best Free Model",
    };
    const markup = renderToStaticMarkup(
      React.createElement(ModelSelector, {
        models: [auto, freeModel, unentitledGemsModel],
        selectedId: "auto",
        onSelect: () => {},
      }),
    );
    expect(markup).toContain("Auto");
    expect(markup).toContain("Best Free Model");
    expect(markup).toContain("aria-selected=\"true\"");
  });
});

describe("ModelSelector section information architecture", () => {
  const sections: ModelSection[] = [
    {
      sectionId: "codeforge",
      sectionLabel: "CODEFORGE",
      models: [{ id: "auto", displayName: "Auto", tier: "free", description: "Best Verified Free" }],
    },
    {
      sectionId: "verified-free",
      sectionLabel: "VERIFIED FREE",
      models: [{ id: "free-model-1", displayName: "CodeForge Free Model", tier: "free", description: "Free" }],
    },
    {
      sectionId: "gems",
      sectionLabel: "GEMS",
      models: [
        { id: "topaz", displayName: "Topaz", tier: "gems_paid" },
        { id: "sapphire", displayName: "Sapphire", tier: "gems_paid" },
        { id: "peridot", displayName: "Peridot", tier: "gems_paid" },
        { id: "garnet", displayName: "Garnet", tier: "gems_paid" },
      ],
    },
    { sectionId: "anthropic", sectionLabel: "ANTHROPIC", models: [], note: "Not connected · BYOK coming soon" },
    { sectionId: "openai", sectionLabel: "OPENAI", models: [], note: "Not connected · integration coming soon" },
    { sectionId: "zai", sectionLabel: "Z.AI", models: [], note: "Not connected · integration coming soon" },
  ];

  function renderSelector(): string {
    return renderToStaticMarkup(
      React.createElement(ModelSelector, {
        models: sections.flatMap((s) => s.models),
        selectedId: "auto",
        onSelect: () => {},
        isOpen: true,
        modelSections: sections,
      }),
    );
  }

  it("renders CODEFORGE, VERIFIED FREE, GEMS, ANTHROPIC, OPENAI and Z.AI groups in order", () => {
    const markup = renderSelector();
    const order = ["CODEFORGE", "VERIFIED FREE", "GEMS", "ANTHROPIC", "OPENAI", "Z.AI"];
    let cursor = -1;
    for (const label of order) {
      const at = markup.indexOf(label);
      expect(at, `section ${label} present`).toBeGreaterThan(-1);
      expect(at, `section ${label} in order`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it("groups all four GEMS (Topaz, Sapphire, Peridot, Garnet) together", () => {
    const markup = renderSelector();
    for (const gem of ["Topaz", "Sapphire", "Peridot", "Garnet"]) {
      expect(markup).toContain(gem);
    }
  });

  it("shows honest 'not connected' notes for providers without a connected model", () => {
    const markup = renderSelector();
    expect(markup).toContain("Not connected");
  });

  it("never surfaces the promotional Muse Spark model in the selector", () => {
    const markup = renderSelector();
    expect(markup).not.toMatch(/muse\s*spark/i);
    expect(markup).not.toContain("Promotional Free");
  });
});

describe("upgrade URL seam", () => {
  it("exposes a centralized default URL", () => {
    expect(DEFAULT_UPGRADE_URL).toBe("https://codeforge.dev/pricing");
    expect(getUpgradeUrl()).toBe(DEFAULT_UPGRADE_URL);
  });
});

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import {
  ModelSelector,
  isModelUsable,
  resolveModelSelection,
  type ModelSelectorItem,
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
    expect(markup).toContain("Paid 🔒");
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
    expect(markup).not.toContain("Paid 🔒");
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

describe("upgrade URL seam", () => {
  it("exposes a centralized default URL", () => {
    expect(DEFAULT_UPGRADE_URL).toBe("https://codeforge.dev/pricing");
    expect(getUpgradeUrl()).toBe(DEFAULT_UPGRADE_URL);
  });
});

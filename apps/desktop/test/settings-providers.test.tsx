import { describe, expect, it } from "vitest";
import { ProvidersSection } from "../src/renderer/settings/sections/ProvidersSection.js";
import { AdvancedSection } from "../src/renderer/settings/sections/AdvancedSection.js";
import { AboutSection } from "../src/renderer/settings/sections/AboutSection.js";
import { renderSection, createSettingsContext } from "./settings-test-harness.js";

describe("Connected Providers page", () => {
  it("is framed as optional expansion, not a prerequisite", () => {
    const markup = renderSection(<ProvidersSection />, createSettingsContext());
    expect(markup).toContain("Optional providers expand CodeForge");
    expect(markup).toContain("without any provider configuration");
  });

  it("lists the supported providers with truthful connection state", () => {
    const context = createSettingsContext({
      providerStatus: {
        openrouter: { status: "available" },
        zai: { status: "error", error: "401 unauthorized" },
      },
    });
    const markup = renderSection(<ProvidersSection />, context);
    for (const provider of ["OpenRouter", "Z.AI", "Google Gemini", "Groq", "OpenCode Zen", "Anthropic", "OpenAI"]) {
      expect(markup).toContain(provider);
    }
    expect(markup).toContain("Connected");
    expect(markup).toContain("Error");
    expect(markup).toContain("Not connected");
    expect(markup).toContain("401 unauthorized");
  });

  it("never renders a stored secret — the credential manager shows empty key fields", () => {
    const markup = renderSection(<ProvidersSection />, createSettingsContext());
    expect(markup).toContain("type=\"password\"");
    // No secret value is ever present in markup; the embedded manager starts blank.
    expect(markup).not.toContain("sk-");
    expect(markup).not.toContain("Enter your API key\" value=\"");
  });
});

describe("Advanced page", () => {
  it("reports catalog diagnostics from the real catalog", () => {
    const markup = renderSection(<AdvancedSection />, createSettingsContext());
    expect(markup).toContain("Catalog diagnostics");
    expect(markup).toContain("Reset application preferences");
    expect(markup).toContain("Open data folder");
  });

  it("defines what the reset operation resets — and what it keeps", () => {
    const markup = renderSection(<AdvancedSection />, createSettingsContext());
    expect(markup).toContain("Resets Settings preferences");
    expect(markup).toContain("Provider credentials, close behavior, and workspace history are kept");
    // Two-step confirmation: the destructive action itself is not present on first render.
    expect(markup).not.toMatch(/>Reset preferences</);
  });
});

describe("About page", () => {
  it("shows real version, channel, and runtime facts", () => {
    const markup = renderSection(<AboutSection />, createSettingsContext());
    expect(markup).toContain("0.3.0");
    expect(markup).toContain("Electron 33.4.11");
    expect(markup).toContain("MIT License");
    expect(markup).toContain("Manual");
  });

  it("does not claim an auto-update capability that does not exist", () => {
    const markup = renderSection(<AboutSection />, createSettingsContext());
    expect(markup).toContain("does not auto-update itself");
  });
});

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const renderer = (file: string) => readFileSync(resolve(here, "..", "src", "renderer", file), "utf8");

describe("desktop account header layout", () => {
  it("renders the header account control through the themed account button (no inline hex styles)", () => {
    const shell = renderer("WorkspaceShell.tsx");
    expect(shell).toContain('className="cloud-account-btn"');
    expect(shell).not.toContain("cloud-signin-btn");
    // The old account button carried raw hex colors inline; the Settings visual system uses tokens.
    expect(shell).not.toContain('"#38bdf8"');
    const css = renderer("settings.css");
    expect(css).toContain(".cloud-account-btn");
    expect(css).toContain(".cloud-account-menu");
  });

  it("uses the server's 30-day allowance wording across onboarding and account UI", () => {
    // R16: the sign-in screen answers a new user's questions in product language — no API key is
    // needed for the free models, and providers are an optional later step, never "configuration".
    const auth = renderer("AuthScreen.tsx");
    expect(auth).toContain("no API key required");
    expect(auth).toContain("You can connect your own AI providers later");
    expect(auth).not.toContain("Provider configuration");
    expect(renderer("settings/sections/ProfileSection.tsx")).toContain("30-day period");
    expect(auth).not.toContain("500,000 monthly credits");
  });

  it("never renders a legal link that has no published destination", () => {
    const auth = renderer("AuthScreen.tsx");
    expect(auth).not.toContain("https://codeforge.dev/privacy");
    expect(auth).toContain("isConfiguredLink(PRIVACY_URL)");
    const links = renderer("product-links.ts");
    expect(links).toMatch(/privacyPolicy: ""/);
  });
});

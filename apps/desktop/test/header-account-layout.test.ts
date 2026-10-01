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

  it("uses the server's UTC-month allowance wording across onboarding and account UI", () => {
    // R16: the sign-in screen answers a new user's questions in product language — no API key is
    // needed for the free models, and providers are an optional later step, never "configuration".
    const auth = renderer("AuthScreen.tsx");
    expect(auth).toContain("No API key required");
    expect(auth).toContain("your own AI providers later");
    expect(auth).not.toContain("Provider configuration");
    expect(renderer("settings/sections/ProfileSection.tsx")).toContain("UTC calendar month");
    expect(auth).not.toContain("500,000 monthly credits");
  });

  it("sign-in CTA renders the real GitHub mark, not a placeholder glyph", () => {
    const auth = renderer("AuthScreen.tsx");
    // The official Octocat silhouette path ships inline (viewBox 0 0 24 24); the old "●" bullet in
    // a circle border read as a generic target icon.
    expect(auth).toContain("GitHubMark");
    expect(auth).toContain('viewBox="0 0 24 24"');
    expect(auth).not.toContain("github-glyph");
    expect(auth).toContain("Continue with GitHub");
  });

  it("first-run acknowledgement stays explicit about file and command access", () => {
    const auth = renderer("AuthScreen.tsx");
    expect(auth).toContain("18 or older");
    expect(auth).toContain("read and modify project files");
    expect(auth).toContain("run commands");
    expect(auth).toContain("approval settings");
    // No implication of unrestricted OS access.
    expect(auth).not.toContain("full access");
    expect(auth).not.toContain("any file on this computer");
  });

  it("never renders a legal link that has no published destination", () => {
    const auth = renderer("AuthScreen.tsx");
    expect(auth).not.toContain("https://codeforge.dev/privacy");
    expect(auth).toContain("isConfiguredLink(PRIVACY_URL)");
    const links = renderer("product-links.ts");
    expect(links).toMatch(/privacyPolicy: ""/);
  });
});

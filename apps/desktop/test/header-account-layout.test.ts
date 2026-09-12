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
    expect(renderer("AuthScreen.tsx")).toContain("Provider configuration comes after sign-in");
    expect(renderer("settings/sections/ProfileSection.tsx")).toContain("30-day period");
    expect(renderer("AuthScreen.tsx")).not.toContain("500,000 monthly credits");
  });
});

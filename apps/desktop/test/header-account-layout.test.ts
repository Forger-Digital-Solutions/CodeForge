import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const renderer = (file: string) => readFileSync(resolve(here, "..", "src", "renderer", file), "utf8");

describe("desktop account header layout", () => {
  it("keeps the account controls out of the square icon-button sizing rule", () => {
    const css = renderer("styles.css");
    expect(css).toContain(".header-btn.cloud-signin-btn");
    expect(css).toContain(".header-btn.cloud-account-btn");
    expect(css).toContain("width: auto;");
    expect(css).toContain("white-space: nowrap;");
    expect(css).toContain("text-overflow: ellipsis;");
  });

  it("uses the server's 30-day allowance wording across onboarding and account UI", () => {
    expect(renderer("AuthScreen.tsx")).toContain("Provider configuration comes after sign-in");
    expect(renderer("WorkspaceShell.tsx")).toContain("each 30-day hosted-usage period");
    expect(renderer("AuthScreen.tsx")).not.toContain("500,000 monthly credits");
  });
});

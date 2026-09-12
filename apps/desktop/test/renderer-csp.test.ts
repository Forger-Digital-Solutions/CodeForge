import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rendererHtml = readFileSync(resolve(here, "..", "src", "renderer", "index.html"), "utf8");

describe("desktop renderer CSP", () => {
  it("allows the bundled data-URL activity assets without broadening script sources", () => {
    expect(rendererHtml).toContain("img-src 'self' data:");
    expect(rendererHtml).toContain("script-src 'self' 'unsafe-inline'");
    expect(rendererHtml).not.toContain("script-src *");
  });

  it("allows GitHub avatar images for the account identity without a broad wildcard", () => {
    // The account avatar is the one remote image the app renders; it may come only from
    // GitHub's avatar host — no wildcard img-src may sneak in.
    expect(rendererHtml).toContain("img-src 'self' data: https://avatars.githubusercontent.com");
    expect(rendererHtml).not.toContain("img-src *");
  });
});

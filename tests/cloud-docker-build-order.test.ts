import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("cloud Docker build graph", () => {
  it("builds the secrets workspace before the root project graph", async () => {
    const dockerfile = (await readFile(new URL("../Dockerfile.cloud", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
    const secretsBuild = dockerfile.indexOf("RUN npx tsc -b packages/core packages/secrets");
    const rootBuild = dockerfile.indexOf("&& npx tsc -b \\\n");

    expect(secretsBuild).toBeGreaterThanOrEqual(0);
    expect(rootBuild).toBeGreaterThan(secretsBuild);
  });
});

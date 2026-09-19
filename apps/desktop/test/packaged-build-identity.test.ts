import { describe, expect, it } from "vitest";
import { validatePackagedBuildIdentity } from "../scripts/audit-packaged-build-identity.mjs";

const HEAD = "a".repeat(40);
const stamp = { version: "0.4.0", commit: HEAD, shortCommit: HEAD.slice(0, 12), branch: "main", dirty: false, builtAt: "2026-09-19T10:00:00.000Z" };

/** R16: an installer once shipped a renderer bundle older than its sources; this gate refuses that. */
describe("packaged build identity audit", () => {
  it("accepts an archive whose main and renderer stamps match the current HEAD", () => {
    expect(validatePackagedBuildIdentity({ stamp, rendererStamps: [{ commit: HEAD, dirty: false, builtAt: stamp.builtAt }], headCommit: HEAD, requireClean: true })).toEqual({ commit: HEAD, builtAt: stamp.builtAt, dirty: false });
  });
  it("refuses a renderer bundle from an older build of the same commit (stale bundle)", () => {
    expect(() => validatePackagedBuildIdentity({ stamp, rendererStamps: [{ commit: HEAD, dirty: false, builtAt: "2026-09-19T09:00:00.000Z" }], headCommit: HEAD, requireClean: false })).toThrow(/stale renderer build/);
  });
  it("refuses an unstamped renderer bundle", () => {
    expect(() => validatePackagedBuildIdentity({ stamp, rendererStamps: [], headCommit: HEAD, requireClean: false })).toThrow(/no build stamp/);
  });
  it("refuses an archive built from a different commit than the checkout", () => {
    expect(() => validatePackagedBuildIdentity({ stamp, rendererStamps: [{ commit: HEAD, dirty: false, builtAt: stamp.builtAt }], headCommit: "b".repeat(40), requireClean: false })).toThrow(/not the current HEAD/);
  });
  it("refuses dirty sources only when a clean release is required", () => {
    const dirty = { ...stamp, dirty: true };
    expect(validatePackagedBuildIdentity({ stamp: dirty, rendererStamps: [{ commit: HEAD, dirty: true, builtAt: stamp.builtAt }], headCommit: HEAD, requireClean: false }).dirty).toBe(true);
    expect(() => validatePackagedBuildIdentity({ stamp: dirty, rendererStamps: [{ commit: HEAD, dirty: true, builtAt: stamp.builtAt }], headCommit: HEAD, requireClean: true })).toThrow(/dirty working tree/);
  });
});

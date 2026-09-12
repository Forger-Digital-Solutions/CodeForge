import { describe, it, expect } from "vitest";
import { offlineCloudAccount } from "../src/cloud-account.js";

/**
 * When CodeForge Cloud is unreachable, a signed-in user must not be thrown to the sign-in screen:
 * local and BYOK routes do not need the cloud. The fallback presents the remembered identity and
 * claims nothing else — no plan, no balance — and never invents an account for a device that never
 * signed in.
 */
describe("offlineCloudAccount", () => {
  it("keeps the remembered identity, marked offline, with no plan or balance", () => {
    expect(offlineCloudAccount({ id: "u1", displayName: "Ada" })).toEqual({ user: { id: "u1", displayName: "Ada" }, offline: true });
  });

  it("never manufactures an account without a remembered sign-in", () => {
    expect(offlineCloudAccount(undefined)).toBeNull();
    expect(offlineCloudAccount(null)).toBeNull();
    expect(offlineCloudAccount({})).toBeNull();
    expect(offlineCloudAccount("Ada")).toBeNull();
  });
});

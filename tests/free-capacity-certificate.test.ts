import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Free Capacity Fabric source certificate", () => {
  it("matches the authoritative source and evidence bytes on disk", async () => {
    const script = resolve(import.meta.dirname, "../scripts/free-capacity-certificate.mjs");
    expect(execFileSync(process.execPath, [script, "--verify"], { encoding: "utf8" })).toContain("FREE_CAPACITY_CERTIFICATE_VALID");
  });
});

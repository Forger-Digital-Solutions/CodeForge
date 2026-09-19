import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const desktopDirectory = resolve(import.meta.dirname, "..");
const script = resolve(desktopDirectory, "scripts", "package-release.mjs");

function dryRun(...args: string[]): string {
  return execFileSync(process.execPath, [script, ...args, "--dry-run"], {
    cwd: desktopDirectory,
    encoding: "utf8",
  }).trim();
}

describe("release packaging channel", () => {
  it("routes the ordinary distribution command through the release manifest wrapper", () => {
    const pkg = JSON.parse(readFileSync(resolve(desktopDirectory, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts.dist).toBe("node scripts/package-release.mjs");
    expect(readFileSync(script, "utf8")).toContain("call npm.cmd");
  });

  it("defaults a release artifact to the approved production endpoint rather than development loopback", () => {
    const result = JSON.parse(dryRun()) as { channel: string; endpoint: string };
    expect(result).toEqual({ channel: "production", endpoint: "https://codeforge-cloud-va.onrender.com" });
  });

  it("rejects a development release channel and loopback production authority", () => {
    expect(() => dryRun("--channel", "development")).toThrow(/staging or production/i);
    expect(() => dryRun("--url", "https://127.0.0.1:3220")).toThrow(/must not be loopback/i);
  });
});

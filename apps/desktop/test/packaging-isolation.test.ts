import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error The release guard is executed by Node before compiled application code exists.
import { assertPackagingIsolation } from "../scripts/packaging-isolation.mjs";

describe("fail-closed packaging isolation", () => {
  let directory: string;
  let root: string;
  let desktop: string;
  let common: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "r76-package-"));
    root = join(directory, "isolated");
    desktop = join(root, "apps", "desktop");
    common = join(directory, "primary", ".git");
    mkdirSync(desktop, { recursive: true });
    mkdirSync(common, { recursive: true });
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));
  const check = (options: { status?: string; common?: string; output?: string } = {}) => assertPackagingIsolation({
    repositoryRoot: root, desktopDirectory: desktop, outputDirectory: options.output ?? join(desktop, "release-r76"),
    git: (args: string[]) => args[0] === "status" ? options.status ?? "" : args.includes("--show-toplevel") ? root : args.includes("--git-common-dir") ? options.common ?? common : "a".repeat(40),
  });
  it("accepts a clean isolated source and a fresh dedicated output", () => {
    expect(check()).toMatchObject({ sourceRevision: "a".repeat(40), outputDirectory: join(realpathSync.native(desktop), "release-r76") });
  });
  it("rejects primary checkout packaging before any build or output write", () => {
    const primaryGit = join(root, ".git");
    mkdirSync(primaryGit);
    expect(() => check({ common: primaryGit })).toThrow("PACKAGING_PROTECTED_PRIMARY_CHECKOUT");
  });
  it.each([" M packages/providers/src/capacity-governor.ts", "?? pending-source.ts"])("rejects dirty source: %s", status => {
    expect(() => check({ status })).toThrow("PACKAGING_SOURCE_DIRTY");
  });
  it("refuses to overwrite an older artifact", () => {
    const output = join(desktop, "release-r76");
    mkdirSync(output);
    writeFileSync(join(output, "CodeForge Setup.exe"), "protected artifact");
    expect(() => check()).toThrow("PACKAGING_OUTPUT_NOT_EMPTY");
  });
  it("rejects an escaping output path", () => {
    expect(() => check({ output: join(directory, "primary", "release") })).toThrow("PACKAGING_OUTPUT_OUTSIDE");
  });
  it("rejects a junction redirecting a release ancestor into protected output", () => {
    const protectedOutput = join(directory, "primary", "release");
    mkdirSync(protectedOutput);
    const redirect = join(desktop, "redirect");
    symlinkSync(protectedOutput, redirect, process.platform === "win32" ? "junction" : "dir");
    expect(() => check({ output: join(redirect, "new-release") })).toThrow("PACKAGING_REDIRECT");
  });
});

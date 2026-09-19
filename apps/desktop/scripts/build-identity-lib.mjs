/**
 * Source identity of a build: the git commit the sources came from, whether the working tree was
 * dirty, and the build time — so an installed binary can always be traced back to exact sources,
 * and a packaged bundle that does not match the checkout that claims to have produced it is
 * detectable (R16 §66, §91). Pure: no side effects at import.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const desktopDirectory = resolve(here, "..");
export const repositoryRoot = resolve(desktopDirectory, "..", "..");

function git(args) {
  try {
    return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

export function computeBuildIdentity(now = new Date()) {
  const commit = git(["rev-parse", "HEAD"]) || "unknown";
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]) || "unknown";
  const dirtyOutput = git(["status", "--porcelain", "--untracked-files=no"]);
  const version = JSON.parse(readFileSync(resolve(desktopDirectory, "package.json"), "utf8")).version;
  return {
    version,
    commit,
    shortCommit: commit === "unknown" ? "unknown" : commit.slice(0, 12),
    branch,
    dirty: dirtyOutput.length > 0,
    builtAt: now.toISOString(),
  };
}

/** The identity stamped by the most recent `build:main`, if any (so the renderer build reuses it). */
export function readStampedBuildIdentity() {
  try {
    return JSON.parse(readFileSync(resolve(desktopDirectory, "dist", "build-identity.json"), "utf8"));
  } catch {
    return null;
  }
}

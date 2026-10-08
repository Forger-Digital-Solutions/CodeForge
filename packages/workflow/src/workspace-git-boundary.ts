import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export function workspaceOwnsGitRoot(workspacePath: string): boolean {
  try {
    const root = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: workspacePath, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    if (root.status !== 0 || !root.stdout.trim()) return false;
    const canonical = (value: string): string => process.platform === "win32" ? fs.realpathSync.native(value).toLowerCase() : fs.realpathSync.native(value);
    return canonical(root.stdout.trim()) === canonical(path.resolve(workspacePath));
  } catch { return false; }
}

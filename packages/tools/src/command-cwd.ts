export function commandCwdArgumentIssue(cwd: unknown, platform: NodeJS.Platform = process.platform): string | undefined {
  if (cwd === undefined || cwd === "") return undefined;
  if (typeof cwd !== "string") return "cwd must be a string relative to the assigned workspace, or omitted.";
  if (platform === "win32" && /^\/(?!\/)/.test(cwd) && !cwd.split(/[\\/]/).includes("..")) {
    return "POSIX-root cwd is unsupported on native Windows. The command was not executed. Omit cwd or use cwd '.' for the assigned workspace root; use relative paths for its subdirectories. Do not invent a Linux workspace path.";
  }
  return undefined;
}

import fs from "node:fs";
import path from "node:path";

export interface PathContainmentResult {
  valid: boolean;
  resolvedPath?: string;
  error?: string;
}

/**
 * Resolve symlinks/junctions as far along the path as they exist.
 *
 * A boundary check on the lexical path alone can be bypassed by a link inside
 * the workspace pointing outside of it (e.g. escape -> C:\outside). Realpaths
 * are compared against the real workspace root so those escapes are rejected.
 */
export function realpathDeepestExisting(target: string): string {
  const absolute = path.resolve(target);
  let current = absolute;
  for (;;) {
    try {
      return fs.realpathSync(current);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return absolute;
      }
      current = parent;
    }
  }
}

function escapesBoundary(relative: string): boolean {
  const normalized = process.platform === "win32" ? relative.toLowerCase() : relative;
  if (normalized === "") return false;
  if (path.isAbsolute(normalized)) return true;
  return normalized === ".." || normalized.startsWith(".." + path.sep);
}

/**
 * Resolve requestedPath against workspaceRoot and enforce containment,
 * including symlink/junction-aware boundary checks.
 *
 * Absolute paths are honored but must land inside the workspace.
 */
export function resolveWithinWorkspace(
  workspaceRoot: string,
  requestedPath: string,
): PathContainmentResult {
  if (!workspaceRoot) {
    return { valid: false, error: "No workspace path configured" };
  }

  const rootReal = realpathDeepestExisting(workspaceRoot);

  // Lexical check first: rejects ../ traversal without requiring the target to exist
  const lexical = path.resolve(rootReal, requestedPath);
  if (escapesBoundary(path.relative(rootReal, lexical))) {
    return { valid: false, error: `Path traversal denied: ${requestedPath}` };
  }

  // Realpath check second: catches links inside the workspace that point outside.
  // Only used for the containment decision — the returned path stays lexical so
  // operations on not-yet-existing files target the requested location.
  const effective = realpathDeepestExisting(lexical);
  if (escapesBoundary(path.relative(rootReal, effective))) {
    return { valid: false, error: `Path traversal denied: ${requestedPath}` };
  }

  return { valid: true, resolvedPath: lexical };
}

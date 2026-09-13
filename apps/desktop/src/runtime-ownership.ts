import fs from "node:fs";
import path from "node:path";

export interface RuntimeMetadata {
  instanceId: string;
  pid: number;
  profilePath: string;
  runtimeEndpoint: string;
  startupTimestamp: string;
  applicationVersion: string;
  executablePath?: string;
  parentElectronPid?: number;
}

export type RuntimeMetadataState = "missing" | "stale" | "active" | "mismatch" | "invalid";

export function runtimeMetadataPath(profilePath: string): string {
  return path.join(profilePath, "runtime.json");
}

export function parseRuntimeMetadata(raw: unknown): RuntimeMetadata | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (
    typeof value.instanceId !== "string" || value.instanceId.length < 8 || value.instanceId.length > 128 ||
    typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0 ||
    typeof value.profilePath !== "string" || value.profilePath.length === 0 ||
    typeof value.runtimeEndpoint !== "string" || !isLoopbackRuntimeEndpoint(value.runtimeEndpoint) ||
    typeof value.startupTimestamp !== "string" ||
    typeof value.applicationVersion !== "string"
  ) return null;
  return {
    instanceId: value.instanceId,
    pid: value.pid,
    profilePath: value.profilePath,
    runtimeEndpoint: value.runtimeEndpoint,
    startupTimestamp: value.startupTimestamp,
    applicationVersion: value.applicationVersion,
    ...(typeof value.executablePath === "string" ? { executablePath: value.executablePath } : {}),
    ...(typeof value.parentElectronPid === "number" && Number.isSafeInteger(value.parentElectronPid) ? { parentElectronPid: value.parentElectronPid } : {}),
  };
}

export function isLoopbackRuntimeEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
      url.pathname === "/" && url.search === "" && url.hash === "" && Number(url.port) > 0;
  } catch {
    return false;
  }
}

export function readRuntimeMetadata(filePath: string): RuntimeMetadata | null {
  try {
    return parseRuntimeMetadata(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch {
    return null;
  }
}

export function writeRuntimeMetadata(filePath: string, metadata: RuntimeMetadata): void {
  const parsed = parseRuntimeMetadata(metadata);
  if (!parsed) throw new Error("Invalid CodeForge runtime metadata");
  const temporaryPath = `${filePath}.${metadata.instanceId}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(temporaryPath, JSON.stringify(parsed, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch { /* Windows ignores chmod; best effort. */ }
}

export function removeRuntimeMetadataIfOwned(filePath: string, instanceId: string, pid: number): boolean {
  const current = readRuntimeMetadata(filePath);
  if (!current || current.instanceId !== instanceId || current.pid !== pid) return false;
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function classifyRuntimeMetadata(
  metadata: RuntimeMetadata | null,
  profilePath: string,
  pidAlive: (pid: number) => boolean = isPidAlive,
): RuntimeMetadataState {
  if (!metadata) return "missing";
  if (path.resolve(metadata.profilePath) !== path.resolve(profilePath)) return "mismatch";
  return pidAlive(metadata.pid) ? "active" : "stale";
}

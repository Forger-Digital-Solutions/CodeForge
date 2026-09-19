import type { ExtensionManifest, ExtensionPermission } from "./manifest.js";

/**
 * Permission enforcement for the extension host. The sandboxed context gives extension code
 * nothing by default; the API object it receives checks the manifest's declared permissions on
 * every capability call. Undeclared use throws PermissionDeniedError — the extension sees a
 * normal JS exception it can catch, and the host stays up.
 */

export class PermissionDeniedError extends Error {
  readonly extensionId: string;
  readonly permission: ExtensionPermission;
  constructor(extensionId: string, permission: ExtensionPermission) {
    super(`Extension "${extensionId}" requires the "${permission}" permission, which its manifest does not declare`);
    this.name = "PermissionDeniedError";
    this.extensionId = extensionId;
    this.permission = permission;
  }
}

export function hasPermission(manifest: ExtensionManifest, permission: ExtensionPermission): boolean {
  return manifest.permissions.includes(permission);
}

export function assertPermission(manifest: ExtensionManifest, permission: ExtensionPermission): void {
  if (!hasPermission(manifest, permission)) {
    throw new PermissionDeniedError(manifest.id, permission);
  }
}

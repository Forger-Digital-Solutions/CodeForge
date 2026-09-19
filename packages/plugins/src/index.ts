export {
  EXTENSION_MANIFEST_FILENAME,
  ExtensionManifestSchema,
  ManifestError,
  engineSatisfied,
  parseExtensionManifest,
  type ExtensionCommandContribution,
  type ExtensionManifest,
  type ExtensionPermission,
  type ExtensionSettingContribution,
} from "./manifest.js";
export { PermissionDeniedError, assertPermission, hasPermission } from "./permissions.js";
export { buildExtensionApi, type CodeForgeExtensionApi, type ExtensionHostDelegates } from "./api.js";
export { ExtensionHost, ExtensionLoadError, type ExtensionStatus, type HostedExtension } from "./host.js";
export {
  ExtensionManager,
  type ExtensionManagerDeps,
  type ExtensionRecord,
  type ExtensionViewSnapshot,
  type ExtensionStateStore,
  type SecretStore,
} from "./manager.js";

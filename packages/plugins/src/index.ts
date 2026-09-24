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
export {
  canonicalize,
  MARKETPLACE_ERRORS,
  MARKETPLACE_INDEX_SCHEMA,
  MARKETPLACE_PACKAGE_SCHEMA,
  MarketplaceClient,
  MarketplaceError,
  signMarketplaceIndex,
  type ExtensionPackage,
  type ExtensionPackageFile,
  type FetchLike,
  type MarketplaceCatalogEntry,
  type MarketplaceClientOptions,
  type MarketplaceErrorCode,
  type MarketplaceIndex,
  type MarketplaceSource,
} from "./catalog.js";

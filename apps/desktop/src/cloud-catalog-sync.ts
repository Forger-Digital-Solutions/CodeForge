/**
 * Decides how the desktop should reconcile CodeForge's hosted free-model catalog against the
 * current sign-in state. Pulled out of main.ts (Electron main-process side effects make that file
 * unsuitable for direct unit testing) so the actual policy — the fix for the "fresh install shows
 * only one generic free model" bug — has real, fast test coverage instead of relying solely on
 * manual/packaged verification.
 *
 * The policy: `GET /v1/hosted/models` (listing) requires no authentication — only
 * `/v1/hosted/inference` (actually running a model) does. The catalog may be browsed while signed
 * out, but the executable provider adapter is registered only after sign-in. The server exposes
 * those unsigned routes as unavailable and fails closed instead of simulating inference.
 */
export type CloudCatalogSyncMode = "register-adapter-and-sync" | "sync-catalog-only";

export function resolveCloudCatalogSyncMode(hasCloudAccessToken: boolean): CloudCatalogSyncMode {
  return hasCloudAccessToken ? "register-adapter-and-sync" : "sync-catalog-only";
}

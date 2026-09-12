/**
 * Decides how the desktop should reconcile CodeForge's hosted free-model catalog against the
 * current sign-in state. Pulled out of main.ts (Electron main-process side effects make that file
 * unsuitable for direct unit testing) so the actual policy — the fix for the "fresh install shows
 * only one generic free model" bug — has real, fast test coverage instead of relying solely on
 * manual/packaged verification.
 *
 * The policy: `GET /v1/hosted/models` (listing) requires no authentication — only
 * `/v1/hosted/inference` (actually running a model) does. So the catalog should always be visible,
 * but the provider adapter should only be registered into providerCatalog (which is what flips
 * CodeForgeServer from the safe scripted demo runtime to attempting real inference) once the user
 * is actually signed in — otherwise a signed-out fresh install would attempt real hosted inference
 * with no credential and get a confusing 401 instead of the existing safe demo.
 */
export type CloudCatalogSyncMode = "register-adapter-and-sync" | "sync-catalog-only";

export function resolveCloudCatalogSyncMode(hasCloudAccessToken: boolean): CloudCatalogSyncMode {
  return hasCloudAccessToken ? "register-adapter-and-sync" : "sync-catalog-only";
}

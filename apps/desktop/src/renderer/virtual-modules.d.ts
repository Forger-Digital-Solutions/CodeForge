// Ambient declarations for Vite virtual modules (this file must stay a script, not a module).
declare module "virtual:codeforge-build-identity" {
  /** JSON of the build stamp inlined by the Vite build (see vite.config.ts). */
  export const RENDERER_BUILD_IDENTITY_JSON: string;
}

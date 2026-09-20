export * from "./policy.js";
export * from "./resolver.js";
export * from "./runtime.js";
export * from "./tools.js";
export * from "./verify.js";

import { fileURLToPath } from "node:url";
/**
 * Absolute path to the compiled verifier CLI — used by the ForgeVerify definition factory.
 * Resolved as <pkg>/dist/verify-cli.js so it is correct whether this module is loaded from
 * src/ (vitest) or dist/ (production).
 */
export function verifyCliPath(): string {
  return fileURLToPath(new URL("../dist/verify-cli.js", import.meta.url));
}

/**
 * VS Code Extension Tests
 *
 * These tests REQUIRE running an actual VS Code instance with Electron,
 * which is provided by @vscode/test-electron. This is fundamentally different
 * from unit tests and cannot run in Vitest.
 *
 * Why @vscode/test-electron tests are NOT feasible here:
 *
 * 1. Requires actual VS Code executable (Electron-based)
 * 2. Requires downloading and running a separate VS Code instance
 * 3. Tests run inside the VS Code extension host process
 * 4. CI setup requires VS Code binary (not available in all CI environments)
 * 5. Test execution is slow (launching VS Code takes seconds)
 *
 * What we CAN test without @vscode/test-electron:
 *
 * 1. Server activation and configuration (tested via @codeforge/server tests)
 * 2. Integration tests for server APIs (tested in integration-tests package)
 * 3. TypeScript compilation (build validates types)
 *
 * To run VS Code extension tests locally, you would need:
 *
 * 1. Install @vscode/test-electron
 * 2. Create a test runner that downloads VS Code
 * 3. Write tests using VS Code's extension API
 * 4. Run tests in a separate test script (not via Vitest)
 *
 * Example (if you want to add later):
 *
 * import { runTests } from '@vscode/test-electron';
 *
 * async function main() {
 *   await runTests({
 *     extensionPath: path.resolve(__dirname, '..'),
 *     testExtensionPath: path.resolve(__dirname, 'suite'),
 *   });
 * }
 *
 * For now, we rely on:
 * - TypeScript compilation (type correctness)
 * - Server integration tests (API behavior)
 * - Manual testing in actual VS Code
 */

import { describe, it, expect } from "vitest";

describe("VS Code Extension (compile-time checks)", () => {
  it("should have correct package.json configuration", async () => {
    // Import package.json with type assertion
    const pkg = await import("../package.json", { assert: { type: "json" } });

    expect(pkg.name).toBe("codeforge-vscode");
    expect(pkg.main).toBe("./dist/extension.js");
    expect(pkg.engines.vscode).toBeDefined();
    expect(pkg.contributes).toBeDefined();
    expect(pkg.contributes.commands).toBeDefined();
    expect(pkg.contributes.commands.length).toBeGreaterThan(0);
  });

  it("should have activation events configured", async () => {
    const pkg = await import("../package.json", { assert: { type: "json" } });
    expect(pkg.activationEvents).toBeDefined();
    expect(Array.isArray(pkg.activationEvents)).toBe(true);
    expect(pkg.activationEvents.length).toBeGreaterThan(0);
  });

  it("should have proper build output configuration", async () => {
    const pkg = await import("../package.json", { assert: { type: "json" } });
    expect(pkg.scripts.build).toBeDefined();
    expect(pkg.scripts.build).toContain("tsc");
  });
});

/**
 * VS Code Extension Test Runner
 *
 * This file is the entry point for running extension tests using @vscode/test-electron.
 * It downloads VS Code if needed and runs the test suite inside the extension host.
 *
 * Why this is separate from vitest:
 * - VS Code extension tests must run inside a real VS Code instance
 * - The extension host process is different from Node.js test runners
 * - Tests need access to the vscode API which only exists in VS Code
 */

import * as path from "node:path";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, "../../");
  const extensionTestsPath = path.resolve(__dirname, "./suite/index");

  try {
    // Download VS Code (stable version), unzip it and run the tests
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        // Use a minimal workspace
        "--disable-workspace-trust",
        "--skip-add-to-recent",
      ],
    });
  } catch (err) {
    console.error("Failed to run tests:", err);
    process.exit(1);
  }
}

main();

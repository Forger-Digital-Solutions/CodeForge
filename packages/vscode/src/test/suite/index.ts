/**
 * Test suite entry point
 *
 * This file is loaded by VS Code's test runner and discovers all test files.
 */

import * as path from "node:path";
import Mocha from "mocha";
import { glob } from "glob";

export async function run(): Promise<void> {
  // Create the mocha test runner
  const mocha = new Mocha({
    ui: "tdd",
    color: true,
    timeout: 30000,
  });

  // Find all test files (compiled .js files)
  const testsRoot = path.resolve(__dirname, ".");
  
  // Use glob to find test files
  const files = await glob("**/*.test.js", { 
    cwd: testsRoot,
    absolute: true 
  });

  console.log(`Found ${files.length} test file(s):`, files);

  // Add files to the test suite
  for (const file of files) {
    mocha.addFile(file);
  }

  return new Promise((resolve, reject) => {
    try {
      // Run the tests
      mocha.run((failures: number) => {
        if (failures > 0) {
          reject(new Error(`${failures} tests failed.`));
        } else {
          resolve();
        }
      });
    } catch (err) {
      reject(err);
    }
  });
}

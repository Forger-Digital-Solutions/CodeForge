import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { conptySupported } from "../src/pty-loader.js";

const run = promisify(execFile);

describe.skipIf(!conptySupported())("ConPTY resource teardown", () => {
  it("stops the real reader worker before disconnecting its output socket", async () => {
    const { stdout } = await run(process.execPath,
      [fileURLToPath(new URL("./fixtures/conpty-reader-close.mjs", import.meta.url))],
      { windowsHide: true, timeout: 15_000 });
    expect(stdout).toContain("CONPTY_READER_CLOSE_PASS");
  }, 20_000);

  it("preserves output and exit status while releasing concurrent native commands", async () => {
    const { stdout } = await run(process.execPath,
      [fileURLToPath(new URL("./fixtures/conpty-close-worker.mjs", import.meta.url))],
      { windowsHide: true, timeout: 30_000 });
    expect(stdout).toContain("CONPTY_CLOSE_STRESS_PASS");
  }, 35_000);
});

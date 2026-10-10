import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { execFile as callback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(callback);
describe("R74 narrow install patch", () => {
  it("preserves the prior executable fix, is idempotent, and rejects an unrecognized upstream implementation", async () => {
    const { stdout } = await execFile(process.execPath, ["--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import {patchBuilderUtilSource} from './scripts/patch-builder-util.mjs';
      const input='function doSpawn() {\\n    try {\\n        return (0, cross_spawn_1.spawn)(command, args, options);\\n    }\\n}';
      const patched=patchBuilderUtilSource(input);
      assert(patched.includes('process.platform === "win32"'));
      assert(patched.includes('command.endsWith(".exe")'));
      assert(patched.includes('command.endsWith(".EXE")'));
      assert(patched.includes('child_process_1.spawn'));
      assert.equal(patchBuilderUtilSource(patched),patched);
      assert.throws(()=>patchBuilderUtilSource('different upstream source'),/Unrecognized/);
      assert.throws(()=>patchBuilderUtilSource(input+input),/Unrecognized/);
      console.log('PASS');
    `], { windowsHide: true });
    expect(stdout.trim()).toBe("PASS");
    const original = await readFile("patches/builder-util+26.15.3.patch", "utf8");
    expect(original).toContain('command.endsWith(".exe")');
  });
});

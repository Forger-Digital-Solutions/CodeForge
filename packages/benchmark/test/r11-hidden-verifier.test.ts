import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("R11 external hidden verifier", () => {
  it("rejects a tautological empty-response test and accepts the real three-way behavior", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codeforge-r11-hidden-verifier-"));
    roots.push(root);
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.mkdir(path.join(root, "test"), { recursive: true });
    await fs.writeFile(
      path.join(root, "src", "parser.mjs"),
      "export function parseResponse(value) { if (typeof value !== 'string') return { kind: 'malformed', value }; return { kind: 'valid', value }; }\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(root, "test", "parser.test.mjs"),
      "import test from 'node:test'; test('valid',()=>{}); test('empty',()=>{}); test('malformed',()=>{});\n",
      "utf8",
    );
    const verifier = path.resolve("scripts/r11-codeforge-bench-r2-hidden-verifier.mjs");

    await expect(run(process.execPath, [verifier, root, "tests"])).rejects.toMatchObject({ code: 1 });

    await fs.writeFile(
      path.join(root, "src", "parser.mjs"),
      "export function parseResponse(value) { if (typeof value !== 'string') return { kind: 'malformed', value }; if (value.length === 0) return { kind: 'empty' }; return { kind: 'valid', value }; }\n",
      "utf8",
    );
    const result = await run(process.execPath, [verifier, root, "tests"]);
    expect(JSON.parse(result.stdout)).toEqual({ passed: true, findings: [] });
  });
});

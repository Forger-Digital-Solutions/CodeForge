import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareShellCommand } from "../src/child-process.js";
import { adaptTrustedLegacyVerifiers } from "../src/forge-verify.js";
import { runVerification } from "../src/verification-service.js";

/**
 * R23 finding F-2: before this change every non-Node verifier command "required a shell" and could
 * not enter ForgeVerify, so an autonomous run on a Python repository failed outright. Python
 * interpreters now resolve to an absolute executable and spawn without a shell — the same posture
 * npm already had. Shell metacharacters still fall back to the shell-required form, which the
 * trusted adapter continues to refuse.
 */

const fakeEnv = (dir: string): NodeJS.ProcessEnv => ({ PATH: dir, Path: dir, PATHEXT: ".EXE;.CMD;.BAT" });

function fakeInterpreterDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r23-py-"));
  fs.writeFileSync(path.join(dir, process.platform === "win32" ? "python.exe" : "python"), "");
  fs.writeFileSync(path.join(dir, process.platform === "win32" ? "pytest.exe" : "pytest"), "");
  return dir;
}

describe("R23 — Python verifiers enter ForgeVerify without a shell", () => {
  it("resolves `python -m py_compile` to an absolute interpreter and direct arguments", () => {
    const dir = fakeInterpreterDir();
    const prepared = prepareShellCommand("python -m py_compile stats/core.py", fakeEnv(dir), "/ws");
    expect(prepared.shell).toBe(false);
    expect(prepared.runtimeKind).toBe("python");
    expect(path.dirname(prepared.command)).toBe(dir);
    // Interpreter options keep compiler byproducts out of the verified tree (see child-process.ts).
    expect(prepared.args.slice(0, 2)).toEqual(["-B", "-X"]);
    expect(prepared.args[2]).toMatch(/^pycache_prefix=/);
    expect(prepared.args.slice(3)).toEqual(["-m", "py_compile", "stats/core.py"]);
  });

  it("resolves pytest the same way and keeps quoted arguments intact", () => {
    const dir = fakeInterpreterDir();
    const prepared = prepareShellCommand('pytest -q "tests/unit tests"', fakeEnv(dir), "/ws");
    expect(prepared.shell).toBe(false);
    expect(prepared.runtimeKind).toBe("python");
    expect(prepared.args).toEqual(["-p", "no:cacheprovider", "-q", "tests/unit tests"]);
  });

  it("still requires a shell for metacharacters and for interpreters that cannot be resolved", () => {
    const dir = fakeInterpreterDir();
    expect(prepareShellCommand("python -c 'x' && rm -rf /", fakeEnv(dir), "/ws").shell).toBe(true);
    expect(prepareShellCommand("python -m pytest | tee out.txt", fakeEnv(dir), "/ws").shell).toBe(true);
    // Unresolvable interpreter (empty PATH) → unchanged fail-closed behaviour.
    expect(prepareShellCommand("python -m py_compile a.py", { PATH: "" }, "/ws").shell).toBe(true);
    // Other toolchains are untouched.
    expect(prepareShellCommand("cargo test", fakeEnv(dir), "/ws").shell).toBe(true);
    expect(prepareShellCommand("node --check a.js", fakeEnv(dir), "/ws").shell).toBe(false);
  });

  it("the trusted legacy-verifier adapter accepts a resolvable python command", () => {
    const dir = fakeInterpreterDir();
    const previous = { PATH: process.env.PATH, Path: process.env.Path, PATHEXT: process.env.PATHEXT };
    Object.assign(process.env, fakeEnv(dir));
    try {
      const definitions = adaptTrustedLegacyVerifiers("/ws", [{ id: "verifier-1-custom", command: "python -m py_compile stats/core.py", kind: "custom", required: true } as never]);
      expect(definitions).toHaveLength(1);
      expect(() => adaptTrustedLegacyVerifiers("/ws", [{ id: "verifier-2-custom", command: "cargo test", kind: "custom", required: true } as never])).toThrow(/requires a shell/);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  const pythonAvailable = (() => {
    try {
      return prepareShellCommand("python --version", process.env, process.cwd()).shell === false;
    } catch {
      return false;
    }
  })();

  it.skipIf(!pythonAvailable)("runs a real python verifier end-to-end through ForgeVerify", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "r23-py-ws-"));
    fs.writeFileSync(path.join(workspace, "ok.py"), "x = 1\n");
    fs.writeFileSync(path.join(workspace, "bad.py"), "def broken(:\n");
    const passing = await runVerification(workspace, ["python -m py_compile ok.py"], { timeoutMs: 60_000 });
    expect(passing.overallStatus).toBe("passed");
    expect(passing.verifiers[0]?.exitCode).toBe(0);
    // The verifier left no bytecode byproduct in the tree, so ForgeVerify's input-state hash held.
    expect(fs.existsSync(path.join(workspace, "__pycache__"))).toBe(false);
    expect(passing.forgeVerify?.summary.staleCount ?? 0).toBe(0);
    const failing = await runVerification(workspace, ["python -m py_compile bad.py"], { timeoutMs: 60_000 });
    expect(failing.overallStatus).toBe("failed");
    expect(failing.verifiers[0]?.exitCode).not.toBe(0);
  }, 90_000);
});

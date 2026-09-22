import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { stripAnsi, stripCommandEcho } from "../src/ansi.js";
import { defaultShell, commandShell } from "../src/shells.js";
import { execute, executePrepared, backendFor, __setPtyModuleForTest } from "../src/index.js";

const isWin = process.platform === "win32";

describe("stripAnsi", () => {
  it("removes SGR color sequences and normalizes CRLF", () => {
    expect(stripAnsi("\x1b[32mok\x1b[0m\r\nnext")).toBe("ok\nnext");
  });

  it("removes cursor controls and OSC title sequences", () => {
    expect(stripAnsi("\x1b[2J\x1b[H\x1b[0;36mtext\x1b[0m")).toBe("text");
    expect(stripAnsi("\x1b]0;my title\x07real")).toBe("real");
  });

  it("renders ConPTY cursor-forward sequences back as the whitespace they replaced", () => {
    // ConPTY emits `CSI n C` for tabs and space runs; column-aligned runner output must survive.
    expect(stripAnsi("ok\x1b[3Cexample.com/a\x1b[1C0.012s")).toBe("ok   example.com/a 0.012s");
    expect(stripAnsi("?\x1b[C[no test files]")).toBe("? [no test files]");
    expect(stripAnsi("a\x1b[0Cb")).toBe("a b");
  });

  it("preserves plain text untouched", () => {
    expect(stripAnsi("plain output 123")).toBe("plain output 123");
  });
});

describe("stripCommandEcho", () => {
  it("drops a literal echoed first line", () => {
    expect(stripCommandEcho("npm test\nreal output", "npm test")).toBe("real output");
  });

  it("drops prompt-prefixed echoes", () => {
    expect(stripCommandEcho("C:\\proj> npm test\nout", "npm test")).toBe("out");
  });

  it("keeps output when the first line is real output", () => {
    expect(stripCommandEcho("all tests pass", "npm test")).toBe("all tests pass");
  });
});

describe("defaultShell", () => {
  it("returns $SHELL on POSIX", () => {
    expect(defaultShell({ SHELL: "/bin/zsh" }, "linux")).toBe("/bin/zsh");
  });

  it("falls back to /bin/sh on POSIX without $SHELL", () => {
    expect(defaultShell({}, "linux")).toBe("/bin/sh");
  });

  it("returns a non-empty shell on Windows even with an empty PATH", () => {
    const shell = defaultShell({ PATH: "", ComSpec: "C:\\Windows\\System32\\cmd.exe" }, "win32");
    expect(shell).toBe("C:\\Windows\\System32\\cmd.exe");
  });

  it("prefers a discovered executable on Windows PATH", () => {
    // cmd.exe is guaranteed on Windows hosts; simulate a PATH containing System32.
    if (!isWin) return;
    const sysroot = process.env.SystemRoot ?? "C:\\Windows";
    const shell = defaultShell({ PATH: `${sysroot}\\System32`, ComSpec: `${sysroot}\\System32\\cmd.exe` }, "win32");
    expect(shell.toLowerCase()).toContain("system32");
  });
});

describe("commandShell", () => {
  it("uses ComSpec with /d /c on Windows", () => {
    const shell = commandShell({ ComSpec: "C:\\Windows\\System32\\cmd.exe" }, "win32");
    expect(shell.file).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(shell.args).toEqual(["/d", "/c"]);
  });

  it("uses $SHELL -c on POSIX", () => {
    const shell = commandShell({ SHELL: "/bin/bash" }, "linux");
    expect(shell).toEqual({ file: "/bin/bash", args: ["-c"] });
  });
});

describe("execute (pipe fallback forced)", () => {
  beforeEach(() => __setPtyModuleForTest(null));
  afterEach(() => __setPtyModuleForTest(undefined));

  it("captures stdout and returns exit code 0", async () => {
    const result = isWin
      ? await execute({ commandLine: "echo hello-term" })
      : await execute({ commandLine: "printf hello-term" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello-term");
    expect(result.backend).toBe("pipe");
    expect(result.timedOut).toBe(false);
    expect(result.cancelled).toBe(false);
  });

  it("propagates non-zero exit codes", async () => {
    const result = isWin
      ? await execute({ commandLine: "exit 3" })
      : await execute({ commandLine: "exit 3" });
    expect(result.exitCode).toBe(3);
  });

  it("runs a direct file+args spawn", async () => {
    const result = await execute({
      file: process.execPath,
      args: ["-e", "process.stdout.write('direct-spawn')"],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("direct-spawn");
  });

  it("streams chunks through onOutput", async () => {
    const chunks: string[] = [];
    await execute({
      file: process.execPath,
      args: ["-e", "process.stdout.write('a');process.stderr.write('b')"],
      onOutput: (chunk) => chunks.push(chunk),
    });
    expect(chunks.join("")).toContain("a");
    expect(chunks.join("")).toContain("b");
  });

  it("times out with exit code 124 and kills the tree", async () => {
    const result = await execute({
      file: process.execPath,
      args: ["-e", "setTimeout(()=>{},30000)"],
      timeoutMs: 300,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
  });

  it("aborts with exit code 130", async () => {
    const controller = new AbortController();
    const pending = execute({
      file: process.execPath,
      args: ["-e", "setTimeout(()=>{},30000)"],
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    const result = await pending;
    expect(result.cancelled).toBe(true);
    expect(result.exitCode).toBe(130);
  });

  it("reports spawnError for a missing executable", async () => {
    const result = await execute({ file: "definitely-not-a-real-binary-xyz-123" });
    expect(result.spawnError).toBeTruthy();
    expect(result.exitCode).toBe(1);
  });

  it("requires commandLine or file", async () => {
    const result = await execute({});
    expect(result.spawnError).toContain("commandLine or file");
  });
});

describe("executePrepared", () => {
  beforeEach(() => __setPtyModuleForTest(null));
  afterEach(() => __setPtyModuleForTest(undefined));

  it("maps shell prepared specs to commandLine", async () => {
    const result = await executePrepared(
      { command: "echo prepared-ok", args: [], env: { ...process.env }, shell: true },
      {},
    );
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("prepared-ok");
  });

  it("maps direct prepared specs to file+args", async () => {
    const result = await executePrepared(
      { command: process.execPath, args: ["-e", "process.stdout.write('prepared-direct')"], env: { ...process.env }, shell: false },
      {},
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("prepared-direct");
  });
});

describe("backendFor", () => {
  afterEach(() => __setPtyModuleForTest(undefined));

  it("is pipe when node-pty is unavailable", () => {
    __setPtyModuleForTest(null);
    expect(backendFor()).toBe("pipe");
  });

  it("is always pipe on POSIX", () => {
    expect(backendFor("linux")).toBe("pipe");
  });
});

describe("R27 Windows timeout process-tree cleanup and workspace removability", () => {
  const cleanupDirs: string[] = [];
  afterEach(() => {
    __setPtyModuleForTest(undefined);
    for (const dir of cleanupDirs.splice(0)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort in afterEach */
      }
    }
  });

  it("timeout → process tree terminated → close observed or bounded fallback → workspace removable (pipe)", async () => {
    __setPtyModuleForTest(null);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r27-term-timeout-"));
    cleanupDirs.push(dir);
    const scriptPath = path.join(dir, "worker.cjs");
    const lockfilePath = path.join(dir, "lock.txt");
    fs.writeFileSync(
      scriptPath,
      `const fs = require('node:fs');
const fd = fs.openSync(${JSON.stringify(lockfilePath)}, 'w');
setTimeout(() => { try { fs.closeSync(fd); } catch {} }, 30000);
`,
    );

    const result = await execute({
      file: process.execPath,
      args: [scriptPath],
      cwd: dir,
      timeoutMs: 250,
    });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);

    // Workspace must be removable immediately without EPERM because all handles in the tree are closed
    let epermOccurred = false;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err: unknown) {
      if ((err as { code?: string })?.code === "EPERM") {
        epermOccurred = true;
      }
      throw err;
    }
    expect(epermOccurred).toBe(false);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("10 consecutive timeout executions: 0 EPERM, 0 leaked child processes, 0 double settlements", async () => {
    __setPtyModuleForTest(null);
    let epermCount = 0;
    let timeoutCount = 0;
    let validExitCodes = 0;

    for (let i = 0; i < 10; i++) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `r27-repeat-timeout-${i}-`));
      cleanupDirs.push(dir);
      const scriptPath = path.join(dir, "hang.cjs");
      const dataPath = path.join(dir, "active.log");
      fs.writeFileSync(
        scriptPath,
        `const fs = require('node:fs');
const fd = fs.openSync(${JSON.stringify(dataPath)}, 'a');
fs.writeSync(fd, 'started\\n');
setTimeout(() => { try { fs.closeSync(fd); } catch {} }, 30000);
`,
      );

      const result = await execute({
        file: process.execPath,
        args: [scriptPath],
        cwd: dir,
        timeoutMs: 150,
      });

      if (result.timedOut) timeoutCount++;
      if (result.exitCode === 124) validExitCodes++;

      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (err: unknown) {
        if ((err as { code?: string })?.code === "EPERM") {
          epermCount++;
        }
      }
      expect(fs.existsSync(dir)).toBe(false);
    }

    expect(timeoutCount).toBe(10);
    expect(validExitCodes).toBe(10);
    expect(epermCount).toBe(0);
  }, 45_000);

  it("cancellation with abort signal does not race with timeout timer", async () => {
    __setPtyModuleForTest(null);
    const controller = new AbortController();
    const pending = execute({
      file: process.execPath,
      args: ["-e", "setTimeout(()=>{}, 30000)"],
      timeoutMs: 2000,
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 100);
    const result = await pending;

    expect(result.cancelled).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(130);
  });

  it("already-aborted signal cancels immediately without spawning child", async () => {
    __setPtyModuleForTest(null);
    const controller = new AbortController();
    controller.abort();

    const result = await execute({
      file: process.execPath,
      args: ["-e", "setTimeout(()=>{}, 30000)"],
      timeoutMs: 5000,
      signal: controller.signal,
    });

    expect(result.cancelled).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(130);
  });
});

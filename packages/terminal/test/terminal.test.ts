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

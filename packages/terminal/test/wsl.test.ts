import { describe, it, expect, beforeEach } from "vitest";
import {
  detectWsl,
  defaultWslDistro,
  windowsPathToWsl,
  wslPathToWindows,
  execInWsl,
  __resetWslCacheForTest,
} from "../src/wsl.js";

const utf16 = (s: string) => Buffer.from(s, "utf16le");
const LIST_VERBOSE = "  NAME            STATE      VERSION\r\n* Ubuntu          Stopped    2\r\n  Debian          Running    2\r\n";

const okProbe = (stdout: Buffer) => () => ({ status: 0, stdout, stderr: Buffer.alloc(0) });

beforeEach(() => __resetWslCacheForTest());

describe("windowsPathToWsl", () => {
  it("maps drive paths to /mnt/<drive>", () => {
    expect(windowsPathToWsl("C:\\Users\\dev\\proj")).toBe("/mnt/c/Users/dev/proj");
    expect(windowsPathToWsl("D:/work/dir")).toBe("/mnt/d/work/dir");
    expect(windowsPathToWsl("E:\\")).toBe("/mnt/e");
  });

  it("rejects paths outside the local-drive model", () => {
    expect(windowsPathToWsl("\\\\server\\share\\dir")).toBeNull();
    expect(windowsPathToWsl("/home/user/proj")).toBeNull();
    expect(windowsPathToWsl("relative\\dir")).toBeNull();
  });
});

describe("wslPathToWindows", () => {
  it("maps /mnt/<drive> back to a drive path", () => {
    expect(wslPathToWindows("/mnt/c/Users/dev", "Ubuntu")).toBe("C:\\Users\\dev");
    expect(wslPathToWindows("/mnt/d", "Ubuntu")).toBe("D:");
  });

  it("keeps Linux-native paths honest via the wsl.localhost namespace", () => {
    expect(wslPathToWindows("/home/dev/proj", "Ubuntu")).toBe("\\\\wsl.localhost\\Ubuntu\\home\\dev\\proj");
  });

  it("rejects non-absolute input", () => {
    expect(wslPathToWindows("home/dev", "Ubuntu")).toBeNull();
  });
});

describe("detectWsl", () => {
  it("reports not_windows off Windows without probing", () => {
    const probe = () => { throw new Error("must not be called"); };
    const d = detectWsl(probe as never, "linux");
    expect(d.available).toBe(false);
    expect(d.reason).toBe("not_windows");
  });

  it("parses UTF-16LE distro listings with default marker", () => {
    const d = detectWsl(okProbe(utf16(LIST_VERBOSE)) as never, "win32");
    expect(d.available).toBe(true);
    expect(d.distros).toHaveLength(2);
    expect(d.distros[0]).toMatchObject({ name: "Ubuntu", isDefault: true, state: "Stopped", version: 2 });
    expect(defaultWslDistro(d)).toBe("Ubuntu");
  });

  it("parses UTF-8 output as well", () => {
    const d = detectWsl(okProbe(Buffer.from(LIST_VERBOSE, "utf8")) as never, "win32");
    expect(d.available).toBe(true);
    expect(d.distros.map((x) => x.name)).toEqual(["Ubuntu", "Debian"]);
  });

  it("fails closed on spawn error, nonzero exit, and empty listing", () => {
    const enoent = Object.assign(new Error("spawn wsl.exe ENOENT"), { code: "ENOENT" });
    expect(detectWsl((() => ({ status: null, error: enoent })) as never, "win32").reason).toBe("wsl_exe_missing");
    expect(detectWsl((() => ({ status: 1, stderr: utf16("E_ACCESSDENIED") })) as never, "win32").reason).toBe("query_failed");
    expect(detectWsl(okProbe(utf16("")) as never, "win32").reason).toBe("no_distros");
  });
});

describe("execInWsl", () => {
  it("fails closed with WSL_UNAVAILABLE on non-Windows hosts", async () => {
    if (process.platform === "win32") return;
    const r = await execInWsl("echo hi");
    expect(r.environment).toBe("wsl");
    expect(r.spawnError).toContain("WSL_UNAVAILABLE");
  });

  it("fails closed when the workspace drive is unmappable", async () => {
    if (process.platform !== "win32") return;
    const detection = detectWsl();
    if (!detection.available) return; // host without WSL: detection path covered elsewhere
    const r = await execInWsl("echo hi", { cwd: "\\\\server\\share\\dir" });
    expect(r.spawnError).toContain("WSL_PATH_UNMAPPABLE");
  });

  it("fails closed on an unknown distro name", async () => {
    if (process.platform !== "win32") return;
    const detection = detectWsl();
    if (!detection.available) return;
    const r = await execInWsl("echo hi", { distro: "cf-no-such-distro" });
    expect(r.spawnError).toContain("WSL_DISTRO_MISSING");
  });
});

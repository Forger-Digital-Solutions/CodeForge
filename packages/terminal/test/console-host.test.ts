import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  buildHostedCommandLine,
  isGuiSubsystemExecutable,
  needsConsoleHost,
  quoteForCommandHost,
  readPeSubsystem,
  __resetConsoleHostCacheForTest,
} from "../src/console-host.js";

/** A minimal PE image whose optional header declares `subsystem`. */
function writeFakePe(subsystem: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-pe-"));
  const file = path.join(dir, `image-${subsystem}.exe`);
  const peOffset = 0x80;
  const buffer = Buffer.alloc(peOffset + 4 + 20 + 96);
  buffer.write("MZ", 0, "latin1");
  buffer.writeUInt32LE(peOffset, 60);
  buffer.write("PE\0\0", peOffset, "latin1");
  buffer.writeUInt16LE(subsystem, peOffset + 4 + 20 + 68);
  fs.writeFileSync(file, buffer);
  return file;
}

describe("readPeSubsystem", () => {
  beforeEach(() => __resetConsoleHostCacheForTest());

  it("reads the subsystem from the optional header", () => {
    expect(readPeSubsystem(writeFakePe(2))).toBe(2);
    expect(readPeSubsystem(writeFakePe(3))).toBe(3);
  });

  it("returns null for a non-PE file or a missing file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-pe-"));
    const text = path.join(dir, "not-an-exe.txt");
    fs.writeFileSync(text, "hello");
    expect(readPeSubsystem(text)).toBeNull();
    expect(readPeSubsystem(path.join(dir, "missing.exe"))).toBeNull();
  });

  it("recognises GUI images and only hosts them on Windows", () => {
    const gui = writeFakePe(2);
    const cui = writeFakePe(3);
    expect(isGuiSubsystemExecutable(gui)).toBe(true);
    expect(isGuiSubsystemExecutable(cui)).toBe(false);
    expect(needsConsoleHost(gui, "win32")).toBe(true);
    expect(needsConsoleHost(cui, "win32")).toBe(false);
    expect(needsConsoleHost(gui, "linux")).toBe(false);
  });

  it("classifies the running Node binary as a console image on Windows", () => {
    if (process.platform !== "win32") return;
    expect(readPeSubsystem(process.execPath)).toBe(3);
    expect(needsConsoleHost(process.execPath)).toBe(false);
  });
});

describe("quoteForCommandHost", () => {
  it("leaves plain tokens untouched and quotes whitespace", () => {
    expect(quoteForCommandHost("test")).toBe("test");
    expect(quoteForCommandHost("C:\\Program Files\\nodejs\\npm-cli.js")).toBe('"C:\\Program Files\\nodejs\\npm-cli.js"');
    expect(quoteForCommandHost("")).toBe('""');
  });

  it("escapes embedded quotes and trailing backslashes the way CommandLineToArgvW expects", () => {
    expect(quoteForCommandHost('say "hi"')).toBe('"say \\"hi\\""');
    expect(quoteForCommandHost("C:\\dir\\")).toBe("C:\\dir\\");
    expect(quoteForCommandHost("C:\\my dir\\")).toBe('"C:\\my dir\\\\"');
  });

  it("neutralises cmd metacharacters by quoting", () => {
    expect(quoteForCommandHost("a&b")).toBe('"a&b"');
    expect(quoteForCommandHost("x|y")).toBe('"x|y"');
  });
});

describe("buildHostedCommandLine", () => {
  it("quotes the executable and every argument that needs it", () => {
    const line = buildHostedCommandLine("C:\\Users\\me\\AppData\\Local\\Programs\\CodeForge\\CodeForge.exe", ["C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js", "test"]);
    expect(line).toBe('C:\\Users\\me\\AppData\\Local\\Programs\\CodeForge\\CodeForge.exe "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js" test');
  });

  it("escapes delayed-expansion characters only when the line contains an exclamation mark", () => {
    expect(buildHostedCommandLine("node.exe", ["-e", "console.log('a^b')"])).toBe('node.exe -e "console.log(\'a^b\')"');
    expect(buildHostedCommandLine("node.exe", ["-e", "console.log('hi!')"])).toBe('node.exe -e "console.log(\'hi^!\')"');
    expect(buildHostedCommandLine("node.exe", ["-e", "x^!"])).toBe('node.exe -e "x^^^!"');
  });
});

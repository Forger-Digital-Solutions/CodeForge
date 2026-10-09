import { describe, expect, it } from "vitest";
import { describeExecutionEnvironment } from "../src/execution-environment.js";

describe("model command environment", () => {
  it("describes cmd execution even when a Windows environment advertises a Unix shell", () => {
    const prompt = describeExecutionEnvironment("win32", { SHELL: "/bin/bash" });
    expect(prompt).toContain("cmd.exe /d /c");
    expect(prompt).toContain("PowerShell syntax and Unix utilities");
    expect(prompt).toContain("run_command.cwd");
    expect(prompt).toContain("Semicolons are not command separators");
    expect(prompt).toContain("already returns its exit code");
    expect(prompt).toContain("explicitly selected, available WSL");
  });

  it("describes the configured POSIX shell without claiming a Windows default", () => {
    const prompt = describeExecutionEnvironment("linux", { SHELL: "/bin/bash" });
    expect(prompt).toContain("host command shell /bin/bash -c");
    expect(prompt).not.toContain("cmd.exe");
  });
  it("names the assigned workspace and makes the default command cwd explicit", () => {
    const prompt = describeExecutionEnvironment("win32", {}, "G:\\isolated\\coder");
    expect(prompt).toContain(JSON.stringify("G:\\isolated\\coder"));
    expect(prompt).toContain("Omit run_command.cwd or use '.'");
    expect(prompt).toContain("do not invent another workspace path");
  });
});

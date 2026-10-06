import { describe, expect, it } from "vitest";
import { describeExecutionEnvironment } from "../src/execution-environment.js";

describe("model command environment", () => {
  it("describes cmd execution even when a Windows environment advertises a Unix shell", () => {
    const prompt = describeExecutionEnvironment("win32", { SHELL: "/bin/bash" });
    expect(prompt).toContain("cmd.exe /d /c");
    expect(prompt).toContain("PowerShell syntax and Unix utilities");
    expect(prompt).toContain("run_command.cwd");
    expect(prompt).toContain("explicitly selected, available WSL");
  });

  it("describes the configured POSIX shell without claiming a Windows default", () => {
    const prompt = describeExecutionEnvironment("linux", { SHELL: "/bin/bash" });
    expect(prompt).toContain("host command shell /bin/bash -c");
    expect(prompt).not.toContain("cmd.exe");
  });
});

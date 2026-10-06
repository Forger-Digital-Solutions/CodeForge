import { commandShell } from "@codeforge/terminal";

export function describeExecutionEnvironment(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  const shell = commandShell(env, platform);
  const instructions = platform === "win32"
    ? "Native Windows commands run through cmd.exe /d /c. Semicolons are not command separators and $? is not an exit-code variable. PowerShell syntax and Unix utilities such as grep, head, tail, cat, test and ls are unavailable unless explicitly selected and verified. Run one command per tool call: run_command already returns its exit code and captures stdout/stderr, so do not append echo or redirect to /tmp to inspect results. Use read_file, list_files and search for file inspection, and use run_command.cwd instead of a shell cd chain. WSL requires an explicitly selected, available WSL environment."
    : "Use syntax supported by this host shell and verify tool availability before relying on additional utilities. Use file tools for inspection and run_command.cwd for the working directory.";
  return `Execution environment: ${platform}; host command shell ${shell.file} ${shell.args.join(" ")}. ${instructions}`;
}

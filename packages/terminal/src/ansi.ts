/**
 * PTY streams are real terminal output: SGR colors, cursor controls, bracketed-paste markers,
 * the shell's own prompt decoration and the command echo. Headless callers need the text.
 */

// CSI sequences (colors, cursor movement, erase) + OSC (title changes) + a few single-char
// controls. Intentionally conservative: anything not matched is preserved as text.
const CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const SINGLE = /\x1b[@-Z\\-_]/g;

export function stripAnsi(text: string): string {
  return text
    .replace(OSC, "")
    .replace(CSI, "")
    .replace(SINGLE, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

/**
 * Removes the shell's command echo and prompt artifacts around a captured PTY run.
 * cmd.exe echoes the command line itself; the first line of captured output is typically
 * the echoed command — drop it when it literally matches.
 */
export function stripCommandEcho(output: string, command: string): string {
  const lines = output.split("\n");
  if (lines.length === 0) return output;
  const first = lines[0]!.trim();
  const wanted = command.trim();
  if (first === wanted || first === `> ${wanted}` || first.endsWith(`> ${wanted}`)) {
    return lines.slice(1).join("\n");
  }
  return output;
}

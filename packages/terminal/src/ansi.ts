/**
 * PTY streams are real terminal output: SGR colors, cursor controls, bracketed-paste markers,
 * the shell's own prompt decoration and the command echo. Headless callers need the text.
 */

// CSI sequences (colors, cursor movement, erase) + OSC (title changes) + a few single-char
// controls. Intentionally conservative: anything not matched is preserved as text.
/* eslint-disable no-control-regex -- escape sequences ARE control characters; matching them is the point */
const CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const SINGLE = /\x1b[@-Z\\-_]/g;
// ConPTY renders tabs and runs of spaces as "cursor forward n" (CSI n C) instead of emitting the
// whitespace itself. Dropping those sequences glues adjacent columns together (`ok\texample.com`
// becomes `okexample.com`), which breaks any consumer that parses column-aligned runner output.
// Horizontal cursor movement is therefore rendered back as the whitespace it stood for.
const CURSOR_FORWARD = /\x1b\[(\d*)C/g;
// Likewise ConPTY moves to the next line with absolute/relative vertical positioning (CUP `H`/`f`,
// VPA `d`, CNL `E`, CUD `B`) instead of emitting a newline. Erasing those glues the previous line
// to the next (`> node test.js` + `Tests: 2 failed` became one line); they are rendered as breaks.
const CURSOR_NEWLINE = /\x1b\[(?:\d+(?:;\d*)?[Hf]|\d*[dEB])/g;
/* eslint-enable no-control-regex */

export function stripAnsi(text: string): string {
  return text
    .replace(OSC, "")
    .replace(CURSOR_FORWARD, (_match, count: string) => " ".repeat(Math.min(Math.max(Number.parseInt(count || "1", 10) || 1, 1), 512)))
    .replace(CURSOR_NEWLINE, "\n")
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

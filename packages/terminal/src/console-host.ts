import fs from "node:fs";

/**
 * Why a direct spawn is sometimes hosted by `cmd.exe` inside the pseudo console.
 *
 * ConPTY makes a command tree invisible because every console-subsystem process inherits the
 * pseudo console of its parent. A GUI-subsystem executable breaks that chain: Windows attaches no
 * console to it at all, so the first console child IT spawns is given a brand-new — visible —
 * console (a Windows Terminal window on Windows 11). The packaged desktop app hits exactly this:
 * `npm test` is executed as `CodeForge.exe npm-cli.js test` (Electron as Node, a GUI image), and
 * npm's script shell (cmd.exe or the user's configured bash.exe) then flashed a terminal over the
 * app. Measured on the installed build: 1 Windows Terminal window per npm command, and no output
 * captured either.
 *
 * Hosting the GUI image under the pty's own `cmd.exe` restores the chain: Electron attaches to its
 * parent's console (Chromium's RouteStdioToConsole), which is the pseudo console, and every child
 * below it inherits that. Console-subsystem images (node.exe, git.exe) never need the host.
 */

const IMAGE_SUBSYSTEM_WINDOWS_GUI = 2;
const subsystemCache = new Map<string, number | null>();

/** The PE optional-header subsystem of an executable, or null when it cannot be read. */
export function readPeSubsystem(executablePath: string): number | null {
  const cached = subsystemCache.get(executablePath);
  if (cached !== undefined) return cached;
  let result: number | null = null;
  let fd: number | null = null;
  try {
    fd = fs.openSync(executablePath, "r");
    const dosHeader = Buffer.alloc(64);
    if (fs.readSync(fd, dosHeader, 0, 64, 0) === 64 && dosHeader.toString("latin1", 0, 2) === "MZ") {
      const peOffset = dosHeader.readUInt32LE(60);
      // PE signature (4) + COFF header (20) + optional header: Magic (2) ... Subsystem at +68.
      const header = Buffer.alloc(4 + 20 + 70);
      const read = fs.readSync(fd, header, 0, header.length, peOffset);
      if (read === header.length && header.toString("latin1", 0, 4) === "PE\0\0") {
        result = header.readUInt16LE(4 + 20 + 68);
      }
    }
  } catch {
    result = null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* nothing to release */ }
    }
  }
  subsystemCache.set(executablePath, result);
  return result;
}

/** True when `executablePath` is a Windows GUI-subsystem image (e.g. the Electron runtime). */
export function isGuiSubsystemExecutable(executablePath: string): boolean {
  return readPeSubsystem(executablePath) === IMAGE_SUBSYSTEM_WINDOWS_GUI;
}

/**
 * Whether a direct `file` spawn must be hosted by the pseudo console's command shell.
 * Only GUI images need it; anything unreadable is left alone (a missing file will fail to spawn
 * with its own honest error either way).
 */
export function needsConsoleHost(executablePath: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "win32") return false;
  return isGuiSubsystemExecutable(executablePath);
}

/**
 * Quote one argument for a `cmd.exe /c` command line whose target parses arguments with the
 * CommandLineToArgvW rules (Node, Electron, every MSVC runtime). Double quotes inside an argument
 * are backslash-escaped; cmd's own metacharacters are neutralised by the surrounding quotes.
 */
export function quoteForCommandHost(value: string): string {
  if (value.length === 0) return '""';
  if (!/[\s"&|<>^()%!]/.test(value)) return value;
  const escaped = value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1");
  return `"${escaped}"`;
}

/**
 * The `cmd.exe /d /v:on /c` command line that runs `file` with `args`.
 *
 * The pty host enables delayed expansion for its exit-code sentinel, and cmd applies delayed
 * expansion to a command token only when that token contains `!`. In that case `^` becomes an
 * escape character for the token, so both `!` and `^` are escaped; a token without `!` is left
 * untouched, where doubling `^` would leak into the argument.
 */
export function buildHostedCommandLine(file: string, args: string[]): string {
  const line = [file, ...args].map(quoteForCommandHost).join(" ");
  return line.includes("!") ? line.replace(/\^/g, "^^").replace(/!/g, "^!") : line;
}

/** Test hook. */
export function __resetConsoleHostCacheForTest(): void {
  subsystemCache.clear();
}

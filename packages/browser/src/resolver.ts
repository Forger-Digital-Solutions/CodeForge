import fs from "node:fs";
import path from "node:path";

/**
 * Locates installed Chromium-family executables. CodeForge never auto-downloads a browser:
 * Windows machines ship Edge, and Chrome/Chromium are found through standard install paths or an
 * explicit override. Resolution returns an ordered candidate chain — verified executable paths
 * first, then playwright `channel` selectors (resolved by the driver through vendor registry
 * entries). The runtime tries each in order until one launches.
 */

export interface BrowserExecutableCandidate {
  kind: "channel" | "executable";
  channel?: "msedge" | "chrome" | "chromium";
  executablePath?: string;
  /** Human-readable provenance for diagnostics/receipts. */
  source: string;
}

const CHANNEL_CANDIDATES: ReadonlyArray<BrowserExecutableCandidate> = [
  { kind: "channel", channel: "msedge", source: "installed Microsoft Edge (channel)" },
  { kind: "channel", channel: "chrome", source: "installed Google Chrome (channel)" },
  { kind: "channel", channel: "chromium", source: "installed Chromium (channel)" },
];

function windowsExecutableCandidates(): string[] {
  const roots = [
    process.env["PROGRAMFILES(X86)"],
    process.env.PROGRAMFILES,
    process.env.LOCALAPPDATA,
  ].filter((v): v is string => Boolean(v));
  const candidates: string[] = [];
  for (const root of roots) {
    candidates.push(
      path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(root, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(root, "Chromium", "Application", "chrome.exe"),
    );
  }
  return candidates;
}

function posixExecutableCandidates(): string[] {
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
    "/usr/bin/microsoft-edge-stable",
    "/snap/bin/chromium",
  ];
}

export function resolveBrowserCandidates(env: NodeJS.ProcessEnv = process.env): BrowserExecutableCandidate[] {
  const override = env.CODEFORGE_BROWSER_EXECUTABLE;
  if (override) {
    if (!fs.existsSync(override)) {
      throw new Error(`CODEFORGE_BROWSER_EXECUTABLE does not exist: ${override}`);
    }
    return [{ kind: "executable", executablePath: override, source: "CODEFORGE_BROWSER_EXECUTABLE" }];
  }
  const explicitChannel = env.CODEFORGE_BROWSER_CHANNEL;
  if (explicitChannel === "msedge" || explicitChannel === "chrome" || explicitChannel === "chromium") {
    return [{ kind: "channel", channel: explicitChannel, source: "CODEFORGE_BROWSER_CHANNEL" }];
  }
  const paths = process.platform === "win32" ? windowsExecutableCandidates() : posixExecutableCandidates();
  const verified = paths.filter((candidate) => fs.existsSync(candidate));
  return [
    ...verified.map((executablePath): BrowserExecutableCandidate => ({ kind: "executable", executablePath, source: executablePath })),
    ...CHANNEL_CANDIDATES,
  ];
}

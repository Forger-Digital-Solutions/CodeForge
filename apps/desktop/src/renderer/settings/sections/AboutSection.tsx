import React from "react";
import { RENDERER_BUILD_IDENTITY_JSON } from "virtual:codeforge-build-identity";
import { useSettings } from "../settings-context.js";
import { SettingsGroup, SettingsRow, SettingsButton, StatusBadge } from "../settings-controls.js";

const REPO_URL = "https://github.com/Forger-Digital-Solutions/CodeForge";
const DOCS_URL = "https://github.com/Forger-Digital-Solutions/CodeForge#readme";
const SECURITY_URL = "https://github.com/Forger-Digital-Solutions/CodeForge/blob/master/SECURITY.md";
const DATA_FLOW_URL = "https://github.com/Forger-Digital-Solutions/CodeForge/blob/master/docs/security/data-flow.md";

function rendererBuildStamp(): { commit: string; shortCommit: string; builtAt: string; dirty: boolean } | null {
  try {
    const parsed = JSON.parse(RENDERER_BUILD_IDENTITY_JSON) as { commit?: unknown; shortCommit?: unknown; builtAt?: unknown; dirty?: unknown };
    return typeof parsed.commit === "string" && typeof parsed.builtAt === "string"
      ? { commit: parsed.commit, shortCommit: String(parsed.shortCommit ?? parsed.commit.slice(0, 12)), builtAt: parsed.builtAt, dirty: parsed.dirty === true }
      : null;
  } catch {
    return null;
  }
}

/**
 * The installed binary's exact source. The renderer bundle carries its own stamp; when it differs
 * from the main process's, the two halves of the app came from different builds — say so rather
 * than showing one of them as if it were the truth.
 */
export function describeBuild(build: { commit: string; shortCommit: string; builtAt: string; dirty: boolean } | null | undefined): string {
  if (!build) return "Not stamped (development build)";
  const rendererStamp = rendererBuildStamp();
  const built = Number.isNaN(Date.parse(build.builtAt)) ? build.builtAt : new Date(build.builtAt).toLocaleString();
  const base = `${build.shortCommit}${build.dirty ? " (built from modified sources)" : ""} · built ${built}`;
  if (rendererStamp && rendererStamp.commit !== build.commit) return `${base} — interface bundle is from ${rendererStamp.shortCommit}; this installation is inconsistent`;
  return base;
}

export function AboutSection(): React.ReactElement {
  const ctx = useSettings();
  const info = ctx.systemInfo;

  return (
    <div>
      <h1 className="settings-section-title">About</h1>
      <p className="settings-section-subtitle">
        CodeForge — free-first autonomous software engineering agent.
      </p>

      <SettingsGroup title="Application">
        <SettingsRow title="Version" description={info ? info.appVersion : "Unavailable"} />
        <SettingsRow title="Build channel" description={info?.buildChannel ?? "Unknown"} />
        <SettingsRow title="Build" description={describeBuild(info?.build)} />
        <SettingsRow title="Packaged build" description={info ? (info.isPackaged ? "Running from an installed package." : "Running from a development checkout.") : "Unavailable"} />
        {info ? (
          <SettingsRow
            title="Runtime"
            description={`Electron ${info.electron} · Node ${info.node} · Chromium ${info.chrome}`}
          />
        ) : null}
        {info ? <SettingsRow title="Operating system" description={`${info.platform} (${info.arch}) · release ${info.osRelease}`} /> : null}
        <SettingsRow
          title="Updates"
          description="CodeForge does not auto-update itself; new versions are installed manually from the release channel."
          control={<StatusBadge kind="info">Manual</StatusBadge>}
        />
      </SettingsGroup>

      <SettingsGroup title="Project">
        <SettingsRow
          title="Documentation"
          description="Usage guides and architecture notes live in the project repository."
          control={<SettingsButton onClick={() => ctx.openExternal(DOCS_URL)}>Open</SettingsButton>}
        />
        <SettingsRow
          title="Source repository"
          description={REPO_URL}
          control={<SettingsButton onClick={() => ctx.openExternal(REPO_URL)}>Open</SettingsButton>}
        />
        <SettingsRow
          title="Security & privacy"
          description="How credentials are stored, what leaves this computer, and how to report a vulnerability."
          control={<SettingsButton onClick={() => ctx.openExternal(SECURITY_URL)}>Security policy</SettingsButton>}
        />
        <SettingsRow
          title="Where your code goes"
          description="Prompts and selected code context go to the model provider serving the route; repositories stay on this computer unless you publish."
          control={<SettingsButton onClick={() => ctx.openExternal(DATA_FLOW_URL)}>Data flow</SettingsButton>}
        />
        <SettingsRow
          title="License"
          description="MIT is the declared license type; the operative license file is pending the project owner's authorization. Third-party notices are included with the distribution and in the source repository."
        />
      </SettingsGroup>
    </div>
  );
}

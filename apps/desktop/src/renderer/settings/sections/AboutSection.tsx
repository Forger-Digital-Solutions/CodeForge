import React from "react";
import { useSettings } from "../settings-context.js";
import { SettingsGroup, SettingsRow, SettingsButton, StatusBadge } from "../settings-controls.js";

const REPO_URL = "https://github.com/Forger-Digital-Solutions/CodeForge";
const DOCS_URL = "https://github.com/Forger-Digital-Solutions/CodeForge#readme";
const SECURITY_URL = "https://github.com/Forger-Digital-Solutions/CodeForge/blob/master/SECURITY.md";
const DATA_FLOW_URL = "https://github.com/Forger-Digital-Solutions/CodeForge/blob/master/docs/security/data-flow.md";

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

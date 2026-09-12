import React from "react";
import { useSettings } from "../settings-context.js";
import { SettingsGroup, SettingsRow, SettingsButton, StatusBadge } from "../settings-controls.js";

function describeRuntimeStatus(status: NonNullable<ReturnType<typeof useSettings>["runtimeStatus"]>): string {
  const parts: string[] = [];
  if (status.activeWorkflows) parts.push(`${status.activeWorkflows} workflow${status.activeWorkflows === 1 ? "" : "s"}`);
  if (status.activeAgentTurns) parts.push(`${status.activeAgentTurns} agent turn${status.activeAgentTurns === 1 ? "" : "s"}`);
  if (status.activeCommands) parts.push(`${status.activeCommands} command${status.activeCommands === 1 ? "" : "s"}`);
  if (status.activeVerifications) parts.push(`${status.activeVerifications} verification${status.activeVerifications === 1 ? "" : "s"}`);
  if (status.hostedContinuations) parts.push(`${status.hostedContinuations} hosted continuation${status.hostedContinuations === 1 ? "" : "s"}`);
  if (status.backgroundTasks) parts.push(`${status.backgroundTasks} background task${status.backgroundTasks === 1 ? "" : "s"}`);
  return parts.length > 0 ? parts.join(" · ") : "Idle — nothing is running.";
}

/** Runtime & Execution — real execution facts about this machine and this session. */
export function RuntimeExecutionSection(): React.ReactElement {
  const ctx = useSettings();
  const info = ctx.systemInfo;

  return (
    <div>
      <h1 className="settings-section-title">Runtime &amp; Execution</h1>
      <p className="settings-section-subtitle">
        Where agent work executes and what the local runtime is doing right now.
      </p>

      <SettingsGroup title="Execution target">
        <SettingsRow
          title="Execution model"
          description="CodeForge executes on this computer against your local files. Model inference runs on the route your selected model defines: CodeForge's hosted free infrastructure, or directly against a provider you connected."
          control={<StatusBadge kind="ok">Local execution</StatusBadge>}
        />
        <SettingsRow
          title="Hosted continuations"
          description="Long model-side work can continue safely on CodeForge's hosted worker and be reclaimed exactly once — even across restarts."
          control={<StatusBadge kind="info">Available</StatusBadge>}
        />
        <SettingsRow
          title="Runtime status"
          description={ctx.runtimeStatus ? describeRuntimeStatus(ctx.runtimeStatus) : "The local runtime has not reported status yet."}
          control={<StatusBadge kind={ctx.runtimeStatus?.recoverable === false ? "warn" : "ok"}>{ctx.runtimeStatus?.activeWork ? "Working" : "Ready"}</StatusBadge>}
        />
      </SettingsGroup>

      <SettingsGroup title="Local runtime">
        <SettingsRow
          title="Platform"
          description={info ? `${info.platform} (${info.arch}) · OS release ${info.osRelease}` : "System information unavailable."}
        />
        <SettingsRow
          title="Shell & environment"
          description="Agent commands run without a shell with a sanitized, credential-free environment inherited from CodeForge."
        />
        <SettingsRow
          title="Background work"
          description="Repository Intelligence indexing runs in the background. Long agent work runs as durable workflows that survive restarts in the recovery architecture — not as detached shell jobs."
        />
      </SettingsGroup>

      <SettingsGroup title="Limits">
        <SettingsRow
          title="Safe command timeout"
          description="Commands are terminated after 60 seconds; verification commands get up to 5 minutes each."
          control={<span className="settings-value">60s / 300s</span>}
        />
        <SettingsRow
          title="Workflow concurrency"
          description="One workflow runs per session at a time; up to 20 workflows can exist across the application."
          control={<span className="settings-value">1 / session</span>}
        />
        <SettingsRow
          title="Restart behavior"
          description="After a restart, interrupted work is placed in a visible recovery hold. If 'Continue interrupted agents' is enabled (General), eligible turns resume from durable facts; paused turns always wait for you."
          control={<SettingsButton onClick={() => ctx.navigate("general")}>Open General</SettingsButton>}
        />
      </SettingsGroup>
    </div>
  );
}

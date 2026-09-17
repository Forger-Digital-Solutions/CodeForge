import React from "react";
import { useSettings } from "../settings-context.js";
import { CfSelect, SettingsGroup, SettingsRow, StatusBadge } from "../settings-controls.js";
import type { ExecutionMode } from "../../../app-settings.js";

/**
 * Agents — the settings that steer how autonomous work behaves. Controls appear only for
 * behavior the runtime really supports; hard runtime limits are stated as read-only facts
 * instead of fake knobs.
 */
export function AgentsSection(): React.ReactElement {
  const ctx = useSettings();

  return (
    <div>
      <h1 className="settings-section-title">Agents</h1>
      <p className="settings-section-subtitle">
        How CodeForge's autonomous agents plan, act, and stay under your control.
      </p>

      <SettingsGroup title="Default behavior">
        <SettingsRow
          title="Default new task mode"
          description="Agent runs the full autonomous workflow with approval and verification gates. Chat runs a conversational runtime turn. Applies to new tasks."
          control={
            <CfSelect
              label="Default new task mode"
              value={ctx.defaultExecutionMode}
              options={[
                { value: "agent", label: "Agent" },
                { value: "chat", label: "Chat" },
              ]}
              onChange={(next) => ctx.setDefaultExecutionMode(next as ExecutionMode)}
            />
          }
        />
        <SettingsRow
          title="Agent steering"
          description="Hold new expensive actions (model dispatch, tools, verifiers) while you type a message, so your steer is seen before the next action starts. Already-running commands continue unless you cancel them."
          control={
            <CfSelect
              label="Agent steering while typing"
              value={ctx.settings.general.defaultSteeringPolicy}
              options={[
                { value: "expensive_actions_only", label: "On — while I type" },
                { value: "off", label: "Off" },
              ]}
              onChange={(next) => void ctx.update({ settings: { general: { defaultSteeringPolicy: next as "expensive_actions_only" | "off" } } })}
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup title="Approvals">
        <SettingsRow
          title="Approval policy"
          description="Every risky action asks first: file writes and edits require approval, and commands are classified by risk — destructive or privileged commands always wait for you. At the prompt you can allow once or deny."
          control={<StatusBadge kind="ok">Ask before risky actions</StatusBadge>}
        />
        {ctx.runtimeStatus && ctx.runtimeStatus.pendingApprovals > 0 ? (
          <SettingsRow
            title="Waiting for you"
            description={`${ctx.runtimeStatus.pendingApprovals} approval request${ctx.runtimeStatus.pendingApprovals === 1 ? "" : "s"} pending right now. They appear in the workspace and expire after 5 minutes.`}
            control={<StatusBadge kind="warn">{`${ctx.runtimeStatus.pendingApprovals} pending`}</StatusBadge>}
          />
        ) : null}
      </SettingsGroup>

      <SettingsGroup title="Parallel work">
        <SettingsRow
          title="Parallel workstreams"
          description="Autonomous runs may use up to 3 parallel workstreams (3 active coders, 2 reviewers). Subagents are limited to one level deep with at most 5 children per agent. These are safe runtime limits, not user-tunable knobs."
          control={<StatusBadge kind="info">Managed</StatusBadge>}
        />
      </SettingsGroup>

      <SettingsGroup title="Tool execution">
        <SettingsRow
          title="File edits & commands"
          description="File operations are restricted to the open workspace, and child processes run with a sanitized environment that strips credentials."
          control={<StatusBadge kind="ok">Sandboxed</StatusBadge>}
        />
        <SettingsRow
          title="Command timeout"
          description="Agent-run commands are terminated after 60 seconds, including their whole process tree."
          control={<span className="settings-value">60s</span>}
        />
      </SettingsGroup>

      <SettingsGroup title="Completion">
        <SettingsRow
          title="Verification before completion"
          description="ForgeVerify runs the project's discovered verifiers and the completion gate refuses to mark a task complete unless the required checks passed on the current state. This is product policy and cannot be turned off."
          control={<StatusBadge kind="ok">Enforced</StatusBadge>}
        />
        <SettingsRow
          title="Budget protection"
          description="Runs that verify nothing, change nothing, or exhaust their budget terminate as blocked — never as success."
          control={<StatusBadge kind="ok">Active</StatusBadge>}
        />
      </SettingsGroup>
    </div>
  );
}

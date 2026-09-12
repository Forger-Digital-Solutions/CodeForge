import React from "react";
import { useSettings } from "../settings-context.js";
import { SettingsGroup, SettingsRow, StatusBadge } from "../settings-controls.js";

/**
 * Verification & Safety. These safeguards are architectural, not preferences: ForgeZero routing
 * gates, ForgeVerify, the completion gate, workspace boundaries, and secret redaction are all
 * enforced by the runtime. The page presents them truthfully as always-on status rather than
 * offering dead toggles for protections that cannot be disabled.
 */
export function VerificationSafetySection(): React.ReactElement {
  const ctx = useSettings();
  return (
    <div>
      <h1 className="settings-section-title">Verification &amp; Safety</h1>
      <p className="settings-section-subtitle">
        CodeForge verifies work before claiming success and protects your workspace while agents
        operate. These safeguards are part of the product's architecture and are always enforced.
      </p>

      <SettingsGroup title="Verification">
        <SettingsRow
          title="ForgeVerify"
          description="Before an agent run completes, CodeForge discovers the project's verifiers (test/typecheck/build scripts) and executes them with evidence bound to the exact repository state they verified."
          control={<StatusBadge kind="ok">Active</StatusBadge>}
        />
        <SettingsRow
          title="Completion gate"
          description="A run only reaches completed when required verification passed on the current state and the review is clean. Otherwise it terminates as blocked — a failure state, never success."
          control={<StatusBadge kind="ok">Enforced</StatusBadge>}
        />
        <SettingsRow
          title="Evidence freshness"
          description="Verification evidence that no longer matches the repository (new commits, dirty files) is rejected and must be re-run."
          control={<StatusBadge kind="ok">Active</StatusBadge>}
        />
      </SettingsGroup>

      <SettingsGroup title="Workspace protection">
        <SettingsRow
          title="Workspace boundaries"
          description="File operations resolve strictly inside the open workspace, including symlink checks. Paths outside the boundary are rejected."
          control={<StatusBadge kind="ok">Active</StatusBadge>}
        />
        <SettingsRow
          title="Destructive-action confirmation"
          description="Destructive and privileged commands (deletions, force pushes, disk operations) are classified as critical and always require your approval."
          control={<StatusBadge kind="ok">Active</StatusBadge>}
        />
        <SettingsRow
          title="Command safeguards"
          description="Commands run without a shell, with a sanitized environment, capped output, and a 60-second timeout that terminates the whole process tree."
          control={<StatusBadge kind="ok">Active</StatusBadge>}
        />
      </SettingsGroup>

      <SettingsGroup title="Secrets">
        <SettingsRow
          title="Secret redaction"
          description="Detected credentials are redacted from prompts, tool output, and logs. Provider-specific redaction applies to every model route, and ForgeZero never stores a plaintext secret."
          control={<StatusBadge kind="ok">Active</StatusBadge>}
        />
        <SettingsRow
          title="Credential storage"
          description="Provider credentials and cloud tokens are encrypted with the operating system's secure storage and never displayed back in the UI or written to logs."
          control={<StatusBadge kind="ok">Encrypted</StatusBadge>}
        />
      </SettingsGroup>

      {ctx.runtimeStatus?.unrecoverableResources?.length ? (
        <SettingsGroup title="Needs attention">
          <SettingsRow
            title="Unrecoverable active work"
            description={ctx.runtimeStatus.unrecoverableResources.join(" · ")}
            control={<StatusBadge kind="warn">Review</StatusBadge>}
          />
        </SettingsGroup>
      ) : null}
    </div>
  );
}

import React, { useState } from "react";
import { useSettings } from "../settings-context.js";
import { Avatar, SettingsGroup, SettingsRow, SettingsButton, StatusBadge } from "../settings-controls.js";

/**
 * Profile & Account. Every value comes from the authenticated cloud account snapshot; missing
 * GitHub fields render as truthful "not shared" states, never placeholders or raw API data.
 */
export function ProfileSection(): React.ReactElement {
  const ctx = useSettings();
  const account = ctx.account;
  const eligibleFreeRoutes = ctx.apiModels.filter(
    (model) => model.eligible === true && model.freeStatus === "verified_free" && model.costProfile?.isFree === true,
  ).length;
  const [deleteStep, setDeleteStep] = useState<"idle" | "confirm" | "deleting">("idle");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);

  if (!account) {
    return (
      <div>
        <h1 className="settings-section-title">Profile &amp; Account</h1>
        <p className="settings-section-subtitle">
          Your CodeForge identity is your connected GitHub account. ForgeAuto/Free and the CodeForge
          Free catalog are visible without signing in; sign in to actually run hosted free models.
        </p>
        <SettingsGroup>
          <SettingsRow
            title="CodeForge Cloud"
            description="Sign in with GitHub for zero-setup hosted inference with an allowance that resets each 30-day period."
            control={
              <SettingsButton
                variant="primary"
                disabled={reconnecting}
                onClick={async () => {
                  setReconnecting(true);
                  try {
                    await ctx.signIn();
                  } finally {
                    setReconnecting(false);
                  }
                }}
              >
                {reconnecting ? "Waiting for browser…" : "Sign in with GitHub"}
              </SettingsButton>
            }
          />
        </SettingsGroup>
      </div>
    );
  }

  const displayName = account.user?.displayName ?? "CodeForge account";
  const login = account.identity?.login ?? null;
  const email = account.identity?.email ?? null;
  const emailState = email ? email : "Email not shared";
  const emailDescription = email
    ? undefined
    : "Your GitHub account does not share an email with CodeForge. Reconnect GitHub and approve the email permission to show your verified address here.";

  return (
    <div>
      <h1 className="settings-section-title">Profile &amp; Account</h1>
      <p className="settings-section-subtitle">
        Your CodeForge account and the GitHub identity connected to it.
      </p>

      {ctx.isFixtureAccount && (
        <div className="fixture-banner" role="note">
          Smoke fixture account — this identity comes from the packaged-test harness, not a real
          sign-in. Production builds only show this during automated smoke runs.
        </div>
      )}

      <SettingsGroup>
        <div className="account-card">
          <Avatar url={account.user?.avatarUrl} name={displayName} />
          <div style={{ minWidth: 0 }}>
            <div className="account-name">{displayName}</div>
            {login ? <div className="account-handle">@{login}</div> : null}
            <div className="account-email">{emailState}</div>
          </div>
        </div>
        {emailDescription ? <div className="settings-note">{emailDescription}</div> : null}
      </SettingsGroup>

      <SettingsGroup title="GitHub">
        <SettingsRow
          title="Connection"
          description={login ? `Connected as @${login}` : "Connected via GitHub authentication."}
          control={<StatusBadge kind="ok">Connected</StatusBadge>}
        />
        {account.identity?.profileUrl ? (
          <SettingsRow
            title="GitHub profile"
            description={account.identity.profileUrl}
            control={<SettingsButton onClick={() => ctx.openExternal(account.identity!.profileUrl!)}>Open</SettingsButton>}
          />
        ) : null}
        <SettingsRow
          title="Manage GitHub connection"
          description="Re-authorize in your browser. GitHub may ask to approve email access so CodeForge can show your account email — approving it is optional."
          control={
            <SettingsButton
              disabled={reconnecting}
              onClick={async () => {
                setReconnecting(true);
                try {
                  await ctx.signIn();
                } finally {
                  setReconnecting(false);
                }
              }}
            >
              {reconnecting ? "Waiting for browser…" : "Reconnect GitHub"}
            </SettingsButton>
          }
        />
      </SettingsGroup>

      <SettingsGroup title="CodeForge account">
        <SettingsRow
          title="Plan"
          description={
            account.offline
              ? "CodeForge Cloud could not be reached, so your plan and credits are unknown right now. Local and BYOK routes keep working; Cloud-hosted models are unavailable until it is back."
              : account.planId === "free"
                ? "ForgeAuto/Free and CodeForge Free models don't use credits — they run on verified $0 routes."
                : "Manage payment details from your billing portal."
          }
          control={<span className="settings-value">{account.offline ? "Unknown (offline)" : account.planName ?? "CodeForge Free"}</span>}
        />
        {typeof account.creditBalance === "number" ? (
          <SettingsRow
            title="Credits"
            description="Credits are only consumed by premium or GEMS models, never by verified-free routes."
            control={<span className="settings-value">{account.creditBalance.toLocaleString()}</span>}
          />
        ) : null}
        <SettingsRow
          title="ForgeZero Free Access"
          description="Verified-free routing does not require credits. Availability depends on at least one currently executable provider route."
          control={<StatusBadge kind={eligibleFreeRoutes > 0 ? "ok" : "warn"}>{eligibleFreeRoutes > 0 ? `${eligibleFreeRoutes} available` : "No route"}</StatusBadge>}
        />
        <SettingsRow
          title="Sign out"
          description="Revokes this device's CodeForge session. Your provider credentials and local workspaces stay on this computer."
          control={
            <SettingsButton
              onClick={async () => {
                setDeleteStep("idle");
                await ctx.signOut();
              }}
            >
              Sign out
            </SettingsButton>
          }
        />
      </SettingsGroup>

      <SettingsGroup title="Danger zone" danger>
        {deleteStep === "idle" && (
          <SettingsRow
            title="Delete CodeForge account"
            description="Permanently delete your account, hosted sessions, and billing records from CodeForge Cloud. Local files are not affected. Your GitHub account is not deleted."
            control={<SettingsButton variant="danger" onClick={() => setDeleteStep("confirm")}>Delete account…</SettingsButton>}
          />
        )}
        {deleteStep === "confirm" && (
          <div className="settings-row stacked" style={{ borderTop: "none" }}>
            <div className="settings-row-title">Delete your CodeForge Cloud account?</div>
            <div className="settings-row-description">
              This deletes your account, hosted sessions, and billing/entitlement records from
              CodeForge Cloud. Some records (e.g. security/abuse logs) may be retained per policy.
              This does not delete your GitHub account.
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <SettingsButton
                variant="danger"
                onClick={async () => {
                  setDeleteStep("deleting");
                  setDeleteError(null);
                  try {
                    await ctx.deleteAccount();
                    setDeleteStep("idle");
                  } catch (error) {
                    setDeleteError(error instanceof Error ? error.message : "Account deletion failed. Please try again.");
                    setDeleteStep("confirm");
                  }
                }}
              >
                Yes, delete my account
              </SettingsButton>
              <SettingsButton onClick={() => setDeleteStep("idle")}>Cancel</SettingsButton>
            </div>
            {deleteError ? <div className="settings-row-description" style={{ color: "var(--cf-danger)" }}>{deleteError}</div> : null}
          </div>
        )}
      </SettingsGroup>
    </div>
  );
}

import { describe, expect, it } from "vitest";
import { ProfileSection } from "../src/renderer/settings/sections/ProfileSection.js";
import { GeneralSection } from "../src/renderer/settings/sections/GeneralSection.js";
import { renderSection, createSettingsContext, FIXTURE_ACCOUNT, FIXTURE_SETTINGS } from "./settings-test-harness.js";

describe("Profile & Account identity rendering", () => {
  it("shows the authenticated GitHub identity: name, @login, authorized email, avatar", () => {
    const markup = renderSection(<ProfileSection />, createSettingsContext());
    expect(markup).toContain("Edward Schmidt");
    expect(markup).toContain("@edward-s");
    expect(markup).toContain("edward@example.com");
    expect(markup).toContain("avatars.githubusercontent.com");
    expect(markup).toContain("Connected");
    expect(markup).toContain("https://github.com/edward-s");
    expect(markup).toContain("CodeForge Free");
  });

  it("falls back to the username when GitHub reports no display name", () => {
    const context = createSettingsContext({
      account: { ...FIXTURE_ACCOUNT, user: { ...FIXTURE_ACCOUNT.user, displayName: undefined } },
    });
    const markup = renderSection(<ProfileSection />, context);
    expect(markup).toContain("CodeForge account");
    // login still shown — nothing invented, nothing missing
    expect(markup).toContain("@edward-s");
  });

  it("renders a truthful 'Email not shared' state instead of a placeholder when no email is authorized", () => {
    const context = createSettingsContext({
      account: {
        ...FIXTURE_ACCOUNT,
        // Deployed cloud snapshots may not carry an identity block at all yet.
        identity: undefined,
      },
    });
    const markup = renderSection(<ProfileSection />, context);
    expect(markup).toContain("Email not shared");
    expect(markup).not.toContain("undefined");
    expect(markup).not.toContain("null");
  });

  it("never renders raw API objects or 'undefined' for missing account fields", () => {
    const context = createSettingsContext({ account: { user: { displayName: "Solo" }, planId: "free" } });
    const markup = renderSection(<ProfileSection />, context);
    expect(markup).toContain("Solo");
    expect(markup).not.toContain("[object Object]");
    expect(markup).not.toContain("undefined");
  });

  it("clearly labels the packaged-smoke fixture account as a fixture, not a real user", () => {
    const context = createSettingsContext({
      account: { user: { displayName: "Packaged smoke" }, planId: "free", planName: "Free", creditBalance: 500000 },
      isFixtureAccount: true,
    });
    const markup = renderSection(<ProfileSection />, context);
    expect(markup).toContain("Smoke fixture account");
    expect(markup).toContain("not a real sign-in");
  });

  it("keeps destructive account deletion behind an explicit two-step confirmation", () => {
    const markup = renderSection(<ProfileSection />, createSettingsContext());
    expect(markup).toContain("Delete account…");
    // The destructive action itself only appears after the user asks for it.
    expect(markup).not.toContain("Yes, delete my account");
  });

  it("offers sign-in when signed out instead of fake identity", () => {
    const context = createSettingsContext({ account: null });
    const markup = renderSection(<ProfileSection />, context);
    expect(markup).toContain("Sign in with GitHub");
    expect(markup).not.toContain("Edward Schmidt");
  });
});

describe("General page account summary", () => {
  it("summarizes the signed-in account and ForgeZero state", () => {
    const markup = renderSection(<GeneralSection />, createSettingsContext());
    expect(markup).toContain("Edward Schmidt");
    expect(markup).toContain("GitHub connected ✓");
    expect(markup).toContain("Verified Free");
  });

  it("exposes the startup and recovery preferences as toggles bound to real state", () => {
    const context = createSettingsContext({
      settings: { ...FIXTURE_SETTINGS, general: { ...FIXTURE_SETTINGS.general, continueInterruptedAgents: false, openLastWorkspaceOnStartup: false } },
    });
    const markup = renderSection(<GeneralSection />, context);
    // role=switch reflects the canonical stored value.
    expect(markup).toMatch(/role="switch"[^>]*checked=""/);
    expect(markup).toContain("Continue interrupted CodeForge agents");
    expect(markup).toContain("Open last workspace on startup");
  });
});

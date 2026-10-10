import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectedAccountsPanel, accountEligibilityLabel, accountPreferencePatch } from "../src/renderer/ConnectedAccountsPanel.js";
import { ProvidersSection } from "../src/renderer/settings/sections/ProvidersSection.js";
import { AddProviderFlow } from "../src/renderer/AddProviderFlow.js";
import { addProviderAccount, defaultProviderRoutingPolicy, disconnectProviderAccount, fetchProviderAccounts, fetchProviderRoutingPolicy, parseAccountBudgetCents, qualifyProviderAccount, replaceProviderAccountCredential, setProviderRoutingPolicy, updateProviderAccount } from "../src/renderer/provider-accounts-client.js";
import type { ConnectedAccountView, ProviderRoutingPolicy } from "../src/connected-account-types.js";
import type { ProviderConnectionView } from "../src/provider-connection-types.js";
import { createSettingsContext, renderSection } from "./settings-test-harness.js";

const account = (override: Partial<ConnectedAccountView> = {}): ConnectedAccountView => ({
  connectionId: "connection-a", providerId: "openrouter", providerName: "OpenRouter", maskedIdentity: "•••• a1b2",
  authMethod: "OAUTH_PKCE", connected: true, enabled: true, authState: "ok", classification: "FREE_VERIFIED", freeOnly: true,
  paidSpendingEnabled: false, preference: "AUTO", freeRouteCount: 1, qualifiedModels: ["qualified/free"], paidDispatchEligible: false,
  quotaSummary: "20 requests remaining", health: "Healthy", ...override,
});
const provider: ProviderConnectionView = {
  providerId: "openrouter", displayName: "OpenRouter", kind: "gateway", implemented: true, recommendedForFreeDefault: true,
  authClasses: ["OAUTH_PKCE", "ASSISTED_KEY"], fields: [{ id: "apiKey", label: "API key", secret: true, optional: false, environmentAliases: [] }],
  freeAccess: { class: "FREE_API", spillover: "NONE", evidence: { source: "fixture", checkedAt: "2026-10-09" } },
  privacy: { class: "standard" }, terms: { status: "CLEARED" }, connected: false, credentialSource: "NONE", authState: "unknown",
  planAttested: false, planAttestationRequired: false, environment: null, freeRouteCount: 0, healthyRouteCount: 0,
  catalogCount: 0, paidOnly: false, zeroCashFreeAccess: true, sortRank: 0,
};
const render = (accounts: ConnectedAccountView[], policy = defaultProviderRoutingPolicy()) => renderSection(<ConnectedAccountsPanel providers={[provider]} accounts={accounts} policy={policy} />, createSettingsContext());

afterEach(() => vi.unstubAllGlobals());

describe("Connected Accounts settings", () => {
  it("keeps account connections optional and spending off with a FreeOnly default", () => {
    const html = render([]);
    expect(html).toContain("does not require an external provider account");
    expect(html).toContain("New connections default to FreeOnly with paid spending off");
    expect(html).toContain("Packaged Free routes remain available");
    expect(html).toContain("Add Account");
    expect(html).toContain("Routing preference · FreeOnly · paid spending off");
    const paidControl = html.match(/<input\b[^>]*aria-label="Permit paid account routing"[^>]*>/)?.[0];
    expect(paidControl).toContain('disabled=""');
    expect(paidControl).not.toContain('checked=""');
  });
  it("renders distinct rows for multiple accounts on one provider with only masked identity", () => {
    const html = render([account({ label: "Personal" }), account({ connectionId: "connection-b", maskedIdentity: "•••• c3d4", label: "Optional paid", classification: "PAID", freeRouteCount: 0, qualifiedModels: [] })]);
    expect(html).toContain('data-connection-id="connection-a"');
    expect(html).toContain('data-connection-id="connection-b"');
    expect(html).toContain("OpenRouter · Personal");
    expect(html).toContain("OpenRouter · Optional paid");
    expect(html).toContain("Paid account");
    expect(html).toContain("Reauthorize");
    expect(html).toContain("Disconnect");
    expect(html).not.toContain("sk-or-");
  });
  it("does not impose an arbitrary account display ceiling", () => {
    const html = render(Array.from({ length: 51 }, (_, index) => account({ connectionId: `connection-${index}` })));
    expect(html.match(/data-connection-id=/g)).toHaveLength(51);
  });
  it("does not describe stored paid permission as runtime admission", () => {
    const html = render([account({ classification: "PAID", freeOnly: false, paidSpendingEnabled: true, monthlyBudgetCents: 1000, paidDispatchEligible: false, paidBlockReason: "PAID_RUNTIME_AUTHORITY_REQUIRED" })]);
    expect(html).toContain("Paid spending permission on");
    expect(html).toContain("Paid inference is currently blocked");
    expect(html).toContain('value="10.00"');
    expect(html).toContain("No automatic top-up");
    expect(html).not.toContain("Paid inference ready");
  });
  it("offers bounded qualification only for accounts with verified Free entitlement", () => {
    expect(render([account()])).toContain("Qualify Free models");
    expect(render([account({ classification: "PAID" })])).not.toContain("Qualify Free models");
    expect(render([account({ classification: "FREE_UNVERIFIED" })])).not.toContain("Qualify Free models");
    expect(render([account({ classification: "BLOCKED" })])).not.toContain("Qualify Free models");
  });
  it("keeps paid qualification disabled until current spending authority is verified", () => {
    const disabledQualification = render([account({ classification: "PAID", paidQualificationEligible: false, qualificationModels: [{ modelId: "fixture-model", displayName: "Fixture model", isFree: false }] })]);
    expect(disabledQualification).toContain("Qualify selected personal model");
    expect(disabledQualification).toContain("Qualification requires current account authorization");
    expect(disabledQualification).toContain("Each request shows its estimate before dispatch");
    expect(disabledQualification).toContain("Qualification does not certify a zero-cost route");
    expect(disabledQualification.match(/<button\b[^>]*>Qualify selected personal model/)?.[0]).toContain("disabled");
  });
  it("keeps the global paid toggle explicit for Auto best and requires consent and limitations controls", () => {
    const policy: ProviderRoutingPolicy = { ...defaultProviderRoutingPolicy(), mode: "AUTO_BEST" };
    const html = render([], policy);
    expect(html).toContain("Auto best · paid spending off");
    expect(html).toContain('aria-label="Permit paid account routing"');
    expect(html).toContain('aria-label="Authorize personal paid inference"');
    expect(html).toContain('aria-label="Acknowledge paid routing limits"');
    expect(html).toContain("local budgets cannot guarantee a provider-side invoice cap");
    expect(html).toContain("Provider charges may exceed an estimate");
    expect(html).toContain("ForgeAuto/Free never uses paid fallback");
    expect(html.match(/<input\b[^>]*aria-label="Permit paid account routing"[^>]*>/)?.[0]).not.toContain('checked=""');
  });
  it("does not claim an empty qualified roster or disconnected account is usable", () => {
    expect(accountEligibilityLabel(account({ freeRouteCount: 0, qualifiedModels: [] }))).toBe("No qualified Free route");
    expect(accountEligibilityLabel(account({ connected: false, enabled: false }))).toBe("Disconnected");
    expect(accountEligibilityLabel(account({ authState: "auth_required" }))).toBe("Reauthorization required");
    const html = render([account({ connected: false, enabled: false, authMethod: "API_KEY", qualifiedModels: [], freeRouteCount: 0 })]);
    expect(html).toContain("Replace credential");
    expect(html.match(/<input\b[^>]*aria-label="Enable OpenRouter •••• a1b2"[^>]*>/)?.[0]).toContain('disabled=""');
  });
  it("keeps packaged readiness distinct from optional personal connections and advanced setup", () => {
    const html = renderSection(<ProvidersSection connections={[]} accounts={[]} routingPolicy={defaultProviderRoutingPolicy()} environment={[]} />, createSettingsContext());
    expect(html).toContain("Connected Accounts");
    expect(html).toContain("Packaged Free supply");
    expect(html).toContain("No external provider account required");
    expect(html).toContain("Provider setup and environment credentials");
  });
  it("reuses supported browser authorization and empty password inputs for new accounts", () => {
    const html = renderSection(<AddProviderFlow providers={[provider]} accountTransport={{ connect: async () => ({ ok: true }), oauth: async () => ({ ok: true }) }} />, createSettingsContext());
    expect(html).toContain("Connect OpenRouter (one click)");
    expect(html).toContain('type="password"');
    expect(html).not.toContain('value="sk-');
    expect(html).not.toContain("providerAccounts:list");
  });
});

describe("Account spending input", () => {
  it("parses exact cents and refuses fractional cents, exponents, unsafe values and negative limits", () => {
    expect(parseAccountBudgetCents("0.29")).toBe(29);
    expect(parseAccountBudgetCents("12.3")).toBe(1230);
    expect(parseAccountBudgetCents("0")).toBe(0);
    expect(parseAccountBudgetCents("")).toBeNull();
    for (const value of ["-1", "0.001", "1e9", "NaN", "Infinity", "9007199254740991", "$1.00"]) expect(parseAccountBudgetCents(value)).toBeUndefined();
  });
  it("requires positive budget for explicit account spending and never sends a hidden freeOnly override", () => {
    for (const budget of ["", "0", "-1", "0.005"]) expect(() => accountPreferencePatch("Work", "AUTO", true, budget)).toThrow();
    expect(accountPreferencePatch(" Work ", "FALLBACK", true, "5.01")).toEqual({ label: "Work", preference: "FALLBACK", paidSpendingEnabled: true, monthlyBudgetCents: 501 });
    expect(accountPreferencePatch("Work", "AUTO", false, "")).toEqual({ label: "Work", preference: "AUTO", paidSpendingEnabled: false, monthlyBudgetCents: null });
  });
});

describe("Account client isolation", () => {
  it("fails closed when the account bridge or routing policy is unavailable", async () => {
    expect(await fetchProviderAccounts()).toEqual([]);
    expect(await fetchProviderRoutingPolicy()).toEqual(defaultProviderRoutingPolicy());
    expect(await addProviderAccount("openrouter", { apiKey: "synthetic-only" })).toMatchObject({ ok: false });
    expect(await updateProviderAccount("connection-a", { paidSpendingEnabled: true })).toMatchObject({ ok: false });
    expect(await setProviderRoutingPolicy({ ...defaultProviderRoutingPolicy(), mode: "AUTO_BEST" })).toMatchObject({ ok: false });
  });
  it("uses exact connection identifiers without provider-level disconnect or preference mutation", async () => {
    const disconnect = vi.fn(async () => ({ ok: true }));
    const replace = vi.fn(async () => ({ ok: true }));
    const update = vi.fn(async () => ({ ok: true }));
    const qualify = vi.fn(async () => ({ ok: true }));
    const legacy = vi.fn();
    vi.stubGlobal("window", { electronAPI: { disconnectProviderAccount: disconnect, replaceProviderAccountCredential: replace, updateProviderAccount: update, qualifyProviderAccount: qualify, disconnectProvider: legacy, setProviderEnabledModels: legacy } });
    await disconnectProviderAccount("connection-a");
    await replaceProviderAccountCredential("connection-b", { apiKey: "synthetic-only" });
    await updateProviderAccount("connection-b", { enabled: false });
    await qualifyProviderAccount("connection-b", "verified/free");
    expect(disconnect).toHaveBeenCalledWith("connection-a");
    expect(replace).toHaveBeenCalledWith("connection-b", { apiKey: "synthetic-only" });
    expect(update).toHaveBeenCalledWith("connection-b", { enabled: false });
    expect(qualify).toHaveBeenCalledWith("connection-b", "verified/free");
    expect(legacy).not.toHaveBeenCalled();
  });
});

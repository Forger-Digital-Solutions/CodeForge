import { useCallback, useEffect, useRef, useState } from "react";
import type { ConnectedAccountView, ConnectedAccountResult, ConnectedAccountPolicyPatch, ProviderAccountOAuthOptions, ProviderRoutingPolicy } from "../connected-account-types.js";
import { notifyProviderUpdated } from "./provider-connections-client.js";

export type { ConnectedAccountView, ConnectedAccountResult, ConnectedAccountPolicyPatch, ProviderAccountOAuthOptions, ProviderRoutingPolicy };

const unavailable = (): ConnectedAccountResult => ({ ok: false, error: "Connected Accounts bridge unavailable" });
const bridge = (): Window["electronAPI"] => typeof window === "undefined" ? undefined : window.electronAPI;
export const defaultProviderRoutingPolicy = (): ProviderRoutingPolicy => ({ mode: "FREE_ONLY", paidEnabled: false, explicitConsent: false, limitationsAcknowledged: false, automaticTopUp: false });

export async function fetchProviderAccounts(): Promise<ConnectedAccountView[]> {
  try { return await bridge()?.listProviderAccounts?.() ?? []; } catch { return []; }
}

export async function fetchProviderRoutingPolicy(): Promise<ProviderRoutingPolicy> {
  try { return await bridge()?.getProviderRoutingPolicy?.() ?? defaultProviderRoutingPolicy(); }
  catch { return defaultProviderRoutingPolicy(); }
}

export async function addProviderAccount(providerId: string, fields: Record<string, string>, label?: string): Promise<ConnectedAccountResult> {
  return await bridge()?.addProviderAccount?.(providerId, fields, label) ?? unavailable();
}

export async function updateProviderAccount(connectionId: string, patch: ConnectedAccountPolicyPatch): Promise<ConnectedAccountResult> {
  return await bridge()?.updateProviderAccount?.(connectionId, patch) ?? unavailable();
}

export async function disconnectProviderAccount(connectionId: string): Promise<ConnectedAccountResult> {
  return await bridge()?.disconnectProviderAccount?.(connectionId) ?? unavailable();
}

export async function replaceProviderAccountCredential(connectionId: string, fields: Record<string, string>): Promise<ConnectedAccountResult> {
  return await bridge()?.replaceProviderAccountCredential?.(connectionId, fields) ?? unavailable();
}

export async function qualifyProviderAccount(connectionId: string, modelId?: string): Promise<ConnectedAccountResult> {
  return await bridge()?.qualifyProviderAccount?.(connectionId, modelId) ?? unavailable();
}

export async function connectProviderAccountOAuth(providerId: string, options?: ProviderAccountOAuthOptions, browser?: "default" | "firefox"): Promise<ConnectedAccountResult> {
  return await bridge()?.connectProviderAccountOAuth?.(providerId, options, browser) ?? unavailable();
}

export async function setProviderRoutingPolicy(policy: ProviderRoutingPolicy): Promise<{ ok: boolean; error?: string }> {
  return await bridge()?.setProviderRoutingPolicy?.(policy) ?? { ok: false, error: "Routing policy bridge unavailable" };
}

export function parseAccountBudgetCents(value: string): number | null | undefined {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^\d+(?:\.\d{1,2})?$/.test(trimmed)) return undefined;
  const [dollars, decimals = ""] = trimmed.split(".");
  const cents = Number(dollars) * 100 + Number(decimals.padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents >= 0 ? cents : undefined;
}

export function useProviderAccounts(): { accounts: ConnectedAccountView[]; policy: ProviderRoutingPolicy; loading: boolean; reload: () => Promise<void> } {
  const [accounts, setAccounts] = useState<ConnectedAccountView[]>([]);
  const [policy, setPolicy] = useState<ProviderRoutingPolicy>(defaultProviderRoutingPolicy);
  const [loading, setLoading] = useState(true);
  const reloadSequence = useRef(0);
  const reload = useCallback(async () => {
    const sequence = ++reloadSequence.current;
    const [nextAccounts, nextPolicy] = await Promise.all([fetchProviderAccounts(), fetchProviderRoutingPolicy()]);
    if (sequence !== reloadSequence.current) return;
    setAccounts(nextAccounts);
    setPolicy(nextPolicy);
    setLoading(false);
  }, []);
  useEffect(() => {
    void reload();
    const unsubscribe = bridge()?.onProviderChanged?.(() => void reload());
    const changed = () => void reload();
    window.addEventListener("codeforge:provider-updated", changed);
    return () => { ++reloadSequence.current; unsubscribe?.(); window.removeEventListener("codeforge:provider-updated", changed); };
  }, [reload]);
  return { accounts, policy, loading, reload };
}

export function notifyAccountUpdated(): void { notifyProviderUpdated(); }

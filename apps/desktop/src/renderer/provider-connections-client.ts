import { useCallback, useEffect, useState } from "react";
import type { ProviderConnectionView, EnvironmentCredentialView, ProviderCatalogModelView, FirstRunOffer, ConnectResult } from "../provider-connection-types.js";
import type { EnvironmentCredentialPolicy } from "@codeforge/model-registry";

/**
 * Renderer client for the trusted provider-connection bridge. Everything here is state or a
 * schema — the bridge never returns credential values, and this module never stores a typed
 * key beyond the single IPC call that submits it.
 */
export type { ProviderConnectionView, EnvironmentCredentialView, ProviderCatalogModelView, FirstRunOffer, ConnectResult };

export interface FreeCloudSummaryView {
  canonicalModels: number;
  verifiedFreeModels: number;
  verifiedFreeRoutes: number;
  healthyFreeRoutes: number;
  connectedProviders: number;
  coolingDown: number;
  primaryCodingModels: number;
  paidRoutesExcluded: number;
  sameModelMultiProviderModels: number;
  qualifying: boolean;
  pendingQualification: number;
  discovering: number;
  generatedAt: string;
}

type Bridge = NonNullable<Window["electronAPI"]>;

function bridge(): Bridge | undefined {
  return window.electronAPI;
}

export async function fetchConnections(): Promise<ProviderConnectionView[]> {
  const api = bridge();
  if (!api?.getProviderConnections) return [];
  try {
    return (await api.getProviderConnections()) as ProviderConnectionView[];
  } catch {
    return [];
  }
}

export async function fetchEnvironmentCredentials(): Promise<EnvironmentCredentialView[]> {
  const api = bridge();
  if (!api?.listEnvironmentCredentials) return [];
  try {
    return (await api.listEnvironmentCredentials()) as EnvironmentCredentialView[];
  } catch {
    return [];
  }
}

export async function fetchFreeCloudSummary(): Promise<FreeCloudSummaryView | null> {
  const api = bridge();
  if (!api?.getFreeCloudSummary) return null;
  try {
    return (await api.getFreeCloudSummary()) as FreeCloudSummaryView | null;
  } catch {
    return null;
  }
}

export async function fetchFreeCloudOffer(): Promise<FirstRunOffer | null> {
  const api = bridge();
  if (!api?.getFreeCloudOffer) return null;
  try {
    return (await api.getFreeCloudOffer()) as FirstRunOffer;
  } catch {
    return null;
  }
}

export async function setEnvironmentEnabled(providerId: string, enabled: boolean): Promise<void> {
  await bridge()?.setEnvironmentCredentialEnabled?.(providerId, enabled);
}

export async function getEnvironmentPolicy(): Promise<EnvironmentCredentialPolicy> {
  const api = bridge();
  if (!api?.getEnvironmentCredentialPolicy) return "FREE_ROUTES_ONLY";
  try {
    return (await api.getEnvironmentCredentialPolicy()) as EnvironmentCredentialPolicy;
  } catch {
    return "FREE_ROUTES_ONLY";
  }
}

export async function setEnvironmentPolicy(policy: EnvironmentCredentialPolicy): Promise<void> {
  await bridge()?.setEnvironmentCredentialPolicy?.(policy);
}

export async function refreshEnvironment(): Promise<{ updated: number; queried: number } | null> {
  const api = bridge();
  if (!api?.refreshEnvironmentCredentials) return null;
  try {
    const r = await api.refreshEnvironmentCredentials();
    return { updated: r.updated, queried: r.queried };
  } catch {
    return null;
  }
}

export async function validateProvider(providerId: string, fields: Record<string, string>): Promise<ConnectResult> {
  const api = bridge();
  if (!api?.validateProvider) return { ok: false, error: "Provider bridge unavailable" };
  return (await api.validateProvider(providerId, fields)) as ConnectResult;
}

export async function connectProvider(providerId: string, fields: Record<string, string>): Promise<ConnectResult> {
  const api = bridge();
  if (!api?.connectProvider) return { ok: false, error: "Provider bridge unavailable" };
  return (await api.connectProvider(providerId, fields)) as ConnectResult;
}

export async function fetchProviderCatalog(providerId: string): Promise<ConnectResult> {
  const api = bridge();
  if (!api?.getProviderCatalog) return { ok: false, error: "Provider bridge unavailable" };
  return (await api.getProviderCatalog(providerId)) as ConnectResult;
}

export async function disconnectProvider(providerId: string): Promise<void> {
  await bridge()?.disconnectProvider?.(providerId);
}

export async function attestFreePlan(providerId: string, attested: boolean): Promise<void> {
  await bridge()?.attestProviderFreePlan?.(providerId, attested);
}

export async function setEnabledModels(providerId: string, modelIds: string[] | null): Promise<void> {
  await bridge()?.setProviderEnabledModels?.(providerId, modelIds);
}

export async function connectOpenRouterOAuth(): Promise<{ ok: boolean; verifiedFree?: number; error?: string }> {
  const api = bridge();
  if (!api?.connectOpenRouter) return { ok: false, error: "OAuth bridge unavailable" };
  return api.connectOpenRouter();
}

export async function importEnvironmentCredential(providerId: string): Promise<{ ok: boolean; error?: string }> {
  const api = bridge();
  if (!api?.importEnvironmentCredential) return { ok: false, error: "Bridge unavailable" };
  return api.importEnvironmentCredential(providerId);
}

/** Notify the rest of the renderer (workspace picker, settings) that provider state changed. */
export function notifyProviderUpdated(): void {
  try {
    window.dispatchEvent(new CustomEvent("codeforge:provider-updated"));
  } catch {
    // ignore
  }
}

/** Subscribes to main-process provider changes and re-fetches connections + env + summary. */
export function useProviderConnections(): {
  connections: ProviderConnectionView[];
  environment: EnvironmentCredentialView[];
  summary: FreeCloudSummaryView | null;
  policy: EnvironmentCredentialPolicy;
  reload: () => Promise<void>;
  loading: boolean;
} {
  const [connections, setConnections] = useState<ProviderConnectionView[]>([]);
  const [environment, setEnvironment] = useState<EnvironmentCredentialView[]>([]);
  const [summary, setSummary] = useState<FreeCloudSummaryView | null>(null);
  const [policy, setPolicy] = useState<EnvironmentCredentialPolicy>("FREE_ROUTES_ONLY");
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    const [c, e, s, p] = await Promise.all([fetchConnections(), fetchEnvironmentCredentials(), fetchFreeCloudSummary(), getEnvironmentPolicy()]);
    setConnections(c);
    setEnvironment(e);
    setSummary(s);
    setPolicy(p);
    setLoading(false);
  }, []);

  useEffect(() => {
    void reload();
    const unsubscribe = bridge()?.onProviderChanged?.(() => void reload());
    const onUpdated = () => void reload();
    window.addEventListener("codeforge:provider-updated", onUpdated);
    return () => {
      unsubscribe?.();
      window.removeEventListener("codeforge:provider-updated", onUpdated);
    };
  }, [reload]);

  return { connections, environment, summary, policy, reload, loading };
}

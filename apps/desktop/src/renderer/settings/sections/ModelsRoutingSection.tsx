import React, { useEffect, useMemo, useState } from "react";
import { loadModelFavorites, saveModelFavorites } from "@codeforge/ui";
import type { CanonicalModelView } from "@codeforge/model-registry";
import { useSettings } from "../settings-context.js";
import { SettingsGroup, SettingsRow, SettingsButton, StatusBadge } from "../settings-controls.js";
import { routeHealthLabel, routeStageLabel } from "../../CanonicalModelDetails.js";
import { fetchFreeCloudSummary, type FreeCloudSummaryView } from "../../provider-connections-client.js";
import type { FreeCloudView } from "../../model-sections.js";

const SERVER_BASE_URL = (() => {
  if (typeof window === "undefined") return "http://127.0.0.1:3210";
  const endpoint = window.electronAPI?.getRuntimeEndpoint?.();
  return typeof endpoint === "string" && endpoint.length > 0 ? endpoint : "http://127.0.0.1:3210";
})();

export interface ModelsRoutingSectionProps {
  /** Test seam: a static registry snapshot instead of the live server. */
  registry?: FreeCloudView | null;
  summary?: FreeCloudSummaryView | null;
}

/**
 * Models & Routing — organized around CodeForge's actual model architecture (ForgeAuto, the
 * free catalog, ForgeZero, favorites, GEMS), not around providers. The model list is the SAME
 * canonical catalog the composer picker uses (buildModelSections over /api/models) — there is no
 * second model list.
 */
export function ModelsRoutingSection(props: ModelsRoutingSectionProps = {}): React.ReactElement {
  const ctx = useSettings();
  const [picking, setPicking] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNote, setRefreshNote] = useState<string | null>(null);
  const [liveRegistry, setLiveRegistry] = useState<FreeCloudView | null>(null);
  const [liveSummary, setLiveSummary] = useState<FreeCloudSummaryView | null>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const registry = props.registry === undefined ? liveRegistry : props.registry;
  const summary = props.summary === undefined ? liveSummary : props.summary;

  useEffect(() => {
    if (props.registry !== undefined) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`${SERVER_BASE_URL}/api/free-cloud/registry`);
        if (res.ok && !cancelled) setLiveRegistry((await res.json()) as FreeCloudView);
      } catch {}
      const s = await fetchFreeCloudSummary();
      if (!cancelled) setLiveSummary(s);
    };
    void load();
    const unsubscribe = window.electronAPI?.onProviderChanged?.(() => void load());
    const onUpdated = () => void load();
    window.addEventListener("codeforge:provider-updated", onUpdated);
    return () => {
      cancelled = true;
      unsubscribe?.();
      window.removeEventListener("codeforge:provider-updated", onUpdated);
    };
  }, [props.registry, ctx.apiModels]);

  const [favoritesVersion, setFavoritesVersion] = useState(0);
  const favorites = useMemo(() => [...loadModelFavorites()], [favoritesVersion, ctx.apiModels]);
  const defaultModel = ctx.apiModels.find((m) => m.id === ctx.defaultModelId);

  const freeSection = ctx.modelSections.find((s) => s.sectionLabel === "CODEFORGE FREE");
  const freeCount = freeSection?.models.length ?? 0;
  const eligibleFreeCount = ctx.apiModels.filter(
    (m) => m.eligible === true && m.freeStatus === "verified_free" && m.costProfile?.isFree === true,
  ).length;
  const verifiedFreeCount = ctx.apiModels.filter(
    (m) => m.freeStatus === "verified_free" && m.costProfile?.isFree === true && !m.isPromotional,
  ).length;
  const routingDegraded = registry ? registry.summary.healthyFreeRoutes === 0 : eligibleFreeCount === 0;
  const gemsCount = ctx.modelSections.find((s) => s.sectionLabel === "GEMS")?.models.length ?? 0;

  const lastChecked = ctx.catalogLastCheckedAt
    ? Math.max(0, Math.round((Date.now() - ctx.catalogLastCheckedAt) / 60000))
    : null;

  const removeFavorite = (id: string) => {
    const next = new Set(loadModelFavorites());
    next.delete(id);
    saveModelFavorites(next);
    setFavoritesVersion((version) => version + 1);
  };

  return (
    <div>
      <h1 className="settings-section-title">Models &amp; Routing</h1>
      <p className="settings-section-subtitle">
        How CodeForge chooses the model that works on each task. Connecting extra providers is
        optional — see Provider Connections.
      </p>

      <SettingsGroup title="Default model">
        <SettingsRow
          title={ctx.defaultModelId === "auto" ? "ForgeAuto/Free" : defaultModel?.displayName ?? registry?.models.find((m) => `canonical:${m.canonicalId}` === ctx.defaultModelId)?.displayName ?? ctx.defaultModelId}
          description={
            ctx.defaultModelId === "auto"
              ? "Automatically routes each task to the best qualified free model. Changing this applies immediately and after restart."
              : "Each task is pinned to this model until you switch back to ForgeAuto/Free."
          }
          control={
            <SettingsButton onClick={() => setPicking((current) => !current)}>
              {picking ? "Close catalog" : "Change model"}
            </SettingsButton>
          }
        />
        {picking && (
          <div>
            {ctx.modelSections.map((section) => (
              <div key={section.sectionId}>
                <div className="settings-group-title" style={{ paddingTop: 8 }}>{section.sectionLabel}</div>
                {section.models.map((model) => (
                  <div key={`${section.sectionId}-${model.id}`} className="model-pick-row">
                    <span className="model-pick-name">{model.displayName}</span>
                    <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span className="model-pick-badge">{model.description}</span>
                      {model.id === ctx.defaultModelId ? (
                        <StatusBadge kind="ok">Default</StatusBadge>
                      ) : (
                        <SettingsButton
                          disabled={model.available === false}
                          onClick={async () => {
                            await ctx.setDefaultModel(model.id);
                            setPicking(false);
                          }}
                        >
                          Set as default
                        </SettingsButton>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            ))}
            {ctx.modelSections.length === 0 && (
              <div className="settings-note">The catalog has not loaded yet. Check that the local runtime is running.</div>
            )}
          </div>
        )}
      </SettingsGroup>

      <SettingsGroup title="ForgeAuto">
        <SettingsRow
          title="Routing status"
          description="ForgeAuto ranks ForgeZero-eligible models by capability, benchmark, and live health, then routes each task to the best free route."
          control={<StatusBadge kind={routingDegraded ? "warn" : "ok"}>{routingDegraded ? "No eligible route" : "Healthy"}</StatusBadge>}
        />
        <SettingsRow
          title="Fallback"
          description="If a route fails, ForgeAuto first switches to another provider serving the same model, then to a compatible free model. Completed tool calls are never replayed. Paid models are never a fallback."
          control={<StatusBadge kind="ok">Enabled</StatusBadge>}
        />
      </SettingsGroup>

      <SettingsGroup title="8-Bit free cloud registry">
        <SettingsRow
          title={registry ? `${registry.summary.verifiedFreeModels} verified free models · ${registry.summary.verifiedFreeRoutes} verified routes · ${registry.summary.healthyFreeRoutes} healthy` : "Qualified free models"}
          description={
            registry
              ? `${registry.summary.canonicalModels} canonical models across ${registry.summary.connectedProviders} connected provider${registry.summary.connectedProviders === 1 ? "" : "s"} · ${registry.summary.primaryCodingModels} qualified as primary coding agent · ${registry.summary.sameModelMultiProviderModels} served by multiple providers · ${registry.summary.coolingDown} cooling down · ${registry.summary.paidRoutesExcluded} paid routes excluded${summary?.pendingQualification ? ` · ${summary.pendingQualification} awaiting qualification` : ""}.`
              : `${freeCount} CodeForge Free models listed · ${verifiedFreeCount} verified-free records · ${eligibleFreeCount} executable now${gemsCount ? ` · ${gemsCount} GEMS` : ""}.`
          }
          control={<StatusBadge kind={(registry ? registry.summary.healthyFreeRoutes : eligibleFreeCount) > 0 ? "ok" : summary?.qualifying ? "info" : "warn"}>{(registry ? registry.summary.healthyFreeRoutes : eligibleFreeCount) > 0 ? "Healthy" : summary?.qualifying ? "Qualifying" : "Unavailable"}</StatusBadge>}
        />
        {registry ? (
          <div className="model-pick-list">
            {registry.models.filter((m) => m.readiness !== "UNSUPPORTED" && m.readiness !== "PAID_BYOK").map((m) => (
              <div key={m.canonicalId} className="model-pick-row" data-canonical-id={m.canonicalId}>
                <span className="model-pick-name">{m.displayName}</span>
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span className="model-pick-badge">{m.freeBadge}</span>
                  <span className="model-pick-badge">{m.category}</span>
                </span>
              </div>
            ))}
            {registry.models.length === 0 ? <div className="settings-note">No free models discovered yet — connect a provider under Provider Connections.</div> : null}
          </div>
        ) : null}
        {registry ? (
          <div className="settings-row">
            <div className="settings-row-main">
              <div className="settings-row-title">Route diagnostics</div>
              <div className="settings-row-description">Per-route admission pipeline: terms → connected → free verified → tool capable → qualified → healthy → ForgeAuto eligible.</div>
            </div>
            <div className="settings-row-control">
              <SettingsButton onClick={() => setShowDiagnostics((v) => !v)}>{showDiagnostics ? "Hide" : "Show"}</SettingsButton>
            </div>
          </div>
        ) : null}
        {registry && showDiagnostics ? <RouteDiagnostics models={registry.models} /> : null}
        <SettingsRow
          title="Catalog check"
          description={
            lastChecked === null
              ? "The catalog refreshes automatically every few minutes."
              : lastChecked === 0
                ? "Last checked just now."
                : `Last checked ${lastChecked} min ago. The desktop also re-checks automatically every 5 minutes.`
          }
          control={
            <SettingsButton
              disabled={refreshing}
              onClick={async () => {
                setRefreshing(true);
                setRefreshNote(null);
                try {
                  const result = await ctx.catalogRefresh();
                  await ctx.refreshModels();
                  setRefreshNote(
                    result?.ok
                      ? `Refreshed — ${result.freeModels} free models in the catalog.`
                      : `Refresh failed: ${result?.error ?? "unknown error"}`,
                  );
                } finally {
                  setRefreshing(false);
                }
              }}
            >
              {refreshing ? "Refreshing…" : "Refresh catalog"}
            </SettingsButton>
          }
        />
        {refreshNote ? <div className="settings-note">{refreshNote}</div> : null}
      </SettingsGroup>

      <SettingsGroup title="ForgeZero">
        <SettingsRow
          title="Zero-billing enforcement"
          description="Fail-closed verification of free status, cost profiles, and provider health before any route is used. Cannot be disabled."
          control={<StatusBadge kind="ok">Active</StatusBadge>}
        />
        <SettingsRow
          title="Privacy routing mode"
          description="Controls which free endpoints ForgeAuto may use, based on their data-retention behavior."
          control={<SettingsButton onClick={() => ctx.navigate("privacy")}>Change</SettingsButton>}
        />
      </SettingsGroup>

      <SettingsGroup title="Favorites">
        {favorites.length === 0 ? (
          <SettingsRow
            title="No favorites yet"
            description="Star models in the picker and they appear here for quick access."
          />
        ) : (
          favorites.map((id) => (
            <div key={id} className="model-pick-row">
              <span className="model-pick-name">
                {ctx.modelSections.flatMap((s) => s.models).find((m) => m.id === id)?.displayName ?? id}
              </span>
              <span style={{ display: "flex", gap: 8 }}>
                {id === ctx.defaultModelId ? (
                  <StatusBadge kind="ok">Default</StatusBadge>
                ) : (
                  <SettingsButton onClick={() => void ctx.setDefaultModel(id)}>Set as default</SettingsButton>
                )}
                <SettingsButton onClick={() => removeFavorite(id)}>Remove</SettingsButton>
              </span>
            </div>
          ))
        )}
      </SettingsGroup>
    </div>
  );
}


function RouteDiagnostics({ models }: { models: CanonicalModelView[] }): React.ReactElement {
  return (
    <div className="route-diagnostics">
      <table className="route-table">
        <thead>
          <tr><th>Model</th><th>Provider</th><th>Access</th><th>Connection</th><th>Health</th><th>Stage</th></tr>
        </thead>
        <tbody>
          {models.flatMap((m) =>
            m.routes.map((r) => (
              <tr key={r.routeId} className={r.forgeAutoEligible ? "eligible" : undefined}>
                <td>{m.displayName}</td>
                <td title={r.providerModelId}>{r.providerDisplayName}</td>
                <td>{r.freeAccessClass.replace(/_/g, " ").toLowerCase()}</td>
                <td>{r.connected ? r.credentialSource.replace(/_/g, " ").toLowerCase() : "not connected"}</td>
                <td>{r.connected ? routeHealthLabel(r) : "—"}</td>
                <td title={r.admission.reason}>{routeStageLabel(r)}</td>
              </tr>
            )),
          )}
        </tbody>
      </table>
    </div>
  );
}

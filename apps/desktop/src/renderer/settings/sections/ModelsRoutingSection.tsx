import React, { useCallback, useEffect, useMemo, useState } from "react";
import { loadModelFavorites, saveModelFavorites } from "@codeforge/ui";
import type { CanonicalModelView } from "@codeforge/model-registry";
import { useSettings } from "../settings-context.js";
import { SettingsGroup, SettingsRow, SettingsButton, StatusBadge } from "../settings-controls.js";
import { routeHealthLabel, routeStageLabel } from "../../CanonicalModelDetails.js";
import { fetchFreeCloudSummary, type FreeCloudSummaryView } from "../../provider-connections-client.js";
import type { FreeCloudView } from "../../model-sections.js";

const FALLBACK_SERVER_BASE_URL = "http://127.0.0.1:0";

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
  const [runtimeEndpoint, setRuntimeEndpoint] = useState<string | null>(null);
  const serverBaseUrl = runtimeEndpoint ?? FALLBACK_SERVER_BASE_URL;
  const registry = props.registry === undefined ? liveRegistry : props.registry;
  const summary = props.summary === undefined ? liveSummary : props.summary;

  useEffect(() => {
    let active = true;
    const endpointPromise = window.electronAPI?.getRuntimeEndpoint?.();
    if (!endpointPromise) return () => { active = false; };
    void endpointPromise.then((endpoint) => {
      if (active && endpoint) setRuntimeEndpoint(endpoint);
    }).catch(() => {});
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (props.registry !== undefined) return;
    if (!runtimeEndpoint) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`${serverBaseUrl}/api/free-cloud/registry`);
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
  }, [props.registry, ctx.apiModels, runtimeEndpoint, serverBaseUrl]);

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

      <MyAutosGroup serverBaseUrl={serverBaseUrl} />

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

interface CustomAutoProfileView {
  id: string;
  name: string;
  description?: string;
  mode: "pinned" | "auto" | "hybrid";
  roles: {
    coder: { providerId: string; modelId: string; displayName?: string };
    planner?: { providerId: string; modelId: string; displayName?: string };
    reviewer?: { providerId: string; modelId: string; displayName?: string };
    verifier?: { providerId: string; modelId: string; displayName?: string };
  };
  trustDomain: string;
}

function MyAutosGroup({ serverBaseUrl }: { serverBaseUrl: string }): React.ReactElement {
  const [profiles, setProfiles] = useState<CustomAutoProfileView[]>([]);
  const [showEditor, setShowEditor] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Form state
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [mode, setMode] = useState<"pinned" | "auto" | "hybrid">("pinned");
  const [coderProvider, setCoderProvider] = useState("");
  const [coderModel, setCoderModel] = useState("");
  const [plannerProvider, setPlannerProvider] = useState("");
  const [plannerModel, setPlannerModel] = useState("");
  const [reviewerProvider, setReviewerProvider] = useState("");
  const [reviewerModel, setReviewerModel] = useState("");
  const [verifierProvider, setVerifierProvider] = useState("");
  const [verifierModel, setVerifierModel] = useState("");

  const loadProfiles = useCallback(async () => {
    try {
      const res = await fetch(`${serverBaseUrl}/api/custom-autos`);
      if (res.ok) {
        const data = await res.json();
        setProfiles(Array.isArray(data) ? data : []);
      }
    } catch {
      // Best-effort
    }
  }, [serverBaseUrl]);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  const resetForm = () => {
    setId("");
    setName("");
    setDescription("");
    setMode("pinned");
    setCoderProvider("");
    setCoderModel("");
    setPlannerProvider("");
    setPlannerModel("");
    setReviewerProvider("");
    setReviewerModel("");
    setVerifierProvider("");
    setVerifierModel("");
    setEditingId(null);
    setShowEditor(false);
    setErrorMessage(null);
  };

  const handleEdit = (p: CustomAutoProfileView) => {
    setEditingId(p.id);
    setId(p.id);
    setName(p.name);
    setDescription(p.description ?? "");
    setMode(p.mode ?? "pinned");
    setCoderProvider(p.roles.coder.providerId);
    setCoderModel(p.roles.coder.modelId);
    setPlannerProvider(p.roles.planner?.providerId ?? "");
    setPlannerModel(p.roles.planner?.modelId ?? "");
    setReviewerProvider(p.roles.reviewer?.providerId ?? "");
    setReviewerModel(p.roles.reviewer?.modelId ?? "");
    setVerifierProvider(p.roles.verifier?.providerId ?? "");
    setVerifierModel(p.roles.verifier?.modelId ?? "");
    setShowEditor(true);
    setErrorMessage(null);
  };

  const handleDuplicate = async (p: CustomAutoProfileView) => {
    const newId = `${p.id}-copy`.slice(0, 64);
    const newName = `${p.name} (Copy)`.slice(0, 80);
    const payload = {
      id: newId,
      name: newName,
      description: p.description,
      mode: p.mode,
      roles: p.roles,
    };
    try {
      const res = await fetch(`${serverBaseUrl}/api/custom-autos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        await loadProfiles();
        window.dispatchEvent(new CustomEvent("codeforge:custom-autos-updated"));
      } else {
        const err = await res.json().catch(() => ({}));
        setErrorMessage(err.error || "Failed to duplicate profile");
      }
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDelete = async (profileId: string) => {
    try {
      const res = await fetch(`${serverBaseUrl}/api/custom-autos/${profileId}`, {
        method: "DELETE",
      });
      if (res.ok) {
        await loadProfiles();
        window.dispatchEvent(new CustomEvent("codeforge:custom-autos-updated"));
      }
    } catch {
      // Best-effort
    }
  };

  const handleSave = async () => {
    setErrorMessage(null);
    if (!id.trim() || !name.trim() || !coderProvider.trim() || !coderModel.trim()) {
      setErrorMessage("ID, Name, and Coder Route (Provider and Model) are required.");
      return;
    }

    const roles: CustomAutoProfileView["roles"] = {
      coder: { providerId: coderProvider.trim(), modelId: coderModel.trim() },
    };
    if (plannerProvider.trim() && plannerModel.trim()) {
      roles.planner = { providerId: plannerProvider.trim(), modelId: plannerModel.trim() };
    }
    if (reviewerProvider.trim() && reviewerModel.trim()) {
      roles.reviewer = { providerId: reviewerProvider.trim(), modelId: reviewerModel.trim() };
    }
    if (verifierProvider.trim() && verifierModel.trim()) {
      roles.verifier = { providerId: verifierProvider.trim(), modelId: verifierModel.trim() };
    }

    try {
      if (editingId) {
        const res = await fetch(`${serverBaseUrl}/api/custom-autos/${editingId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name.trim(), description: description.trim() || undefined, mode, roles }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          setErrorMessage(err.error || "Failed to update profile");
          return;
        }
      } else {
        const res = await fetch(`${serverBaseUrl}/api/custom-autos`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: id.trim(), name: name.trim(), description: description.trim() || undefined, mode, roles }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          setErrorMessage(err.error || "Failed to create profile");
          return;
        }
      }
      resetForm();
      await loadProfiles();
      window.dispatchEvent(new CustomEvent("codeforge:custom-autos-updated"));
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <SettingsGroup title="My AUTOs (Custom AUTO)">
      <SettingsRow
        title={profiles.length > 0 ? `${profiles.length} Custom AUTO team${profiles.length === 1 ? "" : "s"} configured` : "No Custom AUTO teams"}
        description="Configure your own adaptive teams using personal API keys and models. Custom AUTO belongs to your private trust domain and never consumes CodeForge-managed free capacity."
        control={
          <SettingsButton onClick={() => { if (showEditor) resetForm(); else setShowEditor(true); }}>
            {showEditor ? "Cancel" : "Create Custom AUTO"}
          </SettingsButton>
        }
      />

      {showEditor && (
        <div className="settings-note" style={{ display: "flex", flexDirection: "column", gap: 10, padding: 14, marginTop: 8, background: "var(--cf-surface-secondary, rgba(255,255,255,0.03))", borderRadius: 8 }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>{editingId ? `Edit Custom AUTO: ${name}` : "Create New Custom AUTO Team"}</div>
          {errorMessage && <div style={{ color: "var(--cf-danger, #ef4444)", fontSize: 13 }}>{errorMessage}</div>}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div>
              <label style={{ fontSize: 12, opacity: 0.8, display: "block", marginBottom: 4 }}>Profile ID</label>
              <input
                type="text"
                disabled={Boolean(editingId)}
                value={id}
                onChange={(e) => setId(e.target.value.replace(/[^A-Za-z0-9_-]/g, ""))}
                placeholder="e.g. my-coding-team"
                style={{ width: "100%", padding: "6px 8px", background: "var(--cf-input-bg, #1e1e1e)", border: "1px solid var(--cf-border, #333)", color: "inherit", borderRadius: 4 }}
              />
            </div>
            <div>
              <label style={{ fontSize: 12, opacity: 0.8, display: "block", marginBottom: 4 }}>Display Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Fast Sonnet + Reviewer"
                style={{ width: "100%", padding: "6px 8px", background: "var(--cf-input-bg, #1e1e1e)", border: "1px solid var(--cf-border, #333)", color: "inherit", borderRadius: 4 }}
              />
            </div>
          </div>
          <div>
            <label style={{ fontSize: 12, opacity: 0.8, display: "block", marginBottom: 4 }}>Description</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. Claude 3.5 Sonnet for SWE coding with GPT-4o reviewer"
              style={{ width: "100%", padding: "6px 8px", background: "var(--cf-input-bg, #1e1e1e)", border: "1px solid var(--cf-border, #333)", color: "inherit", borderRadius: 4 }}
            />
          </div>
          <div style={{ borderTop: "1px solid var(--cf-border, #333)", paddingTop: 8, marginTop: 4 }}>
            <div style={{ fontWeight: 500, fontSize: 13, marginBottom: 6 }}>Specialist Roles:</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div>
                <span style={{ fontSize: 12, fontWeight: 600 }}>Coder Role (Required):</span>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 8, marginTop: 2 }}>
                  <input
                    type="text"
                    value={coderProvider}
                    onChange={(e) => setCoderProvider(e.target.value)}
                    placeholder="Provider (e.g. anthropic, openrouter)"
                    style={{ padding: "4px 8px", background: "var(--cf-input-bg, #1e1e1e)", border: "1px solid var(--cf-border, #333)", color: "inherit", borderRadius: 4 }}
                  />
                  <input
                    type="text"
                    value={coderModel}
                    onChange={(e) => setCoderModel(e.target.value)}
                    placeholder="Model ID (e.g. claude-3-5-sonnet)"
                    style={{ padding: "4px 8px", background: "var(--cf-input-bg, #1e1e1e)", border: "1px solid var(--cf-border, #333)", color: "inherit", borderRadius: 4 }}
                  />
                </div>
              </div>
              <div>
                <span style={{ fontSize: 12, fontWeight: 600 }}>Planner Role (Optional):</span>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 8, marginTop: 2 }}>
                  <input
                    type="text"
                    value={plannerProvider}
                    onChange={(e) => setPlannerProvider(e.target.value)}
                    placeholder="Provider (optional)"
                    style={{ padding: "4px 8px", background: "var(--cf-input-bg, #1e1e1e)", border: "1px solid var(--cf-border, #333)", color: "inherit", borderRadius: 4 }}
                  />
                  <input
                    type="text"
                    value={plannerModel}
                    onChange={(e) => setPlannerModel(e.target.value)}
                    placeholder="Model ID (optional)"
                    style={{ padding: "4px 8px", background: "var(--cf-input-bg, #1e1e1e)", border: "1px solid var(--cf-border, #333)", color: "inherit", borderRadius: 4 }}
                  />
                </div>
              </div>
              <div>
                <span style={{ fontSize: 12, fontWeight: 600 }}>Reviewer Role (Optional):</span>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 8, marginTop: 2 }}>
                  <input
                    type="text"
                    value={reviewerProvider}
                    onChange={(e) => setReviewerProvider(e.target.value)}
                    placeholder="Provider (optional)"
                    style={{ padding: "4px 8px", background: "var(--cf-input-bg, #1e1e1e)", border: "1px solid var(--cf-border, #333)", color: "inherit", borderRadius: 4 }}
                  />
                  <input
                    type="text"
                    value={reviewerModel}
                    onChange={(e) => setReviewerModel(e.target.value)}
                    placeholder="Model ID (optional)"
                    style={{ padding: "4px 8px", background: "var(--cf-input-bg, #1e1e1e)", border: "1px solid var(--cf-border, #333)", color: "inherit", borderRadius: 4 }}
                  />
                </div>
              </div>
              <div>
                <span style={{ fontSize: 12, fontWeight: 600 }}>Verifier Role (Optional):</span>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 8, marginTop: 2 }}>
                  <input
                    type="text"
                    value={verifierProvider}
                    onChange={(e) => setVerifierProvider(e.target.value)}
                    placeholder="Provider (optional)"
                    style={{ padding: "4px 8px", background: "var(--cf-input-bg, #1e1e1e)", border: "1px solid var(--cf-border, #333)", color: "inherit", borderRadius: 4 }}
                  />
                  <input
                    type="text"
                    value={verifierModel}
                    onChange={(e) => setVerifierModel(e.target.value)}
                    placeholder="Model ID (optional)"
                    style={{ padding: "4px 8px", background: "var(--cf-input-bg, #1e1e1e)", border: "1px solid var(--cf-border, #333)", color: "inherit", borderRadius: 4 }}
                  />
                </div>
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 8 }}>
            <SettingsButton onClick={resetForm}>Cancel</SettingsButton>
            <SettingsButton variant="primary" onClick={handleSave}>
              {editingId ? "Save Changes" : "Create Profile"}
            </SettingsButton>
          </div>
        </div>
      )}

      {profiles.length > 0 && !showEditor && (
        <div className="model-pick-list" style={{ marginTop: 8 }}>
          {profiles.map((p) => (
            <div key={p.id} className="model-pick-row" style={{ alignItems: "flex-start", padding: "10px 12px" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1 }}>
                <span className="model-pick-name" style={{ fontWeight: 600 }}>{p.name}</span>
                <span style={{ fontSize: 12, opacity: 0.7 }}>
                  Coder: {p.roles.coder.providerId}/{p.roles.coder.modelId}
                  {p.roles.planner ? ` · Planner: ${p.roles.planner.providerId}/${p.roles.planner.modelId}` : ""}
                  {p.roles.reviewer ? ` · Reviewer: ${p.roles.reviewer.providerId}/${p.roles.reviewer.modelId}` : ""}
                  {p.roles.verifier ? ` · Verifier: ${p.roles.verifier.providerId}/${p.roles.verifier.modelId}` : ""}
                </span>
                {p.description && <span style={{ fontSize: 12, opacity: 0.6 }}>{p.description}</span>}
              </div>
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <SettingsButton onClick={() => handleEdit(p)}>Edit</SettingsButton>
                <SettingsButton onClick={() => void handleDuplicate(p)}>Duplicate</SettingsButton>
                <SettingsButton variant="danger" onClick={() => void handleDelete(p.id)}>Delete</SettingsButton>
              </span>
            </div>
          ))}
        </div>
      )}
    </SettingsGroup>
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

import React, { useMemo, useState } from "react";
import { loadModelFavorites, saveModelFavorites } from "@codeforge/ui";
import { useSettings } from "../settings-context.js";
import { SettingsGroup, SettingsRow, SettingsButton, StatusBadge } from "../settings-controls.js";

/**
 * Models & Routing — organized around CodeForge's actual model architecture (ForgeAuto, the
 * free catalog, ForgeZero, favorites, GEMS), not around providers. The model list is the SAME
 * canonical catalog the composer picker uses (buildModelSections over /api/models) — there is no
 * second model list.
 */
export function ModelsRoutingSection(): React.ReactElement {
  const ctx = useSettings();
  const [picking, setPicking] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNote, setRefreshNote] = useState<string | null>(null);

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
  const routingDegraded = eligibleFreeCount === 0;
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
        optional — see Connected Providers.
      </p>

      <SettingsGroup title="Default model">
        <SettingsRow
          title={ctx.defaultModelId === "auto" ? "ForgeAuto/Free" : defaultModel?.displayName ?? ctx.defaultModelId}
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
          description="If the top-ranked route fails, ForgeAuto falls back to the next eligible verified-free alternative. Paid models are never a fallback."
          control={<StatusBadge kind="ok">Enabled</StatusBadge>}
        />
      </SettingsGroup>

      <SettingsGroup title="8-Bit free catalog">
        <SettingsRow
          title="Qualified free models"
          description={`${freeCount} CodeForge Free models listed · ${verifiedFreeCount} verified-free records · ${eligibleFreeCount} executable now${gemsCount ? ` · ${gemsCount} GEMS` : ""}.`}
          control={<StatusBadge kind={eligibleFreeCount > 0 ? "ok" : "warn"}>{eligibleFreeCount > 0 ? "Healthy" : "Unavailable"}</StatusBadge>}
        />
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

import React, { useState, useEffect, useCallback, useMemo } from "react";
import type { Project } from "./App.js";
import { WorkspaceApp, type ModelSelectorItem, type ModelSection } from "@codeforge/ui";
import ModelDetails from "./ModelDetails.js";
import ProviderSetup from "./ProviderSetup.js";

interface WorkspaceShellProps {
  project: Project;
  onClose: () => void;
}

const SERVER_BASE_URL = "http://localhost:3210";
const HELP_URL = "https://github.com/Forger-Digital-Solutions/CodeForge";

function openExternalLink(url: string): void {
  const api = (globalThis as { electronAPI?: { openExternal?: (u: string) => Promise<void> } }).electronAPI;
  if (api?.openExternal) {
    void api.openExternal(url);
  } else {
    window.open(url, "_blank", "noopener");
  }
}

interface ApiModel {
  id: string;
  providerId: string;
  displayName: string;
  tier: "free" | "gems_paid" | "paid";
  freeStatus: string;
  contextWindow?: number;
  capabilities?: {
    text: boolean;
    coding: boolean;
    toolCalling: boolean;
    vision: boolean;
    structuredOutput: boolean;
    longContext: boolean;
  };
  costProfile?: {
    inputCostPerMillion: number;
    outputCostPerMillion: number;
    isFree: boolean;
    paidFallbackPossible: boolean;
  };
  isPromotional?: boolean;
}

// Models hidden from the user-facing selector. Muse Spark is a third-party
// promotional free model — CodeForge still routes to it under "Auto · Best
// Verified Free", but it is never advertised as its own selectable/hero row.
const HIDDEN_MODEL_RE = /muse[-\s]?spark/i;

// The provider groups CodeForge presents. Anthropic / OpenAI / Z.AI appear even
// with no runtime model yet, shown honestly as "not connected" rather than
// hidden or faked as available.
const PLACEHOLDER_PROVIDER_SECTIONS: ModelSection[] = [
  { sectionId: "anthropic", sectionLabel: "ANTHROPIC", models: [], note: "Not connected · BYOK coming soon" },
  { sectionId: "openai", sectionLabel: "OPENAI", models: [], note: "Not connected · integration coming soon" },
  { sectionId: "zai", sectionLabel: "Z.AI", models: [], note: "Not connected · integration coming soon" },
];

// Map a real catalog model to a user-facing section, or null to hide it.
function catalogSectionFor(providerId: string, tier: string): string | null {
  if (providerId === "codeforge") return tier === "gems_paid" ? "GEMS" : "VERIFIED FREE";
  if (providerId === "anthropic") return "ANTHROPIC";
  if (providerId === "openai") return "OPENAI";
  if (providerId === "zai") return "Z.AI";
  return null; // opencode / openrouter (Muse Spark) are hidden from the selector
}

const SECTION_ORDER = ["CODEFORGE", "VERIFIED FREE", "GEMS", "ANTHROPIC", "OPENAI", "Z.AI"];
function getSectionOrder(sectionLabel: string): number {
  const idx = SECTION_ORDER.indexOf(sectionLabel);
  return idx === -1 ? 99 : idx;
}

function isHiddenModel(id: string): boolean {
  return HIDDEN_MODEL_RE.test(id);
}

export default function WorkspaceShell({ project, onClose }: WorkspaceShellProps) {
  const [models, setModels] = useState<ModelSelectorItem[]>([
    { id: "auto", displayName: "Auto", tier: "free", description: "Best Verified Free Model" },
  ]);
  const [selectedModelId, setSelectedModelId] = useState<string | null>("auto");
  const [modelProviders, setModelProviders] = useState<Record<string, string>>({});
  const [apiModels, setApiModels] = useState<ApiModel[]>([]);
  const [showModelDetails, setShowModelDetails] = useState(false);
  const [selectedModelForDetails, setSelectedModelForDetails] = useState<ApiModel | null>(null);
  const [providerStatus, setProviderStatus] = useState<Record<string, { status: string; error?: string }>>({});
  const [providerRefreshKey, setProviderRefreshKey] = useState(0);
  const [isForgeZeroOpen, setIsForgeZeroOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  useEffect(() => {
    fetch(`${SERVER_BASE_URL}/api/workspace/set`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: project.path }),
    }).catch(() => {
      // Server may still be starting; workspace tools fail closed until set succeeds
    });
  }, [project.path]);

  const refreshModelsAndHealth = useCallback(async () => {
    try {
      const response = await fetch(`${SERVER_BASE_URL}/api/models`);
      if (!response.ok) throw new Error(`models request failed: ${response.status}`);
      const data = (await response.json()) as ApiModel[];
      if (!Array.isArray(data)) return;
      setApiModels(data);

      // Build the user-facing model list. Muse Spark (promotional third-party
      // free model) is filtered out here — "Auto" still routes to it, but it is
      // never surfaced as its own selectable/hero row.
      const visible = data.filter((m) => !isHiddenModel(m.id));
      const modelItems: ModelSelectorItem[] = [
        { id: "auto", displayName: "Auto", tier: "free", description: "Best Verified Free" },
        ...visible.map((m) => ({
          id: m.id,
          displayName: m.displayName,
          tier: m.tier === "paid" ? ("gems_paid" as const) : m.tier,
          description: m.costProfile?.isFree ? "Free" : undefined,
        })),
      ];
      setModels(modelItems);
      setModelProviders(Object.fromEntries(data.map((m) => [m.id, m.providerId])));

      const uniqueProviders = [...new Set(data.map((m) => m.providerId))];
      for (const providerId of uniqueProviders) {
        try {
          const res = await fetch(`${SERVER_BASE_URL}/api/providers/${providerId}/health`);
          const health = await res.json();
          setProviderStatus((prev) => ({ ...prev, [providerId]: health }));
        } catch {
          // ignore
        }
      }
    } catch {
      // Selector falls back to Auto; server may still be starting
    }
  }, []);

  useEffect(() => {
    refreshModelsAndHealth();
  }, [refreshModelsAndHealth, providerRefreshKey]);

  useEffect(() => {
    const onFocus = () => refreshModelsAndHealth();
    const onVisibility = () => {
      if (document.visibilityState === "visible") refreshModelsAndHealth();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    const onProviderUpdate = () => setProviderRefreshKey((k) => k + 1);
    window.addEventListener("codeforge:provider-updated", onProviderUpdate as EventListener);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("codeforge:provider-updated", onProviderUpdate as EventListener);
    };
  }, [refreshModelsAndHealth]);

  // Group models into user-facing sections for the ModelSelector.
  const modelSections = useMemo((): ModelSection[] => {
    const sectionMap = new Map<string, ModelSelectorItem[]>();
    sectionMap.set("CODEFORGE", []);

    for (const model of models) {
      if (model.id === "auto") {
        sectionMap.get("CODEFORGE")!.push(model);
        continue;
      }
      const apiModel = apiModels.find((m) => m.id === model.id);
      const providerId = apiModel?.providerId ?? modelProviders[model.id] ?? "";
      const tier = apiModel?.tier ?? model.tier;
      const sectionLabel = catalogSectionFor(providerId, tier);
      if (!sectionLabel) continue; // hidden from user-facing selector
      if (!sectionMap.has(sectionLabel)) sectionMap.set(sectionLabel, []);
      sectionMap.get(sectionLabel)!.push(model);
    }

    const catalogSections: ModelSection[] = Array.from(sectionMap.entries())
      .filter(([, sectionModels]) => sectionModels.length > 0)
      .map(([sectionLabel, sectionModels]) => ({
        sectionId: sectionLabel.toLowerCase().replace(/\s+/g, "-"),
        sectionLabel,
        models: sectionModels,
      }));

    // Present provider groups that have no runtime model yet as honest,
    // non-selectable "not connected" sections instead of hiding them.
    const present = new Set(catalogSections.map((s) => s.sectionLabel));
    const placeholders = PLACEHOLDER_PROVIDER_SECTIONS.filter((s) => !present.has(s.sectionLabel));

    return [...catalogSections, ...placeholders].sort(
      (a, b) => getSectionOrder(a.sectionLabel) - getSectionOrder(b.sectionLabel),
    );
  }, [models, apiModels, modelProviders]);

  const handleSelectModel = useCallback(
    (model: ModelSelectorItem) => {
      setSelectedModelId(model.id);
      fetch(`${SERVER_BASE_URL}/api/model-selection`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "default",
          modelId: model.id,
          providerId: modelProviders[model.id] ?? "",
        }),
      })
        .then((response) => {
          if (!response.ok) {
            response
              .json()
              .then((data) => {
                const errorCode = data.error || "MODEL_SELECTION_FAILED";
                const userMessages: Record<string, string> = {
                  MODEL_NOT_FOUND: "The selected model is no longer available. Please select a different model.",
                  MODEL_SELECTION_INVALID: "Invalid model selection. Please try again.",
                  NO_FREE_PROVIDER:
                    "No verified free model is currently available. Connect a provider with free models.",
                  FREE_TIER_EXPIRED:
                    "This promotional free model is no longer verified as free. Please select a different model.",
                  CREDENTIAL_MISSING: "Provider API key is missing. Please configure credentials.",
                  CREDENTIAL_INVALID: "Provider API key is invalid. Please check your credentials.",
                  AUTH_ERROR: "Provider authentication failed. Check your API key.",
                  PROVIDER_OFFLINE: "Provider is currently unavailable. Please try again.",
                  PAYMENT_REQUIRED:
                    "Paid model selected while in Free Mode — CodeForge blocked the request.",
                  RATE_LIMITED: "Provider is rate limited. Try again shortly.",
                };
                alert(userMessages[errorCode] || "Failed to select model. Please try again.");
              })
              .catch(() => {
                alert("Failed to select model. Please try again.");
              });
            setSelectedModelId("auto");
          }
        })
        .catch(() => {
          alert("Network error — please check your connection.");
          setSelectedModelId("auto");
        });
    },
    [modelProviders],
  );

  const handleUpgradeNavigation = useCallback((url: string) => {
    openExternalLink(url);
  }, []);

  const handleShowModelDetails = useCallback((model: ModelSelectorItem) => {
    const apiModel = apiModels.find(m => m.id === model.id);
    if (apiModel) {
      setSelectedModelForDetails(apiModel);
      setShowModelDetails(true);
    }
  }, [apiModels]);

  const handleCloseModelDetails = useCallback(() => {
    setShowModelDetails(false);
    setSelectedModelForDetails(null);
  }, []);

  const getCurrentProviderStatus = () => {
    const selected = apiModels.find((m) => m.id === selectedModelId);
    const providerId = selected ? selected.providerId : modelProviders[selectedModelId || ""];
    const health = providerId ? providerStatus[providerId] : undefined;

    if (selectedModelId === "auto") {
      const anyError = Object.values(providerStatus).some((h) => h.status === "error");
      if (anyError) return { status: "auto", text: "Auto", detail: "Best Verified Free", error: true };
      return { status: "auto", text: "Auto", detail: "Best Verified Free" };
    }
    if (!providerId) return { status: "unknown", text: "Unknown" };
    const freeLabel = selected?.costProfile?.isFree || selected?.isPromotional ? "Free" : selected?.tier === "paid" || selected?.tier === "gems_paid" ? "Paid" : "Unknown";
    const promo = selected?.isPromotional ? " · Promotional" : "";
    const detail = `${freeLabel}${promo}`;
    if (health?.status === "available") return { status: "connected", text: "Connected", detail };
    if (health?.status === "error") return { status: "error", text: "Error", detail: health.error || detail };
    return { status: "unknown", text: providerId, detail };
  };

  const currentStatus = getCurrentProviderStatus();

  return (
    <div className="workspace-shell">
      <header className="workspace-shell-header">
        <div className="header-left">
          <button className="header-back" onClick={onClose} title="Back to projects">
            ←
          </button>
          <div className="header-project">
            <span className="project-name">{project.name}</span>
            <span className="project-path">{project.path}</span>
          </div>
        </div>

        <div className="header-right">
          <div
            className="forgezero-indicator"
            role="button"
            tabIndex={0}
            onClick={() => setIsForgeZeroOpen(!isForgeZeroOpen)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setIsForgeZeroOpen((v) => !v);
              }
            }}
            aria-expanded={isForgeZeroOpen}
            title="ForgeZero Trust Status"
          >
            <span className="forgezero-icon" aria-hidden="true">◈</span>
            <span>ForgeZero · Verified Free</span>
            {isForgeZeroOpen && (
              <>
                <div
                  style={{ position: "fixed", inset: 0, zIndex: 199, cursor: "default" }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setIsForgeZeroOpen(false);
                  }}
                />
                <div className="forgezero-popover" onClick={(e) => e.stopPropagation()}>
                  <div className="forgezero-popover-title">ForgeZero Trust Status</div>
                  <div className="forgezero-popover-row">
                    <span className="forgezero-popover-icon">✓</span>
                    <span className="forgezero-popover-label">Provider: {currentStatus.text}</span>
                  </div>
                  <div className="forgezero-popover-row">
                    <span className="forgezero-popover-icon">✓</span>
                    <span className="forgezero-popover-label">Zero Billing · Verified Free</span>
                  </div>
                  <div className="forgezero-popover-row">
                    <span className="forgezero-popover-icon">✓</span>
                    <span className="forgezero-popover-label">Workspace Boundary Isolated</span>
                  </div>
                  <div className="forgezero-popover-row">
                    <span className="forgezero-popover-icon">✓</span>
                    <span className="forgezero-popover-label">Secrets Redaction Active</span>
                  </div>
                  <div className="forgezero-popover-row">
                    <span className="forgezero-popover-icon">✓</span>
                    <span className="forgezero-popover-label">Safety Timeout Enforced</span>
                  </div>
                </div>
              </>
            )}
          </div>
          <button
            className="header-btn"
            title="Help & documentation"
            aria-label="Help and documentation"
            onClick={() => openExternalLink(HELP_URL)}
          >
            ?
          </button>
        </div>
      </header>

      <main className="workspace-shell-main">
        <WorkspaceApp
          sseUrl={`${SERVER_BASE_URL}/api/events`}
          models={models}
          selectedModelId={selectedModelId}
          onSelectModel={handleSelectModel}
          onShowModelDetails={handleShowModelDetails}
          onUpgradeNavigation={handleUpgradeNavigation}
          modelSections={modelSections}
          projectName={project.name}
          onOpenProjects={onClose}
          onOpenSettings={() => setIsSettingsOpen(true)}
          onOpenHelp={() => openExternalLink(HELP_URL)}
        />
      </main>

      {showModelDetails && selectedModelForDetails && (
        <ModelDetails
          model={selectedModelForDetails}
          onClose={handleCloseModelDetails}
        />
      )}

      {isSettingsOpen && (
        <div className="settings-modal-overlay" onClick={() => setIsSettingsOpen(false)}>
          <div
            className="settings-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Settings"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="settings-modal-header">
              <span className="settings-modal-title">Settings</span>
              <button
                className="settings-modal-close"
                onClick={() => setIsSettingsOpen(false)}
                aria-label="Close settings"
              >
                ×
              </button>
            </div>
            <div className="settings-modal-body">
              <ProviderSetup />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

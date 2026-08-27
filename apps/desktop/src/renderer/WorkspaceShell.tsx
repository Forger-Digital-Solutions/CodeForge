import React, { useState, useEffect, useCallback } from "react";
import type { Project } from "./App.js";
import { ModelSelector, WorkspaceApp, type ModelSelectorItem } from "@codeforge/ui";
import ModelDetails from "./ModelDetails.js";

interface WorkspaceShellProps {
  project: Project;
  onClose: () => void;
}

const SERVER_BASE_URL = "http://localhost:3210";

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
      setModels([
        { id: "auto", displayName: "Auto", tier: "free", description: "Best Verified Free Model" },
        ...data.map((m) => ({
          id: m.id,
          displayName: m.displayName,
          tier: m.tier === "paid" ? ("gems_paid" as const) : m.tier,
          description: m.isPromotional ? "Promotional Free" : m.costProfile?.isFree ? "Free" : undefined,
        })),
      ]);
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

  // Unentitled GEMS models never execute inference; they navigate to the
  // centralized upgrade URL instead. In Electron this goes through the
  // main-process shell; in a plain browser it opens a new tab.
  const handleUpgradeNavigation = useCallback((url: string) => {
    const api = (globalThis as any).electronAPI;
    if (api?.openExternal) {
      void api.openExternal(url);
    } else {
      (globalThis as any).window?.open(url, "_blank", "noopener");
    }
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
  const selectedApiModel = apiModels.find((m) => m.id === selectedModelId);

  return (
    <div className="workspace-shell">
      <header className="workspace-shell-header">
        <div className="header-left">
          <button className="header-back" onClick={onClose} title="Back to projects">
            ←
          </button>
          <div className="header-project">
            <span className="project-icon">📁</span>
            <span className="project-name">{project.name}</span>
            <span className="project-path">{project.path}</span>
          </div>
        </div>
        <div className="header-center">
          <h1 className="header-title">CodeForge</h1>
        </div>
        <div className="header-right">
          <div
            className="provider-status-indicator"
            role="status"
            aria-live="polite"
            title={
              selectedApiModel
                ? `${selectedApiModel.displayName} · ${currentStatus.detail}`
                : currentStatus.detail || currentStatus.text
            }
          >
            <span className={`provider-status-dot ${currentStatus.status}`} aria-hidden="true"></span>
            <span className="provider-status-text">{currentStatus.text}</span>
            {currentStatus.detail && (
              <span className="provider-status-detail" style={{ opacity: 0.7, fontSize: "10px" }}>
                {currentStatus.detail}
              </span>
            )}
            {selectedModelId === "auto" && (
              <span className="provider-status-mode" style={{ fontSize: "10px" }}>
                Auto
              </span>
            )}
          </div>
          <ModelSelector
            models={models}
            selectedId={selectedModelId}
            onSelect={handleSelectModel}
            onUpgradeNavigation={handleUpgradeNavigation}
            onShowDetails={handleShowModelDetails}
          />
          <button className="header-btn" title="Help" aria-label="Help">
            ?
          </button>
        </div>
      </header>

      <main className="workspace-shell-main">
        <WorkspaceApp sseUrl={`${SERVER_BASE_URL}/api/events`} />
      </main>

      {showModelDetails && selectedModelForDetails && (
        <ModelDetails
          model={selectedModelForDetails}
          onClose={handleCloseModelDetails}
        />
      )}
    </div>
  );
}

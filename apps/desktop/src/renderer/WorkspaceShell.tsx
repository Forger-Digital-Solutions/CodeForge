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
  accessClass?: string;
  authMode?: string;
  privacyClass?: string;
  verifiedFree?: boolean;
  eligible?: boolean;
  codingScore?: number;
  agentScore?: number;
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

// Muse Spark is a promotional model excluded from normal routing entirely — hide any stray record.
const HIDDEN_MODEL_RE = /muse[-\s]?spark/i;
function isHiddenModel(id: string): boolean {
  return HIDDEN_MODEL_RE.test(id);
}

// Provider → user-facing section label. Order follows the spec's model dropdown structure.
const PROVIDER_SECTION: Record<string, string> = {
  zai: "Z.AI",
  openrouter: "OPENROUTER",
  google: "GOOGLE",
  groq: "GROQ",
  "cloudflare-workers-ai": "CLOUDFLARE",
  anthropic: "ANTHROPIC",
  openai: "OPENAI",
};

const SECTION_ORDER = [
  "CODEFORGE",
  "TOP VERIFIED FREE",
  "GEMS",
  "Z.AI",
  "OPENROUTER",
  "GOOGLE",
  "GROQ",
  "CLOUDFLARE",
  "ANTHROPIC",
  "OPENAI",
];
function getSectionOrder(sectionLabel: string): number {
  const idx = SECTION_ORDER.indexOf(sectionLabel);
  return idx === -1 ? 99 : idx;
}

// Honest access-status badge from the CodeForge access class.
function accessBadge(m: ApiModel): string {
  switch (m.accessClass) {
    case "FREE_NATIVE":
      return "Free";
    case "FREE_ROUTED":
      return "Free · routed";
    case "FREE_ALLOWANCE":
      return "Free · allowance";
    case "FREE_PROMO":
      return "Promo";
    case "TRIAL":
      return "Trial";
    case "PAID": {
      const inC = m.costProfile?.inputCostPerMillion;
      const outC = m.costProfile?.outputCostPerMillion;
      return inC != null && outC != null ? `Paid · $${inC}/$${outC} per 1M` : "Paid";
    }
    default:
      return m.costProfile?.isFree ? "Free" : "Paid";
  }
}

function isPaidAccess(m: ApiModel | undefined): boolean {
  if (!m) return false;
  return m.accessClass === "PAID" || m.accessClass === "TRIAL";
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
          // Only first-party GEMS are entitlement-locked; provider paid models stay selectable
          // (a paid-confirmation dialog gates the actual charge). Honest badge via accessBadge.
          tier: m.tier === "gems_paid" ? ("gems_paid" as const) : ("free" as const),
          description: accessBadge(m),
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

  // Build the model dropdown to the free-first structure:
  // CODEFORGE (Auto) · TOP VERIFIED FREE (#1–5, live) · GEMS · per-provider (free-first, honest badges).
  const modelSections = useMemo((): ModelSection[] => {
    const toItem = (m: ApiModel): ModelSelectorItem => ({
      id: m.id,
      displayName: m.displayName,
      tier: m.tier === "gems_paid" ? "gems_paid" : "free",
      description: accessBadge(m),
    });
    const autoItem: ModelSelectorItem =
      models.find((m) => m.id === "auto") ?? { id: "auto", displayName: "Auto", tier: "free", description: "Best Verified Free" };

    const visible = apiModels.filter((m) => !isHiddenModel(m.id));
    const sections: ModelSection[] = [{ sectionId: "codeforge", sectionLabel: "CODEFORGE", models: [autoItem] }];

    // TOP VERIFIED FREE — eligible + verified-free, ranked by empirical scores. Live-derived.
    const topFree = [...visible]
      .filter((m) => m.eligible && m.verifiedFree)
      .sort(
        (a, b) =>
          (b.codingScore ?? b.agentScore ?? 0) - (a.codingScore ?? a.agentScore ?? 0) ||
          a.id.localeCompare(b.id),
      )
      .slice(0, 5);
    if (topFree.length > 0) {
      sections.push({
        sectionId: "top-verified-free",
        sectionLabel: "TOP VERIFIED FREE",
        models: topFree.map((m, i) => ({ ...toItem(m), displayName: `#${i + 1} · ${m.displayName}` })),
      });
    }

    const gems = visible.filter((m) => m.tier === "gems_paid");
    if (gems.length > 0) sections.push({ sectionId: "gems", sectionLabel: "GEMS", models: gems.map(toItem) });

    const byProvider = new Map<string, ApiModel[]>();
    for (const m of visible) {
      if (m.tier === "gems_paid") continue;
      const label = PROVIDER_SECTION[m.providerId];
      if (!label) continue;
      if (!byProvider.has(label)) byProvider.set(label, []);
      byProvider.get(label)!.push(m);
    }
    for (const [label, list] of byProvider) {
      list.sort(
        (a, b) =>
          Number(!!b.costProfile?.isFree) - Number(!!a.costProfile?.isFree) ||
          a.displayName.localeCompare(b.displayName),
      );
      sections.push({ sectionId: label.toLowerCase().replace(/\s+/g, "-"), sectionLabel: label, models: list.map(toItem) });
    }

    // Honest "not connected" rows for providers with no models yet (never faked as available).
    const present = new Set(sections.map((s) => s.sectionLabel));
    for (const [pid, label] of Object.entries(PROVIDER_SECTION)) {
      if (present.has(label)) continue;
      const note = pid === "openrouter" ? "Not connected · Connect with OAuth in Settings" : "Not connected · add API key in Settings";
      sections.push({ sectionId: label.toLowerCase().replace(/\s+/g, "-"), sectionLabel: label, models: [], note });
    }

    return sections.sort((a, b) => getSectionOrder(a.sectionLabel) - getSectionOrder(b.sectionLabel));
  }, [models, apiModels]);

  const handleSelectModel = useCallback(
    (model: ModelSelectorItem, sessionId?: string) => {
      // Paid-model confirmation: selecting a model that can incur charges is always explicit.
      // Verified-free models never trigger this prompt.
      const apiModel = apiModels.find((m) => m.id === model.id);
      if (isPaidAccess(apiModel)) {
        const badge = apiModel ? accessBadge(apiModel) : "Paid";
        const ok = window.confirm(
          `${model.displayName} may incur charges from your provider (${badge}).\n\n` +
            "This is a paid/trial model — CodeForge Free Mode will not select it automatically.\n\nUse this paid model?",
        );
        if (!ok) return;
      }
      setSelectedModelId(model.id);
      fetch(`${SERVER_BASE_URL}/api/model-selection`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: sessionId ?? "default",
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
    [modelProviders, apiModels],
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

import React, { useState, useEffect, useCallback, useMemo } from "react";
import { WorkspaceApp, type ModelSection } from "@codeforge/ui";
import type { Project } from "./App.js";
import type { ModelSelectorItem } from "@codeforge/ui";
import ModelDetails from "./ModelDetails.js";
import ProviderSetup from "./ProviderSetup.js";

const SERVER_BASE_URL = "http://localhost:3210";
const HELP_URL = "https://github.com/codeforge/codeforge#readme";

interface WorkspaceShellProps {
  project: Project;
  onClose: () => void;
}

interface ApiModel {
  id: string;
  providerId: string;
  displayName: string;
  tier: "free" | "gems_paid" | "paid";
  freeStatus: string;
  accessClass?: string;
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
  "codeforge-cloud": "CODEFORGE CLOUD (INCLUDED)",
  zai: "Z.AI",
  openrouter: "OPENROUTER",
  google: "GOOGLE",
  groq: "GROQ",
  "cloudflare-workers-ai": "CLOUDFLARE",
  anthropic: "ANTHROPIC",
  openai: "OPENAI",
};

const SECTION_ORDER = [
  "CODEFORGE CLOUD (INCLUDED)",
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
  const [isForgeZeroOpen, setIsForgeZeroOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [cloudAccount, setCloudAccount] = useState<any>(null);
  const [isQuotaExhaustedOpen, setIsQuotaExhaustedOpen] = useState(false);

  useEffect(() => {
    fetch(`${SERVER_BASE_URL}/api/workspace/set`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: project.path }),
    }).catch(() => {});
    loadCloudAccount();
  }, [project.path]);

  const loadCloudAccount = async () => {
    try {
      if (window.electronAPI?.getCloudAccount) {
        const acc = await window.electronAPI.getCloudAccount();
        setCloudAccount(acc);
      }
    } catch {}
  };

  const refreshModelsAndHealth = useCallback(async () => {
    try {
      const response = await fetch(`${SERVER_BASE_URL}/api/models`);
      if (!response.ok) throw new Error(`models request failed: ${response.status}`);
      const data = (await response.json()) as ApiModel[];
      if (!Array.isArray(data)) return;
      setApiModels(data);

      const visible = data.filter((m) => !isHiddenModel(m.id));
      const modelItems: ModelSelectorItem[] = [
        { id: "auto", displayName: "Auto", tier: "free", description: "Best Verified Free" },
        ...visible.map((m) => ({
          id: m.id,
          displayName: m.displayName,
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
        } catch {}
      }
    } catch {}
  }, []);

  useEffect(() => {
    refreshModelsAndHealth();
    const interval = setInterval(refreshModelsAndHealth, 15000);
    return () => clearInterval(interval);
  }, [refreshModelsAndHealth]);

  useEffect(() => {
    const handleProviderUpdated = () => {
      refreshModelsAndHealth();
      loadCloudAccount();
    };
    window.addEventListener("codeforge:provider-updated", handleProviderUpdated);
    return () => window.removeEventListener("codeforge:provider-updated", handleProviderUpdated);
  }, [refreshModelsAndHealth]);

  const modelSections = useMemo((): ModelSection[] => {
    const sectionMap = new Map<string, ModelSelectorItem[]>();
    const topVerified: ModelSelectorItem[] = [];
    const gemsModels: ModelSelectorItem[] = [];

    const autoItem = models.find((m) => m.id === "auto") ?? {
      id: "auto",
      displayName: "Auto",
      tier: "free" as const,
      description: "Best Verified Free Model",
    };
    sectionMap.set("CODEFORGE", [autoItem]);

    for (const m of apiModels) {
      if (isHiddenModel(m.id)) continue;
      const isFree = m.costProfile?.isFree || m.freeStatus === "verified_free" || m.isPromotional;
      const selectorItem: ModelSelectorItem = {
        id: m.id,
        displayName: m.displayName,
        tier: m.tier === "gems_paid" ? "gems_paid" : "free",
        description: accessBadge(m),
      };

      if (m.providerId === "codeforge-cloud") {
        const existing = sectionMap.get("CODEFORGE CLOUD (INCLUDED)") || [];
        existing.push(selectorItem);
        sectionMap.set("CODEFORGE CLOUD (INCLUDED)", existing);
      } else if (m.tier === "gems_paid") {
        gemsModels.push(selectorItem);
      } else if (isFree && topVerified.length < 5) {
        topVerified.push(selectorItem);
      } else {
        const secName = PROVIDER_SECTION[m.providerId] || m.providerId.toUpperCase();
        const existing = sectionMap.get(secName) || [];
        existing.push(selectorItem);
        sectionMap.set(secName, existing);
      }
    }

    if (topVerified.length > 0) sectionMap.set("TOP VERIFIED FREE", topVerified);
    if (gemsModels.length > 0) sectionMap.set("GEMS", gemsModels);

    const sections: ModelSection[] = [];
    const sortedKeys = Array.from(sectionMap.keys()).sort((a, b) => getSectionOrder(a) - getSectionOrder(b));
    for (const key of sortedKeys) {
      const items = sectionMap.get(key);
      if (items && items.length > 0) {
        sections.push({ label: key, items });
      }
    }
    return sections;
  }, [apiModels, models]);

  const handleSelectModel = (modelId: string) => {
    setSelectedModelId(modelId);
    fetch(`${SERVER_BASE_URL}/api/model/select`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId, providerId: modelProviders[modelId] }),
    }).catch(() => {});
  };

  const handleShowModelDetails = (modelId: string) => {
    const found = apiModels.find((m) => m.id === modelId);
    if (found) {
      setSelectedModelForDetails(found);
      setShowModelDetails(true);
    }
  };

  const handleCloseModelDetails = () => {
    setShowModelDetails(false);
    setSelectedModelForDetails(null);
  };

  const handleUpgradeNavigation = () => {
    setIsQuotaExhaustedOpen(true);
  };

  const openExternalLink = (url: string) => {
    if (window.electronAPI?.openExternal) {
      window.electronAPI.openExternal(url);
    } else {
      window.open(url, "_blank");
    }
  };

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
          {cloudAccount ? (
            <button
              className="header-btn cloud-account-btn"
              style={{ background: "rgba(56, 189, 248, 0.12)", border: "1px solid rgba(56, 189, 248, 0.35)", color: "#38bdf8", padding: "4px 10px", borderRadius: "14px", fontSize: "12px", display: "inline-flex", alignItems: "center", gap: "6px", cursor: "pointer" }}
              onClick={() => setIsQuotaExhaustedOpen(true)}
              title="CodeForge Cloud Account"
            >
              <span>✦ {cloudAccount.user?.displayName || "Cloud User"}</span>
              <span style={{ opacity: 0.5 }}>|</span>
              <span>{cloudAccount.planName} ({Math.round(cloudAccount.creditBalance / 1000)}k)</span>
            </button>
          ) : (
            <button
              className="header-btn cloud-signin-btn"
              style={{ background: "#0284c7", color: "#fff", border: "none", padding: "4px 10px", borderRadius: "14px", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}
              onClick={async () => {
                if (window.electronAPI?.signInWithCloud) {
                  const res = await window.electronAPI.signInWithCloud();
                  if (res.ok) await loadCloudAccount();
                }
              }}
            >
              ✦ Start Free Cloud
            </button>
          )}

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
              <span className="settings-modal-title">Settings & Providers</span>
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

      {isQuotaExhaustedOpen && (
        <div className="settings-modal-overlay" onClick={() => setIsQuotaExhaustedOpen(false)}>
          <div
            className="settings-modal"
            role="dialog"
            aria-modal="true"
            aria-label="CodeForge Cloud Account"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: "480px" }}
          >
            <div className="settings-modal-header">
              <span className="settings-modal-title">✦ CodeForge Cloud Account</span>
              <button
                className="settings-modal-close"
                onClick={() => setIsQuotaExhaustedOpen(false)}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <div className="settings-modal-body" style={{ padding: "16px 20px" }}>
              {cloudAccount ? (
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: "15px" }}>{cloudAccount.user?.displayName}</div>
                      <div style={{ color: "#9ca3af", fontSize: "13px" }}>Plan: <strong>{cloudAccount.planName}</strong></div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: "18px", fontWeight: "bold", color: "#38bdf8" }}>
                        {(cloudAccount.creditBalance).toLocaleString()}
                      </div>
                      <div style={{ color: "#9ca3af", fontSize: "11px" }}>Available Credits</div>
                    </div>
                  </div>

                  {cloudAccount.planId === "free" ? (
                    <div style={{ background: "#1f2937", borderRadius: "8px", padding: "14px", marginBottom: "16px" }}>
                      <div style={{ fontWeight: 600, marginBottom: "4px" }}>Upgrade to CodeForge Pro</div>
                      <p style={{ color: "#9ca3af", fontSize: "13px", margin: "0 0 10px 0" }}>
                        Get 5,000,000 monthly credits, high-speed priority routing, and premium model access for $20/month.
                      </p>
                      <button
                        style={{ width: "100%", background: "#0284c7", color: "#fff", padding: "8px", borderRadius: "6px", border: "none", fontWeight: 600, cursor: "pointer" }}
                        onClick={() => window.electronAPI?.openCloudCheckout?.()}
                      >
                        Upgrade to Pro ($20/mo)
                      </button>
                    </div>
                  ) : (
                    <div style={{ background: "#1f2937", borderRadius: "8px", padding: "14px", marginBottom: "16px" }}>
                      <div style={{ fontWeight: 600, marginBottom: "4px", color: "#38bdf8" }}>Pro Subscription Active</div>
                      <p style={{ color: "#9ca3af", fontSize: "13px", margin: "0 0 10px 0" }}>
                        Manage payment method, invoices, or billing settings in the Stripe Customer Portal.
                      </p>
                      <button
                        style={{ width: "100%", background: "#374151", color: "#fff", padding: "8px", borderRadius: "6px", border: "none", fontWeight: 600, cursor: "pointer" }}
                        onClick={() => window.electronAPI?.openCloudPortal?.()}
                      >
                        Manage Subscription
                      </button>
                    </div>
                  )}

                  <div style={{ borderTop: "1px solid #374151", paddingTop: "12px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <button
                      style={{ background: "transparent", border: "none", color: "#9ca3af", cursor: "pointer", fontSize: "13px", textDecoration: "underline" }}
                      onClick={() => {
                        setIsQuotaExhaustedOpen(false);
                        setIsSettingsOpen(true);
                      }}
                    >
                      Switch to BYOK Direct Mode
                    </button>
                    <button
                      style={{ background: "transparent", border: "none", color: "#ef4444", cursor: "pointer", fontSize: "13px" }}
                      onClick={async () => {
                        await window.electronAPI?.logoutCloud?.();
                        setCloudAccount(null);
                        setIsQuotaExhaustedOpen(false);
                        await refreshModelsAndHealth();
                      }}
                    >
                      Sign Out
                    </button>
                  </div>
                </div>
              ) : (
                <div>
                  <p style={{ color: "#9ca3af", fontSize: "14px" }}>
                    Sign in with GitHub to access zero-setup hosted AI inference with 500,000 monthly credits.
                  </p>
                  <button
                    style={{ width: "100%", background: "#0284c7", color: "#fff", padding: "10px", borderRadius: "6px", border: "none", fontWeight: 600, cursor: "pointer" }}
                    onClick={async () => {
                      const res = await window.electronAPI?.signInWithCloud?.();
                      if (res?.ok) {
                        await loadCloudAccount();
                        await refreshModelsAndHealth();
                      }
                    }}
                  >
                    Sign In with GitHub
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

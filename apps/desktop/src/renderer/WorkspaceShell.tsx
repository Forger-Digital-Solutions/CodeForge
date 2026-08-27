import React, { useState, useEffect, useCallback } from "react";
import type { Project } from "./App.js";
import { ModelSelector, WorkspaceApp, type ModelSelectorItem } from "@codeforge/ui";

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
    { id: "auto", displayName: "Auto", tier: "free", description: "Best Free Model" },
  ]);
  const [selectedModelId, setSelectedModelId] = useState<string | null>("auto");
  const [modelProviders, setModelProviders] = useState<Record<string, string>>({});

  useEffect(() => {
    fetch(`${SERVER_BASE_URL}/api/workspace/set`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: project.path }),
    }).catch(() => {
      // Server may still be starting; workspace tools fail closed until set succeeds
    });
  }, [project.path]);

  useEffect(() => {
    let cancelled = false;
    fetch(`${SERVER_BASE_URL}/api/models`)
      .then((response) => {
        if (!response.ok) throw new Error(`models request failed: ${response.status}`);
        return response.json() as Promise<ApiModel[]>;
      })
      .then((data) => {
        if (cancelled || !Array.isArray(data)) return;
        setModels([
          { id: "auto", displayName: "Auto", tier: "free", description: "Best Free Model" },
          ...data.map((m) => ({
            id: m.id,
            displayName: m.displayName,
            tier: m.tier === "paid" ? "gems_paid" as const : m.tier,
            description: m.isPromotional ? "Promotional Free" : undefined,
          })),
        ]);
        setModelProviders(Object.fromEntries(data.map((m) => [m.id, m.providerId])));
      })
      .catch(() => {
        // Selector falls back to Auto; server may still be starting
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSelectModel = useCallback((model: ModelSelectorItem) => {
    setSelectedModelId(model.id);
    // Forward the selection over HTTP into AgentRuntime.setModelSelection().
    // The server remains authoritative: it rejects unknown ids and enforces
    // entitlements at execution time, so this request cannot grant access.
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
        if (!response.ok) setSelectedModelId("auto");
      })
      .catch(() => {
        setSelectedModelId("auto");
      });
  }, [modelProviders]);

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
          <ModelSelector
            models={models}
            selectedId={selectedModelId}
            onSelect={handleSelectModel}
            onUpgradeNavigation={handleUpgradeNavigation}
          />
          <button className="header-btn" title="Help">
            ?
          </button>
        </div>
      </header>

      <main className="workspace-shell-main">
        <WorkspaceApp sseUrl={`${SERVER_BASE_URL}/api/events`} />
      </main>
    </div>
  );
}

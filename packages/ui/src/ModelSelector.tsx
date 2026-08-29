import React, { useState } from "react";
import { getUpgradeUrl } from "./upgrade-url.js";

export type ModelTier = "free" | "gems_paid";

export type ModelEntitlementStatus =
  | "included"
  | "requires_subscription"
  | "trial"
  | "not_entitled";

export interface ModelSelectorItem {
  id: string;
  displayName: string;
  tier: ModelTier;
  description?: string;
  entitlementStatus?: ModelEntitlementStatus;
}

export interface ModelSelectionIntent {
  allowed: boolean;
  navigateToUpgrade: boolean;
  url?: string;
}

export function isModelUsable(model: ModelSelectorItem): boolean {
  if (model.tier !== "gems_paid") {
    return true;
  }
  return model.entitlementStatus === "included" || model.entitlementStatus === "trial";
}

export function resolveModelSelection(
  model: ModelSelectorItem,
  options: { upgradeUrl: string },
): ModelSelectionIntent {
  if (isModelUsable(model)) {
    return { allowed: true, navigateToUpgrade: false };
  }
  return { allowed: false, navigateToUpgrade: true, url: options.upgradeUrl };
}

export interface ModelSelectorProps {
  models: ModelSelectorItem[];
  selectedId: string | null;
  onSelect: (model: ModelSelectorItem) => void;
  onUpgradeNavigation?: (url: string, model: ModelSelectorItem) => void;
  upgradeUrl?: string;
  disabled?: boolean;
  onShowDetails?: (model: ModelSelectorItem) => void;
  isOpen?: boolean;
}

export function ModelSelector({
  models,
  selectedId,
  onSelect,
  onUpgradeNavigation,
  upgradeUrl,
  disabled,
  onShowDetails,
  isOpen: controlledIsOpen,
}: ModelSelectorProps): React.ReactElement {
  const url = upgradeUrl ?? getUpgradeUrl();
  const [internalIsOpen, setInternalIsOpen] = useState(false);
  const isOpen = controlledIsOpen ?? internalIsOpen;

  const handleSelect = (model: ModelSelectorItem): void => {
    if (disabled) return;
    const intent = resolveModelSelection(model, { upgradeUrl: url });
    if (!intent.allowed) {
      if (intent.navigateToUpgrade && intent.url) {
        onUpgradeNavigation?.(intent.url, model);
      }
      return;
    }
    onSelect(model);
    setInternalIsOpen(false);
  };

  const handleOptionKeyDown = (e: React.KeyboardEvent, model: ModelSelectorItem): void => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleSelect(model);
    }
  };

  const selectedModel = models.find((m) => m.id === selectedId);
  const triggerLabel = selectedModel
    ? selectedModel.id === "auto"
      ? selectedModel.description
        ? `${selectedModel.displayName} · ${selectedModel.description}`
        : "Auto · Best Verified Free"
      : selectedModel.displayName
    : "Auto · Verified Free";

  const freeModels = models.filter((m) => m.tier === "free");
  const paidModels = models.filter((m) => m.tier === "gems_paid");

  return (
    <div className="model-selector">
      <button
        type="button"
        className="model-trigger"
        onClick={() => setInternalIsOpen(!internalIsOpen)}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-label="Select model"
        aria-selected={Boolean(selectedModel)}
      >
        <span>{triggerLabel}</span>
        <span style={{ fontSize: 8 }}>▾</span>
      </button>

      {isOpen && (
        <>
          <div
            style={{ position: "fixed", inset: 0, zIndex: 99 }}
            onClick={() => setInternalIsOpen(false)}
          />
          <div className="model-dropdown" role="listbox" aria-label="Model selection">
            {freeModels.length > 0 && (
              <>
                <div className="model-dropdown-section">Free / Verified</div>
                {freeModels.map((model) => {
                  const locked = !isModelUsable(model);
                  return (
                    <div
                      key={model.id}
                      role="option"
                      tabIndex={locked || disabled ? -1 : 0}
                      aria-selected={model.id === selectedId}
                      aria-disabled={locked || disabled ? true : undefined}
                      title={locked ? `${model.displayName} requires an upgraded plan` : undefined}
                      className={`model-option ${model.id === selectedId ? "selected" : ""} ${locked ? "locked" : ""}`}
                      onClick={() => handleSelect(model)}
                      onKeyDown={(e) => handleOptionKeyDown(e, model)}
                    >
                      <span className="model-option-name">{model.displayName}</span>
                      <span className="model-option-meta">
                        {model.description && (
                          <span className="model-option-desc">{model.description}</span>
                        )}
                        {!locked && !model.description && (
                          <span className="model-option-badge free">Free</span>
                        )}
                        {onShowDetails && model.id !== "auto" && (
                          <button
                            type="button"
                            className="model-option-details"
                            onClick={(e) => {
                              e.stopPropagation();
                              onShowDetails(model);
                            }}
                            title="View model details"
                          >
                            ℹ
                          </button>
                        )}
                      </span>
                    </div>
                  );
                })}
              </>
            )}
            {paidModels.length > 0 && (
              <>
                <div className="model-dropdown-section" style={{ marginTop: freeModels.length > 0 ? 4 : 0 }}>Premium / BYOK</div>
                {paidModels.map((model) => {
                  const locked = !isModelUsable(model);
                  return (
                    <div
                      key={model.id}
                      role="option"
                      tabIndex={locked || disabled ? -1 : 0}
                      aria-selected={model.id === selectedId}
                      aria-disabled={locked || disabled ? true : undefined}
                      title={locked ? `${model.displayName} requires an upgraded plan` : undefined}
                      className={`model-option ${model.id === selectedId ? "selected" : ""} ${locked ? "locked" : ""}`}
                      onClick={() => handleSelect(model)}
                      onKeyDown={(e) => handleOptionKeyDown(e, model)}
                    >
                      <span className="model-option-name">{model.displayName}</span>
                      <span className="model-option-meta">
                        {locked && <span className="model-option-badge paid">Paid 🔒</span>}
                        {!locked && model.description && (
                          <span className="model-option-desc">{model.description}</span>
                        )}
                        {onShowDetails && model.id !== "auto" && (
                          <button
                            type="button"
                            className="model-option-details"
                            onClick={(e) => {
                              e.stopPropagation();
                              onShowDetails(model);
                            }}
                            title="View model details"
                          >
                            ℹ
                          </button>
                        )}
                      </span>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

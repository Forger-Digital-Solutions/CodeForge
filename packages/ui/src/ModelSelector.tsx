import React from "react";
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
  /** Presentational subtitle, e.g. "Best Free Model" for Auto. */
  description?: string;
  /** User entitlement, when known. Unentitled GEMS models render locked. */
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

/**
 * Pure click decision for a model row. Selecting an unentitled GEMS model
 * NEVER executes inference — it only produces upgrade navigation.
 */
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
}

export function ModelSelector({
  models,
  selectedId,
  onSelect,
  onUpgradeNavigation,
  upgradeUrl,
  disabled,
  onShowDetails,
}: ModelSelectorProps): React.ReactElement {
  const url = upgradeUrl ?? getUpgradeUrl();

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
  };

  const getAutoStatusText = () => {
    const autoModel = models.find(m => m.id === "auto");
    if (!autoModel) return undefined;
    if (autoModel.description) return autoModel.description;
    return "Best Verified Free Model";
  };

  return (
    <div className="model-selector" role="listbox" aria-label="Model selection">
      <div className="model-selector-label">Model</div>
      <div className="model-selector-list">
        {models.map((model) => {
          const locked = !isModelUsable(model);
          const classes = [
            "model-option",
            model.id === selectedId ? "selected" : "",
            locked ? "locked" : "",
          ]
            .filter(Boolean)
            .join(" ");
          
          const displayDescription = model.id === "auto" && selectedId === "auto" 
            ? getAutoStatusText() 
            : model.description;
          
          return (
            <button
              key={model.id}
              type="button"
              role="option"
              aria-selected={model.id === selectedId}
              aria-disabled={locked || disabled ? true : undefined}
              title={locked ? `${model.displayName} requires an upgraded plan` : undefined}
              className={classes}
              onClick={() => handleSelect(model)}
            >
              <span className="model-option-name">{model.displayName}</span>
              <span className="model-option-meta">
                {displayDescription && (
                  <span className="model-option-desc">{displayDescription}</span>
                )}
                {locked && <span className="model-option-badge paid">Paid 🔒</span>}
                {!locked && !displayDescription && model.tier === "free" && (
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
                    ℹ️
                  </button>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

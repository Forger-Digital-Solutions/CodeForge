import React, { useEffect, useRef, useState } from "react";
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

export interface ModelSection {
  sectionId: string;
  sectionLabel: string;
  models: ModelSelectorItem[];
  /**
   * Shown as a muted, non-selectable row when the group has no usable models
   * yet — e.g. a provider whose BYOK/integration is not connected. Keeps the
   * information architecture honest instead of hiding the provider entirely.
   */
  note?: string;
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

/** Filters only already-present catalog metadata; it never invents availability. */
export function filterModelSections(sections: ModelSection[], query: string): ModelSection[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return sections;
  return sections
    .map((section) => ({
      ...section,
      models: section.models.filter((model) =>
        [section.sectionLabel, model.id, model.displayName, model.description, model.tier]
          .filter((value): value is string => Boolean(value))
          .join(" ")
          .toLocaleLowerCase()
          .includes(normalized),
      ),
    }))
    .filter((section) => section.models.length > 0);
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
  modelSections?: ModelSection[];
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
  modelSections,
}: ModelSelectorProps): React.ReactElement {
  const url = upgradeUrl ?? getUpgradeUrl();
  const [internalIsOpen, setInternalIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [focusedIndex, setFocusedIndex] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLDivElement | null>>([]);
  const isOpen = controlledIsOpen ?? internalIsOpen;

  useEffect(() => {
    if (isOpen) {
      searchRef.current?.focus();
      setFocusedIndex(0);
    } else {
      setQuery("");
      setFocusedIndex(0);
    }
  }, [isOpen]);

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
    : "ForgeAuto/Free · Automatic free routing";

  const sections: ModelSection[] = modelSections?.length
    ? modelSections
    : [
        {
          sectionId: "free",
          sectionLabel: "Free / Verified",
          models: models.filter((m) => m.tier === "free"),
        },
        {
          sectionId: "paid",
          sectionLabel: "Premium / BYOK",
          models: models.filter((m) => m.tier === "gems_paid"),
        },
      ].filter((s) => s.models.length > 0);
  const filteredSections = filterModelSections(sections, query);
  const matchingModelCount = filteredSections.reduce((count, section) => count + section.models.length, 0);
  const flatModels = filteredSections.flatMap((section) => section.models);

  const close = (): void => {
    setInternalIsOpen(false);
    setQuery("");
  };

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
            onClick={close}
          />
          <div className="model-dropdown" role="dialog" aria-label="Model selection" onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              close();
              return;
            }
            if ((event.key === "ArrowDown" || event.key === "ArrowUp") && flatModels.length > 0) {
              event.preventDefault();
              const direction = event.key === "ArrowDown" ? 1 : -1;
              const next = (focusedIndex + direction + flatModels.length) % flatModels.length;
              setFocusedIndex(next);
              optionRefs.current[next]?.focus();
            }
          }}>
            <div className="model-search-wrap">
              <input
                ref={searchRef}
                className="model-search"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Filter models or providers"
                aria-label="Filter models or providers"
              />
              <span className="model-search-count" aria-live="polite">{matchingModelCount} shown</span>
            </div>
            <div className="model-dropdown-list" role="listbox" aria-label="Available models">
            {filteredSections.map((section) => {
              return (
              <div key={section.sectionId}>
                <div className="model-dropdown-section">{section.sectionLabel}</div>
                {section.models.length === 0 && section.note && (
                  <div className="model-option disabled" aria-disabled="true">
                    <span className="model-option-note">{section.note}</span>
                  </div>
                )}
                {section.models.map((model) => {
                  const optionIndex = flatModels.findIndex((candidate) => candidate.id === model.id);
                  const locked = !isModelUsable(model);
                  return (
                    <div
                      key={model.id}
                      ref={(element) => { optionRefs.current[optionIndex] = element; }}
                      role="option"
                      tabIndex={locked || disabled ? -1 : optionIndex === focusedIndex ? 0 : -1}
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
                        {!locked && !model.description && model.tier === "free" && (
                          <span className="model-option-badge free">Free</span>
                        )}
                        {locked && model.tier === "gems_paid" && (
                          <span className="model-option-badge paid">Unavailable</span>
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
              </div>
              );
            })}
            {filteredSections.length === 0 && (
              <div className="model-empty-result" role="status">No catalog matches. Refine the filter or choose Auto.</div>
            )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

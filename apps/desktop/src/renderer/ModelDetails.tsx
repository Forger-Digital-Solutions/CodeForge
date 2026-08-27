import React from "react";

interface ModelDetailsProps {
  model: {
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
  };
  onClose: () => void;
}

export default function ModelDetails({ model, onClose }: ModelDetailsProps) {
  const getFreeStatusDisplay = () => {
    if (model.isPromotional) {
      return "Promotional Free";
    }
    if (model.costProfile?.isFree) {
      return "Verified Free";
    }
    if (model.tier === "paid" || model.tier === "gems_paid") {
      return "Paid";
    }
    return model.freeStatus;
  };

  const getAutoEligibility = () => {
    if (model.tier === "paid" || model.tier === "gems_paid") {
      return { eligible: false, reason: "Paid models are not eligible for Auto" };
    }
    if (model.isPromotional) {
      return { eligible: true, reason: "Eligible (promotional free)" };
    }
    if (model.costProfile?.isFree) {
      return { eligible: true, reason: "Eligible (verified free)" };
    }
    return { eligible: false, reason: "Free status not verified" };
  };

  const autoEligibility = getAutoEligibility();

  return (
    <div className="model-details" role="dialog" aria-modal="true" aria-label="Model details">
      <div className="model-details-container">
        <div className="model-details-header">
          <h2 className="model-details-title">Model Details</h2>
          <button className="model-details-close" onClick={onClose} aria-label="Close model details">
            ✕
          </button>
        </div>

        <div className="model-details-content">
          <div className="model-details-section">
            <h3 className="model-details-section-title">Basic Information</h3>
            <div className="model-details-row">
              <span className="model-details-label">Model Name</span>
              <span className="model-details-value">{model.displayName}</span>
            </div>
            <div className="model-details-row">
              <span className="model-details-label">Provider</span>
              <span className="model-details-value">
                {model.providerId === "opencode" ? "OpenCode Zen" : 
                 model.providerId === "openrouter" ? "OpenRouter" : 
                 model.providerId}
              </span>
            </div>
            <div className="model-details-row">
              <span className="model-details-label">Status</span>
              <span className={`model-details-value model-details-status ${model.costProfile?.isFree ? 'free' : model.tier === 'paid' ? 'paid' : ''}`}>
                {getFreeStatusDisplay()}
              </span>
            </div>
            <div className="model-details-row">
              <span className="model-details-label">Verification</span>
              <span className="model-details-value">
                {model.costProfile?.isFree || model.isPromotional ? "Verified via ForgeZero" : "Not verified as free"}
              </span>
            </div>
            <div className="model-details-row">
              <span className="model-details-label">Canonical ID</span>
              <span className="model-details-value" style={{ fontFamily: "monospace", fontSize: "11px" }}>
                {model.providerId}::{model.id}
              </span>
            </div>
          </div>

          <div className="model-details-section">
            <h3 className="model-details-section-title">Auto Eligibility</h3>
            <p style={{ fontSize: "12px", color: "var(--text-muted)", marginBottom: "8px" }}>
              ForgeZero determines eligibility. UI only displays it.
            </p>
            <div className="model-details-row">
              <span className="model-details-label">Status</span>
              <span className={`model-details-value ${autoEligibility.eligible ? 'eligible' : 'ineligible'}`}>
                {autoEligibility.eligible ? "✓ Eligible" : "✗ Not Eligible"}
              </span>
            </div>
            <div className="model-details-row">
              <span className="model-details-label">Reason</span>
              <span className="model-details-value">{autoEligibility.reason}</span>
            </div>
          </div>

          {model.contextWindow && (
            <div className="model-details-section">
              <h3 className="model-details-section-title">Context Window</h3>
              <div className="model-details-row">
                <span className="model-details-label">Tokens</span>
                <span className="model-details-value">{model.contextWindow.toLocaleString()}</span>
              </div>
            </div>
          )}

          {model.capabilities && (
            <div className="model-details-section">
              <h3 className="model-details-section-title">Capabilities</h3>
              <div className="model-details-capabilities">
                <div className={`capability ${model.capabilities.text ? 'enabled' : 'disabled'}`}>
                  <span className="capability-icon">{model.capabilities.text ? '✓' : '✗'}</span>
                  <span className="capability-name">Text</span>
                </div>
                <div className={`capability ${model.capabilities.coding ? 'enabled' : 'disabled'}`}>
                  <span className="capability-icon">{model.capabilities.coding ? '✓' : '✗'}</span>
                  <span className="capability-name">Coding</span>
                </div>
                <div className={`capability ${model.capabilities.toolCalling ? 'enabled' : 'disabled'}`}>
                  <span className="capability-icon">{model.capabilities.toolCalling ? '✓' : '✗'}</span>
                  <span className="capability-name">Tool Calling</span>
                </div>
                <div className={`capability ${model.capabilities.vision ? 'enabled' : 'disabled'}`}>
                  <span className="capability-icon">{model.capabilities.vision ? '✓' : '✗'}</span>
                  <span className="capability-name">Vision</span>
                </div>
                <div className={`capability ${model.capabilities.structuredOutput ? 'enabled' : 'disabled'}`}>
                  <span className="capability-icon">{model.capabilities.structuredOutput ? '✓' : '✗'}</span>
                  <span className="capability-name">Structured Output</span>
                </div>
                <div className={`capability ${model.capabilities.longContext ? 'enabled' : 'disabled'}`}>
                  <span className="capability-icon">{model.capabilities.longContext ? '✓' : '✗'}</span>
                  <span className="capability-name">Long Context</span>
                </div>
              </div>
            </div>
          )}

          {model.costProfile && (
            <div className="model-details-section">
              <h3 className="model-details-section-title">Pricing</h3>
              <div className="model-details-row">
                <span className="model-details-label">Input Cost</span>
                <span className="model-details-value">
                  {model.costProfile.inputCostPerMillion === 0 
                    ? "Free" 
                    : `$${model.costProfile.inputCostPerMillion}/M tokens`}
                </span>
              </div>
              <div className="model-details-row">
                <span className="model-details-label">Output Cost</span>
                <span className="model-details-value">
                  {model.costProfile.outputCostPerMillion === 0 
                    ? "Free" 
                    : `$${model.costProfile.outputCostPerMillion}/M tokens`}
                </span>
              </div>
              {model.costProfile.paidFallbackPossible && (
                <div className="model-details-row">
                  <span className="model-details-label">Paid Fallback</span>
                  <span className="model-details-value">Possible</span>
                </div>
              )}
            </div>
          )}

          {model.isPromotional && (
            <div className="model-details-section">
              <h3 className="model-details-section-title">Promotional Status</h3>
              <div className="model-details-row">
                <span className="model-details-label">Type</span>
                <span className="model-details-value">Promotional Free</span>
              </div>
              <div className="model-details-row">
                <span className="model-details-label">Note</span>
                <span className="model-details-value">
                  This model is currently free as a promotion. Free status may change.
                </span>
              </div>
            </div>
          )}
        </div>

        <div className="model-details-footer">
          <button className="model-details-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
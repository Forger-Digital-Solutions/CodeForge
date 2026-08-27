import React from "react";

interface OnboardingFlowProps {
  onComplete: () => void;
  onSkip: () => void;
}

export default function OnboardingFlow({ onComplete, onSkip }: OnboardingFlowProps) {
  return (
    <div className="onboarding-flow">
      <div className="onboarding-container">
        <div className="onboarding-header">
          <div className="onboarding-logo">
            <svg width="48" height="48" viewBox="0 0 64 64" fill="none">
              <rect width="64" height="64" rx="12" fill="#6366f1"/>
              <path d="M18 44L28 20H36L46 44H38L36 38H28L26 44H18ZM30 32H34L32 26L30 32Z" fill="white"/>
              <circle cx="48" cy="16" r="8" fill="#22c55e"/>
            </svg>
          </div>
          <h1 className="onboarding-title">Welcome to CodeForge</h1>
          <p className="onboarding-subtitle">Free AI-powered coding agent</p>
        </div>

        <div className="onboarding-content">
          <div className="onboarding-section">
            <h2 className="onboarding-section-title">Connect a Cloud Provider</h2>
            <p className="onboarding-section-text">
              CodeForge uses cloud-hosted AI providers. Connect a supported provider to enable Full-Auto
              and verified free model routing. No local model is required.
            </p>
            <p className="onboarding-section-text" style={{ marginTop: "8px" }}>
              <strong>Free Mode:</strong> Full-Auto selects the best currently verified free model. If no
              verified free model is available, CodeForge will not silently use a paid model.
            </p>
          </div>

          <div className="onboarding-providers" role="list" aria-label="Supported providers">
            <div className="onboarding-provider-card" role="listitem">
              <div className="provider-card-icon" aria-hidden="true">🔮</div>
              <h3 className="provider-card-name">OpenCode Zen</h3>
              <p className="provider-card-description">
                Cloud provider — promotional free models
              </p>
              <div className="provider-card-badges">
                <span className="provider-badge free">Free models available</span>
              </div>
              <p className="provider-card-meta">Credential: OPENCODE_API_KEY</p>
            </div>

            <div className="onboarding-provider-card" role="listitem">
              <div className="provider-card-icon" aria-hidden="true">🌐</div>
              <h3 className="provider-card-name">OpenRouter</h3>
              <p className="provider-card-description">
                Cloud provider — free and paid models
              </p>
              <div className="provider-card-badges">
                <span className="provider-badge free">Free models available</span>
                <span className="provider-badge paid">Paid models available</span>
              </div>
              <p className="provider-card-meta">Credential: OPENROUTER_API_KEY</p>
            </div>
          </div>

          <div className="onboarding-info" role="region" aria-label="Important notes">
            <div className="onboarding-info-item">
              <span className="info-icon" aria-hidden="true">✓</span>
              <span className="info-text">No local model required — providers are cloud-hosted</span>
            </div>
            <div className="onboarding-info-item">
              <span className="info-icon" aria-hidden="true">✓</span>
              <span className="info-text">Auto selects only models that ForgeZero verifies as free</span>
            </div>
            <div className="onboarding-info-item">
              <span className="info-icon" aria-hidden="true">✓</span>
              <span className="info-text">Paid models are never silently substituted</span>
            </div>
            <div className="onboarding-info-item">
              <span className="info-icon" aria-hidden="true">⚠</span>
              <span className="info-text">Free availability can change; some free models are promotional</span>
            </div>
          </div>

          <p className="onboarding-note">
            Provider configuration is optional and can be skipped. You can configure providers anytime from the
            welcome screen.
          </p>
        </div>

        <div className="onboarding-actions">
          <button
            className="onboarding-btn primary"
            onClick={onComplete}
            aria-label="Configure cloud providers"
            autoFocus
          >
            Configure Providers
          </button>
          <button
            className="onboarding-btn secondary"
            onClick={onSkip}
            aria-label="Skip provider setup"
          >
            Skip for Now
          </button>
        </div>

        <div className="onboarding-footer">
          <p>
            You can configure providers anytime from the welcome screen.
          </p>
        </div>
      </div>
    </div>
  );
}
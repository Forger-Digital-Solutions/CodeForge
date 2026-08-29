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
            <svg width="48" height="48" viewBox="0 0 256 256" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="CodeForge">
              <defs>
                <radialGradient id="ob-bg" cx="50%" cy="50%" r="68%"><stop offset="0%" stop-color="#1e1f24"/><stop offset="100%" stop-color="#0a0b0d"/></radialGradient>
                <linearGradient id="ob-rim" x1="8%" y1="8%" x2="92%" y2="92%"><stop offset="0%" stop-color="#f1f2f4"/><stop offset="42%" stop-color="#a8adb5"/><stop offset="100%" stop-color="#7d828a"/></linearGradient>
                <linearGradient id="ob-orbit" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="#e6e8ec"/><stop offset="100%" stop-color="#8b9099"/></linearGradient>
                <radialGradient id="ob-d-top" cx="32%" cy="22%" r="85%"><stop offset="0%" stop-color="#ffffff"/><stop offset="60%" stop-color="#9aa2af"/><stop offset="100%" stop-color="#5c6575"/></radialGradient>
                <radialGradient id="ob-d-left" cx="20%" cy="35%" r="90%"><stop offset="0%" stop-color="#f2f4f7"/><stop offset="100%" stop-color="#3e4552"/></radialGradient>
                <radialGradient id="ob-d-right" cx="78%" cy="30%" r="90%"><stop offset="0%" stop-color="#ffffff"/><stop offset="100%" stop-color="#4a5261"/></radialGradient>
                <radialGradient id="ob-sphere" cx="32%" cy="28%" r="75%"><stop offset="0%" stop-color="#ffffff"/><stop offset="48%" stop-color="#a9b0bc"/><stop offset="100%" stop-color="#5a6474"/></radialGradient>
              </defs>
              <circle cx="128" cy="128" r="127" fill="none" stroke="url(#ob-rim)" stroke-width="3"/>
              <circle cx="128" cy="128" r="122" fill="url(#ob-bg)"/>
              <ellipse cx="128" cy="128" rx="108" ry="46" transform="rotate(-18 128 128)" fill="none" stroke="url(#ob-orbit)" stroke-width="4.2"/>
              <ellipse cx="128" cy="128" rx="108" ry="40" transform="rotate(42 128 128)" fill="none" stroke="url(#ob-orbit)" stroke-width="3.8" opacity="0.95"/>
              <ellipse cx="128" cy="128" rx="102" ry="36" transform="rotate(78 128 128)" fill="none" stroke="#a8adb5" stroke-width="3.2" opacity="0.9"/>
              <path d="M128 56 L178 106 L128 118 L78 106 Z" fill="url(#ob-d-top)"/>
              <path d="M78 106 L128 118 L102 152 L78 106" fill="#8f99ab"/>
              <path d="M78 106 L102 152 L128 204 L128 118 Z" fill="url(#ob-d-left)"/>
              <path d="M178 106 L128 118 L154 152 L178 106" fill="#b8c0ce"/>
              <path d="M178 106 L154 152 L128 204 L128 118 Z" fill="url(#ob-d-right)"/>
              <path d="M128 118 L154 152 L128 204 Z" fill="#e8ecf2" opacity="0.96"/>
              <circle cx="192.5" cy="57.5" r="20" fill="url(#ob-sphere)" stroke="#d6dae0" stroke-width="0.7"/>
              <circle cx="42.5" cy="130.5" r="19.2" fill="url(#ob-sphere)" stroke="#d6dae0" stroke-width="0.7"/>
              <circle cx="196.2" cy="194.2" r="15.8" fill="url(#ob-sphere)" stroke="#d6dae0" stroke-width="0.6"/>
              <circle cx="77.8" cy="76.2" r="7.8" fill="url(#ob-sphere)" stroke="#c2c6cd" stroke-width="0.5"/>
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
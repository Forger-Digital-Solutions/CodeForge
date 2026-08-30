import React, { useState } from "react";

interface OnboardingFlowProps {
  onComplete: () => void;
  onSkip: () => void;
}

export default function OnboardingFlow({ onComplete, onSkip }: OnboardingFlowProps) {
  const [signingIn, setSigningIn] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const handleCloudSignIn = async () => {
    setSigningIn(true);
    setAuthError(null);
    try {
      if (window.electronAPI?.signInWithCloud) {
        const res = await window.electronAPI.signInWithCloud();
        if (res.ok) {
          if (window.electronAPI?.setOnboardingCompleted) {
            await window.electronAPI.setOnboardingCompleted(true);
          }
          onSkip();
          return;
        } else if (res.error) {
          setAuthError(res.error);
        }
      }
    } catch (e) {
      setAuthError(e instanceof Error ? e.message : String(e));
    } finally {
      setSigningIn(false);
    }
  };

  return (
    <div className="onboarding-flow">
      <div className="onboarding-container">
        <div className="onboarding-header">
          <div className="onboarding-logo">
            <svg width="48" height="48" viewBox="0 0 256 256" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="CodeForge">
              <defs>
                <radialGradient id="ob-bg" cx="50%" cy="50%" r="68%"><stop offset="0%" stopColor="#1e1f24"/><stop offset="100%" stopColor="#0a0b0d"/></radialGradient>
                <linearGradient id="ob-rim" x1="8%" y1="8%" x2="92%" y2="92%"><stop offset="0%" stopColor="#f1f2f4"/><stop offset="42%" stopColor="#a8adb5"/><stop offset="100%" stopColor="#7d828a"/></linearGradient>
                <linearGradient id="ob-orbit" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stopColor="#e6e8ec"/><stop offset="100%" stopColor="#8b9099"/></linearGradient>
                <radialGradient id="ob-d-top" cx="32%" cy="22%" r="85%"><stop offset="0%" stopColor="#ffffff"/><stop offset="60%" stopColor="#9aa2af"/><stop offset="100%" stopColor="#5c6575"/></radialGradient>
                <radialGradient id="ob-d-left" cx="20%" cy="35%" r="90%"><stop offset="0%" stopColor="#f2f4f7"/><stop offset="100%" stopColor="#3e4552"/></radialGradient>
                <radialGradient id="ob-d-right" cx="78%" cy="30%" r="90%"><stop offset="0%" stopColor="#ffffff"/><stop offset="100%" stopColor="#4a5261"/></radialGradient>
                <radialGradient id="ob-sphere" cx="32%" cy="28%" r="75%"><stop offset="0%" stopColor="#ffffff"/><stop offset="48%" stopColor="#a9b0bc"/><stop offset="100%" stopColor="#5a6474"/></radialGradient>
              </defs>
              <circle cx="128" cy="128" r="127" fill="none" stroke="url(#ob-rim)" strokeWidth="3"/>
              <circle cx="128" cy="128" r="122" fill="url(#ob-bg)"/>
              <ellipse cx="128" cy="128" rx="108" ry="46" transform="rotate(-18 128 128)" fill="none" stroke="url(#ob-orbit)" strokeWidth="4.2"/>
              <ellipse cx="128" cy="128" rx="108" ry="40" transform="rotate(42 128 128)" fill="none" stroke="url(#ob-orbit)" strokeWidth="3.8" opacity="0.95"/>
              <ellipse cx="128" cy="128" rx="102" ry="36" transform="rotate(78 128 128)" fill="none" stroke="#a8adb5" strokeWidth="3.2" opacity="0.9"/>
              <path d="M128 56 L178 106 L128 118 L78 106 Z" fill="url(#ob-d-top)"/>
              <path d="M78 106 L128 118 L102 152 L78 106" fill="#8f99ab"/>
              <path d="M78 106 L102 152 L128 204 L128 118 Z" fill="url(#ob-d-left)"/>
              <path d="M178 106 L128 118 L154 152 L178 106" fill="#b8c0ce"/>
              <path d="M178 106 L154 152 L128 204 L128 118 Z" fill="url(#ob-d-right)"/>
              <path d="M128 118 L154 152 L128 204 Z" fill="#e8ecf2" opacity="0.96"/>
              <circle cx="192.5" cy="57.5" r="20" fill="url(#ob-sphere)" stroke="#d6dae0" strokeWidth="0.7"/>
              <circle cx="42.5" cy="130.5" r="19.2" fill="url(#ob-sphere)" stroke="#d6dae0" strokeWidth="0.7"/>
              <circle cx="196.2" cy="194.2" r="15.8" fill="url(#ob-sphere)" stroke="#d6dae0" strokeWidth="0.6"/>
              <circle cx="77.8" cy="76.2" r="7.8" fill="url(#ob-sphere)" stroke="#c2c6cd" strokeWidth="0.5"/>
            </svg>
          </div>
          <h1 className="onboarding-title">Welcome to CodeForge</h1>
          <p className="onboarding-subtitle">Free-first autonomous software engineering platform</p>
        </div>

        <div className="onboarding-content">
          {authError && (
            <div className="onboarding-error-banner" style={{ background: "#7f1d1d", color: "#fecaca", padding: "10px 14px", borderRadius: "6px", marginBottom: "16px" }}>
              {authError}
            </div>
          )}

          <div className="onboarding-section">
            <h2 className="onboarding-section-title">Choose How You Want to Run Models</h2>
            <p className="onboarding-section-text">
              CodeForge routes your coding tasks across high-performing zero-cost cloud LLMs, backed by the <strong>ForgeZero</strong> zero-billing firewall.
            </p>
          </div>

          <div className="onboarding-providers" role="list" aria-label="Available modes">
            <div className="onboarding-provider-card" role="listitem" style={{ borderColor: "#38bdf8", cursor: "pointer" }} onClick={handleCloudSignIn}>
              <div className="provider-card-icon" aria-hidden="true">✦</div>
              <h3 className="provider-card-name">Start with CodeForge Free (Recommended)</h3>
              <p className="provider-card-description">
                Zero provider accounts or API keys required. 500,000 monthly credits included on the house.
              </p>
              <div className="provider-card-badges">
                <span className="provider-badge free">Instant Setup</span>
                <span className="provider-badge free">500k Credits Included</span>
              </div>
            </div>

            <div className="onboarding-provider-card" role="listitem" style={{ cursor: "pointer" }} onClick={onComplete}>
              <div className="provider-card-icon" aria-hidden="true">🔑</div>
              <h3 className="provider-card-name">Connect Your Own Provider (BYOK)</h3>
              <p className="provider-card-description">
                Direct connections to OpenCode Zen, OpenRouter, Groq, Z.AI, or Gemini with your locally encrypted API keys.
              </p>
              <div className="provider-card-badges">
                <span className="provider-badge free">Direct to Provider</span>
                <span className="provider-badge paid">User-Controlled Keys</span>
              </div>
            </div>
          </div>

          <div className="onboarding-info" role="region" aria-label="Important notes">
            <div className="onboarding-info-item">
              <span className="info-icon" aria-hidden="true">✓</span>
              <span className="info-text">No local models or GPU required — all models run in high-speed cloud</span>
            </div>
            <div className="onboarding-info-item">
              <span className="info-icon" aria-hidden="true">✓</span>
              <span className="info-text">ForgeZero firewall prevents accidental paid billing on free turns</span>
            </div>
            <div className="onboarding-info-item">
              <span className="info-icon" aria-hidden="true">✓</span>
              <span className="info-text">Switch between Hosted Free and Direct BYOK anytime</span>
            </div>
          </div>
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
            onClick={handleCloudSignIn}
            disabled={signingIn}
            aria-label="Start with CodeForge Free"
          >
            {signingIn ? "Connecting..." : "✦ Start with CodeForge Free"}
          </button>
          <button
            className="onboarding-btn secondary"
            onClick={onSkip}
            aria-label="Skip setup"
            style={{ opacity: 0.7 }}
          >
            Skip for Now
          </button>
        </div>
      </div>
    </div>
  );
}

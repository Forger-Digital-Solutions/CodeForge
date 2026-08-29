import React, { useState, useEffect } from "react";
import type { Project } from "./App.js";
import ProviderSetup from "./ProviderSetup.js";
import OnboardingFlow from "./OnboardingFlow.js";

interface WelcomeScreenProps {
  recentProjects: Project[];
  onOpenProject: (path?: string) => void;
  onCreateProject: () => void;
  loading: boolean;
  error: string | null;
}

export default function WelcomeScreen({
  recentProjects,
  onOpenProject,
  onCreateProject,
  loading,
  error,
}: WelcomeScreenProps) {
  const [showProviderSetup, setShowProviderSetup] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [hasConfiguredProvider, setHasConfiguredProvider] = useState(false);

  useEffect(() => {
    checkOnboardingState();
  }, []);

  const checkOnboardingState = async () => {
    try {
      let onboardingCompleted = false;
      if (window.electronAPI?.getOnboardingCompleted) {
        onboardingCompleted = await window.electronAPI.getOnboardingCompleted();
      } else {
        onboardingCompleted = localStorage.getItem("codeforge:onboarding-completed") === "true";
      }

      if (window.electronAPI) {
        const status = await window.electronAPI.getProviderCredentialStatus();
        const hasCredentials = Object.values(status).some(Boolean);
        setHasConfiguredProvider(hasCredentials);

        if (!onboardingCompleted && !hasCredentials) {
          setShowOnboarding(true);
        }
      }
    } catch {
      // If we can't check, don't show onboarding
    }
  };

  const handleOnboardingComplete = () => {
    setShowOnboarding(false);
    setShowProviderSetup(true);
  };

  const handleOnboardingSkip = async () => {
    try {
      if (window.electronAPI?.setOnboardingCompleted) {
        await window.electronAPI.setOnboardingCompleted(true);
      } else {
        localStorage.setItem("codeforge:onboarding-completed", "true");
      }
    } catch {
      // ignore
    }
    setShowOnboarding(false);
  };

  const handleProviderSetupComplete = async () => {
    try {
      if (window.electronAPI?.setOnboardingCompleted) {
        await window.electronAPI.setOnboardingCompleted(true);
      } else {
        localStorage.setItem("codeforge:onboarding-completed", "true");
      }
    } catch {
      // ignore
    }
    setShowProviderSetup(false);
    checkOnboardingState();
  };

  if (showOnboarding) {
    return (
      <OnboardingFlow
        onComplete={handleOnboardingComplete}
        onSkip={handleOnboardingSkip}
      />
    );
  }

  if (showProviderSetup) {
    return (
      <ProviderSetup
        onComplete={handleProviderSetupComplete}
      />
    );
  }

  return (
    <div className="welcome">
      <div className="welcome-container">
        <div className="welcome-header">
          <div className="welcome-logo">
            <svg width="64" height="64" viewBox="0 0 256 256" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="CodeForge">
              <defs>
                <radialGradient id="ws-bg" cx="50%" cy="50%" r="68%"><stop offset="0%" stop-color="#1e1f24"/><stop offset="100%" stop-color="#0a0b0d"/></radialGradient>
                <linearGradient id="ws-rim" x1="8%" y1="8%" x2="92%" y2="92%"><stop offset="0%" stop-color="#f1f2f4"/><stop offset="42%" stop-color="#a8adb5"/><stop offset="100%" stop-color="#7d828a"/></linearGradient>
                <linearGradient id="ws-orbit" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="#e6e8ec"/><stop offset="100%" stop-color="#8b9099"/></linearGradient>
                <radialGradient id="ws-d-top" cx="32%" cy="22%" r="85%"><stop offset="0%" stop-color="#ffffff"/><stop offset="60%" stop-color="#9aa2af"/><stop offset="100%" stop-color="#5c6575"/></radialGradient>
                <radialGradient id="ws-d-left" cx="20%" cy="35%" r="90%"><stop offset="0%" stop-color="#f2f4f7"/><stop offset="100%" stop-color="#3e4552"/></radialGradient>
                <radialGradient id="ws-d-right" cx="78%" cy="30%" r="90%"><stop offset="0%" stop-color="#ffffff"/><stop offset="100%" stop-color="#4a5261"/></radialGradient>
                <radialGradient id="ws-sphere" cx="32%" cy="28%" r="75%"><stop offset="0%" stop-color="#ffffff"/><stop offset="48%" stop-color="#a9b0bc"/><stop offset="100%" stop-color="#5a6474"/></radialGradient>
              </defs>
              <circle cx="128" cy="128" r="127" fill="none" stroke="url(#ws-rim)" stroke-width="3"/>
              <circle cx="128" cy="128" r="122" fill="url(#ws-bg)"/>
              <circle cx="128" cy="128" r="98" fill="none" stroke="#2e2f35" stroke-width="0.7" opacity="0.35"/>
              <ellipse cx="128" cy="128" rx="108" ry="46" transform="rotate(-18 128 128)" fill="none" stroke="url(#ws-orbit)" stroke-width="4.2"/>
              <ellipse cx="128" cy="128" rx="108" ry="40" transform="rotate(42 128 128)" fill="none" stroke="url(#ws-orbit)" stroke-width="3.8" opacity="0.95"/>
              <ellipse cx="128" cy="128" rx="102" ry="36" transform="rotate(78 128 128)" fill="none" stroke="#a8adb5" stroke-width="3.2" opacity="0.9"/>
              <path d="M128 56 L178 106 L128 118 L78 106 Z" fill="url(#ws-d-top)"/>
              <path d="M78 106 L128 118 L102 152 L78 106" fill="#8f99ab"/>
              <path d="M78 106 L102 152 L128 204 L128 118 Z" fill="url(#ws-d-left)"/>
              <path d="M178 106 L128 118 L154 152 L178 106" fill="#b8c0ce"/>
              <path d="M178 106 L154 152 L128 204 L128 118 Z" fill="url(#ws-d-right)"/>
              <path d="M128 118 L154 152 L128 204 Z" fill="#e8ecf2" opacity="0.96"/>
              <circle cx="192.5" cy="57.5" r="20" fill="url(#ws-sphere)" stroke="#d6dae0" stroke-width="0.7"/>
              <circle cx="42.5" cy="130.5" r="19.2" fill="url(#ws-sphere)" stroke="#d6dae0" stroke-width="0.7"/>
              <circle cx="196.2" cy="194.2" r="15.8" fill="url(#ws-sphere)" stroke="#d6dae0" stroke-width="0.6"/>
              <circle cx="77.8" cy="76.2" r="7.8" fill="url(#ws-sphere)" stroke="#c2c6cd" stroke-width="0.5"/>
            </svg>
          </div>
          <h1 className="welcome-title">CodeForge</h1>
          <p className="welcome-subtitle">Free AI-powered coding agent</p>
        </div>

        {error && (
          <div className="welcome-error">
            {error}
          </div>
        )}

        <div className="welcome-actions">
          <button
            className="welcome-btn primary"
            onClick={() => onOpenProject()}
            disabled={loading}
          >
            <span className="btn-icon">📂</span>
            <span>Open Project</span>
          </button>
          <button
            className="welcome-btn secondary"
            onClick={onCreateProject}
            disabled={loading}
          >
            <span className="btn-icon">➕</span>
            <span>New Project</span>
          </button>
        </div>

        <div className="welcome-actions">
          <button
            className="welcome-btn secondary"
            onClick={() => setShowProviderSetup(true)}
            disabled={loading}
          >
            <span className="btn-icon">🔑</span>
            <span>Configure Providers</span>
          </button>
        </div>

        {recentProjects.length > 0 && (
          <div className="welcome-recent">
            <h3 className="welcome-recent-title">Recent Projects</h3>
            <ul className="welcome-recent-list">
              {recentProjects.slice(0, 5).map((project) => (
                <li key={project.id}>
                  <button
                    className="welcome-recent-item"
                    onClick={() => onOpenProject(project.path)}
                    disabled={loading}
                  >
                    <span className="recent-icon">📁</span>
                    <div className="recent-info">
                      <span className="recent-name">{project.name}</span>
                      <span className="recent-path">{project.path}</span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="welcome-footer">
          <p>Windows Desktop • Free Cloud LLMs • Autonomous Coding</p>
        </div>
      </div>
    </div>
  );
}

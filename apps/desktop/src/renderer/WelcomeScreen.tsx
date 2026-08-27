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
            <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
              <rect width="64" height="64" rx="12" fill="#6366f1"/>
              <path d="M18 44L28 20H36L46 44H38L36 38H28L26 44H18ZM30 32H34L32 26L30 32Z" fill="white"/>
              <circle cx="48" cy="16" r="8" fill="#22c55e"/>
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

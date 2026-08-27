import React, { useState, useEffect } from "react";

declare global {
  interface Window {
    electronAPI?: {
      selectDirectory: () => Promise<string | null>;
      getRecentProjects: () => Promise<Array<{ id: string; path: string; name: string; lastOpened: string }>>;
      openProject: (path: string) => Promise<{ id: string; path: string; name: string; lastOpened: string }>;
      createProject: () => Promise<{ id: string; path: string; name: string; lastOpened: string } | null>;
      openExternal: (url: string) => Promise<void>;
      getVersion: () => Promise<string>;
      getPlatform: () => Promise<string>;
      getProviderCredentials: () => Promise<Record<string, string>>;
      setProviderCredential: (providerId: string, apiKey: string) => Promise<void>;
      deleteProviderCredential: (providerId: string) => Promise<void>;
      testProviderConnection: (providerId: string) => Promise<{ status: string; error?: string }>;
    };
  }
}

const SERVER_BASE_URL = "http://localhost:3210";

interface ProviderConfig {
  providerId: string;
  displayName: string;
  description: string;
  authEnv: string;
  setupHelp: string;
  hasFreeModels: boolean;
  hasPaidModels: boolean;
}

const PROVIDERS: ProviderConfig[] = [
  {
    providerId: "opencode",
    displayName: "OpenCode Zen",
    description: "Cloud AI provider with promotional free models",
    authEnv: "OPENCODE_API_KEY",
    setupHelp: "Get your API key at https://opencode.ai/auth",
    hasFreeModels: true,
    hasPaidModels: false,
  },
  {
    providerId: "openrouter",
    displayName: "OpenRouter",
    description: "Cloud AI provider with paid and free models",
    authEnv: "OPENROUTER_API_KEY",
    setupHelp: "Get your API key at https://openrouter.ai/keys",
    hasFreeModels: true,
    hasPaidModels: true,
  },
];

type ConnectionStatus = "not_connected" | "connected" | "testing" | "error" | "missing_credential";

interface ProviderState {
  status: ConnectionStatus;
  error?: string;
  hasCredential: boolean;
}

export default function ProviderSetup({ onComplete }: { onComplete?: () => void }) {
  const [providerStates, setProviderStates] = useState<Record<string, ProviderState>>({});
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [showApiKeys, setShowApiKeys] = useState<Record<string, boolean>>({});

  useEffect(() => {
    loadProviderStates();
  }, []);

  const loadProviderStates = async () => {
    if (!window.electronAPI) return;

    try {
      const credentials = await window.electronAPI.getProviderCredentials();
      setApiKeys(credentials);

      const states: Record<string, ProviderState> = {};
      for (const provider of PROVIDERS) {
        const hasCred = !!credentials[provider.providerId];
        states[provider.providerId] = {
          status: hasCred ? "not_connected" : "missing_credential",
          hasCredential: hasCred,
        };
      }
      setProviderStates(states);
    } catch {
      // ignore
    }
  };

  const handleApiKeyChange = (providerId: string, value: string) => {
    setApiKeys((prev) => ({ ...prev, [providerId]: value }));
  };

  const handleSaveCredential = async (providerId: string) => {
    if (!window.electronAPI) return;

    const apiKey = apiKeys[providerId];
    if (!apiKey) return;

    try {
      await window.electronAPI.setProviderCredential(providerId, apiKey);
      setProviderStates((prev) => ({
        ...prev,
        [providerId]: { status: "not_connected", hasCredential: true },
      }));
    } catch (err) {
      setProviderStates((prev) => ({
        ...prev,
        [providerId]: {
          status: "error",
          error: err instanceof Error ? err.message : "Failed to save credential",
          hasCredential: prev[providerId]?.hasCredential ?? false,
        },
      }));
    }
  };

  const handleDeleteCredential = async (providerId: string) => {
    if (!window.electronAPI) return;

    try {
      await window.electronAPI.deleteProviderCredential(providerId);
      setApiKeys((prev) => ({ ...prev, [providerId]: "" }));
      setProviderStates((prev) => ({
        ...prev,
        [providerId]: { status: "missing_credential", hasCredential: false },
      }));
    } catch (err) {
      setProviderStates((prev) => ({
        ...prev,
        [providerId]: {
          status: "error",
          error: err instanceof Error ? err.message : "Failed to delete credential",
          hasCredential: prev[providerId]?.hasCredential ?? false,
        },
      }));
    }
  };

  const handleTestConnection = async (providerId: string) => {
    if (!window.electronAPI) return;

    setProviderStates((prev) => ({
      ...prev,
      [providerId]: { ...prev[providerId], status: "testing" },
    }));

    try {
      const result = await window.electronAPI.testProviderConnection(providerId);
      if (result.status === "available") {
        setProviderStates((prev) => ({
          ...prev,
          [providerId]: { status: "connected", hasCredential: true },
        }));
      } else {
        setProviderStates((prev) => ({
          ...prev,
          [providerId]: {
            status: "error",
            error: result.error || "Connection failed",
            hasCredential: true,
          },
        }));
      }
    } catch (err) {
      setProviderStates((prev) => ({
        ...prev,
        [providerId]: {
          status: "error",
          error: err instanceof Error ? err.message : "Connection test failed",
          hasCredential: true,
        },
      }));
    }
  };

  const toggleShowApiKey = (providerId: string) => {
    setShowApiKeys((prev) => ({ ...prev, [providerId]: !prev[providerId] }));
  };

  const anyConnected = Object.values(providerStates).some((s) => s.status === "connected");

  return (
    <div className="provider-setup">
      <div className="provider-setup-container">
        <div className="provider-setup-header">
          <h1 className="provider-setup-title">Configure Providers</h1>
          <p className="provider-setup-subtitle">
            Connect cloud AI providers to use free and paid models
          </p>
        </div>

        <div className="provider-list">
          {PROVIDERS.map((provider) => {
            const state = providerStates[provider.providerId];
            const apiKey = apiKeys[provider.providerId] || "";
            const showKey = showApiKeys[provider.providerId];

            return (
              <div key={provider.providerId} className="provider-card">
                <div className="provider-card-header">
                  <div className="provider-info">
                    <h3 className="provider-name">{provider.displayName}</h3>
                    <p className="provider-description">{provider.description}</p>
                  </div>
                  <div className={`provider-status ${state?.status || "not_connected"}`}>
                    {state?.status === "connected" && "✓ Connected"}
                    {state?.status === "testing" && "Testing..."}
                    {state?.status === "error" && "✗ Error"}
                    {state?.status === "missing_credential" && "Not configured"}
                    {state?.status === "not_connected" && "Saved"}
                  </div>
                </div>

                {state?.error && (
                  <div className="provider-error">
                    {state.error}
                  </div>
                )}

                <div className="provider-models">
                  {provider.hasFreeModels && (
                    <span className="provider-badge free">Free models available</span>
                  )}
                  {provider.hasPaidModels && (
                    <span className="provider-badge paid">Paid models available</span>
                  )}
                </div>

                <div className="provider-credentials">
                  <label htmlFor={`api-key-${provider.providerId}`}>
                    API Key ({provider.authEnv})
                  </label>
                  <div className="api-key-input-group">
                    <input
                      id={`api-key-${provider.providerId}`}
                      type={showKey ? "text" : "password"}
                      value={apiKey}
                      onChange={(e) => handleApiKeyChange(provider.providerId, e.target.value)}
                      placeholder="Enter your API key"
                      className="api-key-input"
                    />
                    <button
                      type="button"
                      onClick={() => toggleShowApiKey(provider.providerId)}
                      className="toggle-visibility-btn"
                      title={showKey ? "Hide" : "Show"}
                    >
                      {showKey ? "🙈" : "👁️"}
                    </button>
                  </div>
                  <p className="provider-help">
                    {provider.setupHelp}
                  </p>
                </div>

                <div className="provider-actions">
                  {apiKey ? (
                    <>
                      <button
                        onClick={() => handleTestConnection(provider.providerId)}
                        disabled={state?.status === "testing"}
                        className="provider-btn test"
                      >
                        {state?.status === "testing" ? "Testing..." : "Test Connection"}
                      </button>
                      <button
                        onClick={() => handleSaveCredential(provider.providerId)}
                        className="provider-btn save"
                      >
                        Save
                      </button>
                      <button
                        onClick={() => handleDeleteCredential(provider.providerId)}
                        className="provider-btn delete"
                      >
                        Delete
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => handleSaveCredential(provider.providerId)}
                      className="provider-btn save"
                      disabled={!apiKey}
                    >
                      Save
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {anyConnected && onComplete && (
          <div className="provider-setup-footer">
            <button onClick={onComplete} className="provider-btn primary">
              Continue to CodeForge
            </button>
          </div>
        )}

        <div className="provider-setup-note">
          <p>
            <strong>Free Mode:</strong> CodeForge will only use models verified as free.
            Paid models require explicit authorization.
          </p>
        </div>
      </div>
    </div>
  );
}

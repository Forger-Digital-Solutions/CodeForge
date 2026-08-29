import React, { useState, useEffect } from "react";

const SERVER_BASE_URL = "http://localhost:3210";

interface ApiModel {
  id: string;
  providerId: string;
  displayName: string;
  tier: "free" | "gems_paid" | "paid";
  freeStatus: string;
  costProfile?: {
    isFree: boolean;
    paidFallbackPossible: boolean;
  };
  isPromotional?: boolean;
}

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
    description: "Cloud AI provider with verified free models",
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
  freeModelCount?: number;
  paidModelCount?: number;
}

export default function ProviderSetup({ onComplete }: { onComplete?: () => void }) {
  const [providerStates, setProviderStates] = useState<Record<string, ProviderState>>({});
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [showApiKeys, setShowApiKeys] = useState<Record<string, boolean>>({});

  const loadProviderStates = async () => {
    if (!window.electronAPI) return;

    try {
      const credentialStatus = await window.electronAPI.getProviderCredentialStatus();
      setApiKeys({});

      const states: Record<string, ProviderState> = {};
      for (const provider of PROVIDERS) {
        const hasCred = credentialStatus[provider.providerId] === true;
        states[provider.providerId] = {
          status: hasCred ? "not_connected" : "missing_credential",
          hasCredential: hasCred,
        };
      }
      setProviderStates(states);
      
      // Refresh health for providers with credentials
      for (const provider of PROVIDERS) {
        if (credentialStatus[provider.providerId]) {
          await refreshProviderHealth(provider.providerId);
        }
      }
    } catch {
      // ignore
    }
  };

  const refreshProviderHealth = async (providerId: string) => {
    if (!window.electronAPI) return;

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
      // If health check fails, don't update state - might be temporary
    }
  };

  useEffect(() => {
    loadProviderStates();
  }, []);

  // Fetch model counts for each provider
  useEffect(() => {
    const fetchModelCounts = async () => {
      try {
        const response = await fetch(`${SERVER_BASE_URL}/api/models`);
        if (response.ok) {
          const models = await response.json() as ApiModel[];
          const counts: Record<string, { free: number; paid: number }> = {};
          
          PROVIDERS.forEach((provider) => {
            const providerModels = models.filter((m) => m.providerId === provider.providerId);
            counts[provider.providerId] = {
              free: providerModels.filter((m) => m.costProfile?.isFree || m.isPromotional).length,
              paid: providerModels.filter((m) => m.tier === "paid" || m.tier === "gems_paid").length,
            };
          });
          
          setProviderStates((prev) => {
            const updated = { ...prev };
            Object.entries(counts).forEach(([providerId, count]) => {
              if (updated[providerId]) {
                updated[providerId] = {
                  ...updated[providerId],
                  freeModelCount: count.free,
                  paidModelCount: count.paid,
                };
              }
            });
            return updated;
          });
        }
      } catch {
        // Ignore model count fetch failures
      }
    };

    fetchModelCounts();
  }, []);

  const handleApiKeyChange = (providerId: string, value: string) => {
    setApiKeys((prev) => ({ ...prev, [providerId]: value }));
  };

  const notifyProviderUpdated = () => {
    try {
      window.dispatchEvent(new CustomEvent("codeforge:provider-updated"));
    } catch {
      // ignore
    }
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
      await refreshProviderHealth(providerId);
      notifyProviderUpdated();
    } catch {
      setProviderStates((prev) => ({
        ...prev,
        [providerId]: {
          status: "error",
          error: "Failed to save credential. Please check your input and try again.",
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
      notifyProviderUpdated();
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
      [providerId]: {
        ...prev[providerId],
        status: "testing",
        hasCredential: prev[providerId]?.hasCredential ?? false,
      },
    }));

    try {
      const result = await window.electronAPI.testProviderConnection(providerId);
      if (result.status === "available") {
        setProviderStates((prev) => ({
          ...prev,
          [providerId]: { status: "connected", hasCredential: true },
        }));
      } else {
        const raw = (result.error || "").toLowerCase();
        const mapped = (() => {
          if (raw.includes("401") || raw.includes("auth") || raw.includes("credential_invalid") || raw.includes("unauthorized"))
            return "Invalid credentials — please check your API key and try again.";
          if (raw.includes("403")) return "Access denied — your API key may not have the required permissions.";
          if (raw.includes("429") || raw.includes("rate")) return "Provider is temporarily rate limited. Try again shortly.";
          if (raw.includes("timeout")) return "Connection timed out — the provider may be slow or unavailable.";
          if (raw.includes("network")) return "Network error — please check your internet connection.";
          if (raw.includes("no_free") || raw.includes("no verified free"))
            return "No verified free model is currently available.";
          if (raw.includes("free_tier_expired") || raw.includes("expired") || raw.includes("promotional"))
            return "This promotional free model has expired and is no longer verified as free.";
          if (raw.includes("payment") || raw.includes("paid") || raw.includes("paid model"))
            return "Paid model selected while in Free Mode — switch to a verified free model or connect a free provider.";
          if (raw.includes("provider_offline") || raw.includes("unavailable") || raw.includes("not registered"))
            return "Provider is currently unavailable. Please try again.";
          return result.error || "Connection failed — please check your credentials and try again.";
        })();

        setProviderStates((prev) => ({
          ...prev,
          [providerId]: {
            status: "error",
            error: mapped,
            hasCredential: true,
          },
        }));
      }
    } catch {
      setProviderStates((prev) => ({
        ...prev,
        [providerId]: {
          status: "error",
          error: "Network error — please check your internet connection.",
          hasCredential: true,
        },
      }));
    } finally {
      notifyProviderUpdated();
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
                  {state?.freeModelCount !== undefined && state.freeModelCount > 0 && (
                    <span className="provider-badge free">
                      {state.freeModelCount} free {state.freeModelCount === 1 ? "model" : "models"}
                    </span>
                  )}
                  {state?.paidModelCount !== undefined && state.paidModelCount > 0 && (
                    <span className="provider-badge paid">
                      {state.paidModelCount} paid {state.paidModelCount === 1 ? "model" : "models"}
                    </span>
                  )}
                  {state?.freeModelCount === 0 && state?.paidModelCount === 0 && (
                    <span className="provider-badge">No models available</span>
                  )}
                </div>

                <div className="provider-availability">
                  {state?.status === "connected" && (
                    <span className="availability-status available">
                      ✓ Provider connected and verified
                    </span>
                  )}
                  {state?.status === "error" && (
                    <span className="availability-status error">
                      ✗ Connection error: {state.error}
                    </span>
                  )}
                  {state?.status === "not_connected" && state.hasCredential && (
                    <span className="availability-status warning">
                      ⚠ Credential saved but not tested
                    </span>
                  )}
                  {state?.status === "missing_credential" && (
                    <span className="availability-status missing">
                      ⚠ No credential configured
                    </span>
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

        <div className="provider-setup-note" role="note" aria-label="Free Mode note">
          <p>
            <strong>Free Mode:</strong> Full-Auto selects the best currently verified free model. If no
            verified free model is available, CodeForge will not silently use a paid model. Promotional
            free models may expire.
          </p>
        </div>
      </div>
    </div>
  );
}

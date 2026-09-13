import React from "react";
import type { CanonicalModelView, ProviderRouteView } from "@codeforge/model-registry";

/**
 * Model details for a CANONICAL model (R1 §67, §129, §184): the model once, its provider routes
 * underneath with honest health/admission state. Normal users never need this; it is the
 * "advanced details" behind the ℹ button and the diagnostics table in Settings.
 */
export interface CanonicalModelDetailsProps {
  model: CanonicalModelView;
  onClose: () => void;
  onEnable?: (model: CanonicalModelView) => void;
}

export function routeHealthLabel(r: ProviderRouteView): string {
  switch (r.health) {
    case "HEALTHY":
      return "Healthy";
    case "DEGRADED":
      return "Degraded";
    case "COOLDOWN": {
      const mins = r.cooldownUntil ? Math.max(1, Math.round((r.cooldownUntil - Date.now()) / 60000)) : null;
      return mins ? `Cooldown · ${mins}m` : "Cooldown";
    }
    case "UNAVAILABLE":
      return "Unavailable";
    case "AUTH_REQUIRED":
      return "Needs credential";
    case "QUOTA_EXHAUSTED":
      return "Quota exhausted";
    case "INELIGIBLE":
      return "Ineligible";
    default:
      return "Unknown";
  }
}

export function routeStageLabel(r: ProviderRouteView): string {
  if (!r.admission.failedGate) return "ForgeAuto eligible";
  switch (r.admission.failedGate) {
    case "TERMS_ALLOWED":
      return "Excluded";
    case "AUTH_SUPPORTED":
      return "Unsupported";
    case "CONNECTED":
      return "Not connected";
    case "FREE_VERIFIED":
      return "Free not verified";
    case "CAPABILITY_VERIFIED":
      return "No tool calling";
    case "CODEFORGE_QUALIFIED":
      return r.qualificationState === "NOT_TESTED" || r.qualificationState === "STALE" ? "Qualifying" : `Qualification: ${r.qualificationState.toLowerCase()}`;
    case "HEALTHY":
      return routeHealthLabel(r);
    default:
      return "Blocked";
  }
}

export function CanonicalModelDetails({ model, onClose, onEnable }: CanonicalModelDetailsProps): React.ReactElement {
  const quota = (r: ProviderRouteView): string | null => {
    if (!r.quota) return null;
    if (r.quota.remainingRequests !== undefined && r.quota.limitRequests) return `${Math.round((r.quota.remainingRequests / r.quota.limitRequests) * 100)}% quota`;
    if (r.quota.remainingRequests !== undefined) return `${r.quota.remainingRequests} requests left`;
    return null;
  };
  return (
    <div className="model-details" role="dialog" aria-modal="true" aria-label="Model details">
      <div className="model-details-container">
        <div className="model-details-header">
          <h2 className="model-details-title">{model.displayName}</h2>
          <button className="model-details-close" onClick={onClose} aria-label="Close model details">✕</button>
        </div>
        <div className="model-details-content">
          <div className="model-details-section">
            <h3 className="model-details-section-title">Model</h3>
            <div className="model-details-row"><span className="model-details-label">Canonical id</span><span className="model-details-value">{model.canonicalId}</span></div>
            <div className="model-details-row"><span className="model-details-label">Lab / family</span><span className="model-details-value">{model.lab} · {model.family}</span></div>
            <div className="model-details-row"><span className="model-details-label">Status</span><span className="model-details-value">{model.freeBadge} · {model.category}</span></div>
            <div className="model-details-row"><span className="model-details-label">Context</span><span className="model-details-value">{model.contextWindow ? `${Math.round(model.contextWindow / 1000)}k tokens` : "Unknown"}</span></div>
            <div className="model-details-row"><span className="model-details-label">Capabilities</span><span className="model-details-value">{[model.capabilities.toolCalling ? "Tools" : null, model.capabilities.structuredOutput ? "Structured output" : null, model.capabilities.vision ? "Vision" : null].filter(Boolean).join(" · ") || "Text"}</span></div>
            <div className="model-details-row"><span className="model-details-label">8-Bit qualification</span><span className="model-details-value">{model.qualificationState.replace(/_/g, " ").toLowerCase()}{model.roles.length ? ` · ${model.roles.map((r) => r.replace(/_/g, " ").toLowerCase()).join(", ")}` : ""}</span></div>
            <div className="model-details-row"><span className="model-details-label">ForgeAuto/Free</span><span className="model-details-value">{model.forgeAutoEligible ? "Eligible" : "Not eligible right now"}</span></div>
          </div>
          <div className="model-details-section">
            <h3 className="model-details-section-title">Available routes ({model.routes.length})</h3>
            <table className="route-table">
              <thead>
                <tr><th>Provider</th><th>Access</th><th>Connection</th><th>Health</th><th>Stage</th></tr>
              </thead>
              <tbody>
                {model.routes.map((r) => (
                  <tr key={r.routeId} className={r.forgeAutoEligible ? "eligible" : undefined}>
                    <td title={r.providerModelId}>{r.providerDisplayName}</td>
                    <td>{r.freeAccessClass.replace(/_/g, " ").toLowerCase()}</td>
                    <td>{r.connected ? (r.credentialSource === "ENVIRONMENT" ? "Environment" : r.credentialSource === "OAUTH" ? "OAuth" : r.credentialSource === "FDS_GATEWAY" ? "CodeForge" : "Secure key") : "Not connected"}</td>
                    <td>{r.connected ? routeHealthLabel(r) : "—"}{quota(r) ? ` · ${quota(r)}` : ""}</td>
                    <td title={r.admission.reason}>{routeStageLabel(r)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="settings-note">Routes are provider-specific ways to reach the same model. ForgeAuto picks the healthiest free route and switches on failures. Free availability is provider-controlled and may change; 8-Bit removes routes that stop qualifying.</div>
          </div>
          {model.readiness === "FREE_CONNECT_REQUIRED" && onEnable ? (
            <div className="model-details-section">
              <button type="button" className="provider-btn primary" onClick={() => onEnable(model)}>Enable {model.displayName}</button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default CanonicalModelDetails;

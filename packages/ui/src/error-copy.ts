/**
 * User-facing wording for runtime and provider failures. Shared by the live failure banner and the
 * persisted conversation timeline so a failure reads the same during the run and after a relaunch.
 */
/** Turn provider/runtime errors into concise, actionable guidance. */
export function humanizeError(msg: string): string {
  const m = msg.toLowerCase();
  // Ownership is unknown at this layer: managed CodeForge routes and user-connected providers both
  // land here, so never assert "your API key". Classified RunFailure messages bypass this entirely.
  if (m.includes("401") || m.includes("invalid api key") || m.includes("autherror") || m.includes("unauthorized"))
    return "Provider authentication failed — the credentials on this route were rejected. If you connected this provider yourself, update its key in Settings → Providers.";
  if (m.includes("403")) return "The provider denied access on this route. If you connected this provider yourself, check its key permissions in Settings → Providers.";
  if (m.includes("429") || m.includes("rate limit")) {
    // A daily cap is not "a moment": say what the provider said.
    if (m.includes("per-day") || m.includes("per day") || m.includes("daily")) {
      return "The provider's daily free-request limit is exhausted and resets on the provider's schedule. Connect another verified free route or try again later.";
    }
    return "The provider is rate limited. Wait a moment and try again.";
  }
  if (m.includes("not found in catalog") || m.includes("no free provider") || m.includes("no verified free"))
    return "No verified free model is available. Connect a provider in Settings → Providers.";
  if (m.includes("payment") || m.includes("paid model")) return "That model requires a paid plan. Choose a verified free model or connect a provider.";
  if (m.includes("timeout")) return "The request timed out — the provider may be slow or unavailable. Try again.";
  if (m.includes("network") || m.includes("failed to fetch") || m.includes("econn")) return "Network error — check your connection and that the CodeForge server is running.";
  if (m.includes("no workspace")) return "No workspace is set. Open a project folder first.";
  return msg.length > 200 ? `${msg.slice(0, 200)}…` : msg;
}

/** Why a turn stopped, in the user's terms — a user-initiated stop is a decision, not a failure. */
export function describeTurnStop(reason?: string): string {
  const r = (reason ?? "").toLowerCase();
  if (!r || r.includes("user stopped") || r.includes("user cancelled") || r.includes("cancelled by user") || r.includes("stop requested")) return "Stopped by you";
  return humanizeError(reason ?? "");
}

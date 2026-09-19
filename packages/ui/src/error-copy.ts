/**
 * User-facing wording for runtime and provider failures. Shared by the live failure banner and the
 * persisted conversation timeline so a failure reads the same during the run and after a relaunch.
 */
/**
 * Runtime error strings arrive as "[CODE] message" — and sometimes "[CODE] [CODE] message" when a
 * lower layer already prefixed the same code. Codes are diagnostics for logs, not prose; strip the
 * leading bracket groups, remember them for the code table, and humanize the sentence that remains.
 */
const LEADING_ERROR_CODES = /^(\s*\[([A-Z][A-Z0-9_.:-]*)\])+/;
/** "CODE: prose" is the other prefix shape the runtime persists (PARALLEL_PLAN_INVALID: …). */
const LEADING_COLON_CODE = /^([A-Z][A-Z0-9_]{2,}):\s+/;

/** Codes the runtime stamps on failures that already have dedicated user-facing wording. */
const ERROR_CODE_COPY: Record<string, string> = {
  PROVIDER_UNAVAILABLE: "The model provider is temporarily unavailable — the run stopped safely. Try again in a moment.",
  PROVIDER_MODEL_UNAVAILABLE: "The selected model is unavailable right now. Choose another verified free model.",
  PROVIDER_STREAM_INTERRUPTED: "The provider connection dropped mid-response. Try again.",
  PROVIDER_CONTEXT_LIMIT: "The model's context limit was exceeded — try a smaller scope or a fresh task.",
  PROVIDER_RATE_LIMITED: "The provider is rate limited. Wait a moment and try again.",
  AGENT_CANCELLED: "Stopped — the run was cancelled",
};

function stripErrorCodes(msg: string): { codes: string[]; rest: string } {
  const match = msg.match(LEADING_ERROR_CODES);
  const codes = match
    ? Array.from(match[0].matchAll(/\[([A-Z][A-Z0-9_.:-]*)\]/g), (m) => m[1] ?? "").filter((c) => c.length > 0)
    : [];
  let rest = match ? msg.slice(match[0].length).trim() : msg;
  const colon = rest.match(LEADING_COLON_CODE);
  if (colon) {
    codes.push(colon[1] ?? "");
    rest = rest.slice(colon[0].length);
  }
  return { codes, rest };
}

/** Turn provider/runtime errors into concise, actionable guidance. */
export function humanizeError(msg: string): string {
  const { codes, rest } = stripErrorCodes(msg);
  for (const code of codes) {
    const copy = ERROR_CODE_COPY[code];
    if (copy) return copy;
  }
  const text = rest.length > 0 ? rest : msg;
  const m = `${codes.join(" ")} ${text}`.toLowerCase();
  if (m.includes("provider_unavailable") || m.includes("provider unavailable") || m.includes("503") || m.includes("502") || m.includes("bad gateway") || m.includes("service unavailable") || m.includes("upstream error") || m.includes("overloaded"))
    return "The model provider is temporarily unavailable — the run stopped safely. Try again in a moment.";
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
  // An unclassifiable error still shouldn't ship its bracketed code to the user — the stripped
  // remainder is the honest text, and a bare "[CODE]" degrades to a humanized code word.
  if (rest.length === 0) {
    const code = codes[0];
    return code ? code.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) : text;
  }
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/** Why a turn stopped, in the user's terms — a user-initiated stop is a decision, not a failure. */
export function describeTurnStop(reason?: string): string {
  const r = (reason ?? "").toLowerCase();
  if (!r || r.includes("user stopped") || r.includes("user cancelled") || r.includes("cancelled by user") || r.includes("stop requested")) return "Stopped by you";
  return humanizeError(reason ?? "");
}

/**
 * The runtime emits internal codes on `tool.execution_blocked` ("approval_rejected",
 * "forgegreen_duplicate_suppressed", …). They are diagnostics, not prose — a tool row that reads
 * "approval_rejected" makes the user parse our state machine. The raw code stays in the expanded
 * detail; the one-line summary is for the person reading it.
 */
const BLOCK_REASON_COPY: Record<string, string> = {
  approval_rejected: "You denied this action — the agent continued without it",
  approval_denied: "You denied this action",
  approval_timeout: "The approval request timed out",
  approval_expired: "The approval request expired",
  approval_cancelled: "The approval prompt was dismissed",
  policy_denied: "Blocked by this task's permission policy",
  forgegreen_duplicate_suppressed: "Skipped — this exact read was already answered against unchanged files",
  AGENT_NO_PROGRESS_DETECTED: "Stopped — no forward progress was detected",
  AGENT_TOOL_LOOP_DETECTED: "Stopped — the agent repeated the same action",
};

/** A readable one-liner for a block reason; undefined when `reason` is not a known code. */
export function humanizeBlockReason(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  const direct = BLOCK_REASON_COPY[reason];
  if (direct) return direct;
  if (reason.startsWith("approval_")) return "The action needed your approval and did not get it";
  // ALL_CAPS / snake_case codes are identifiers, not sentences — translate shape, not just words.
  if (/^[A-Z][A-Z0-9_]+$/.test(reason) || /^[a-z][a-z0-9_]*_[a-z0-9_]+$/.test(reason)) {
    return reason.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  }
  return undefined;
}

/**
 * `provider/model-id:free` → "Model Id · free". The catalog's curated display name wins when the
 * host supplies one; this is the fallback for surfaces that only have the persisted identifier.
 */
export function displayModelId(modelId: string | undefined | null): string {
  if (!modelId) return "—";
  const free = modelId.endsWith(":free");
  const bare = (free ? modelId.slice(0, -5) : modelId).split("/").at(-1) ?? modelId;
  const pretty = bare
    .split(/[-_]/)
    .filter(Boolean)
    .map((token) => (/^[a-z]/.test(token) ? token.charAt(0).toUpperCase() + token.slice(1) : token))
    .join(" ");
  return free ? `${pretty} · free` : pretty;
}

/**
 * Runtime agent ids ("agent-42253407") are correlation ids, not names. The primary label is the
 * worker's role; callers that want the id can render it in a details affordance.
 */
export function displayAgentId(agentId: string | undefined | null, role?: string): string {
  if (!agentId) return "—";
  if (/^agent-[0-9a-f]{6,}$/i.test(agentId)) return role ?? "CodeForge agent";
  return agentId;
}

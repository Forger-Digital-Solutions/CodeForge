import type { AppSettings } from "../../app-settings.js";

/**
 * Canonical per-setting registry. `app-settings.ts` owns the persisted shape and validation;
 * this file owns the *catalog*: every user-visible setting gets exactly one def here with a
 * stable id, its owning section, persistence store, scope, and search keywords. The registry is
 * the single source for setting-level search, deep-link anchors, and the scope chips rendered on
 * each row — a control that is not registered here cannot be found by search.
 *
 * Import-safe for the sandboxed renderer and the Node test harness: pure data, no node/electron.
 */

/** Who the stored value belongs to — the scope chip shown next to each control. */
export type SettingScope = "application" | "account" | "workspace";

/**
 * Where the authoritative value physically lives. `none` means the row presents live runtime or
 * detected state rather than a persisted preference.
 */
export type SettingStorage =
  | "app-settings"   // settings.json → codeforge:app-settings (zod-validated, schemaVersion'd)
  | "close-behavior" // settings.json → codeforge:close-behavior (close-lifecycle policy key)
  | "recent-projects"// settings.json → codeforge:recent-projects
  | "extension-state"// settings.json → codeforge:extensions (per-extension records)
  | "server"         // local CodeForge runtime (provider policy, env credential enablement)
  | "secure-storage" // safeStorage-sealed credentials — never visible plaintext
  | "renderer"       // renderer-local storage (model favorites)
  | "cloud"          // CodeForge Cloud account record
  | "git"            // detected from the repository's own .git/config
  | "none";          // live status, not a persisted preference

export interface SettingDef {
  /** Stable anchor id — the deep-link target `settings:<sectionId>:<id>` and DOM anchor. */
  id: string;
  /** Owning section — the only page where this control renders. */
  sectionId: string;
  /** Row title as rendered. */
  title: string;
  /** Extra search terms beyond the title (real aliases only). */
  keywords: string[];
  scope: SettingScope;
  storage: SettingStorage;
  /** Dotted path into AppSettings when storage is "app-settings" (e.g. "notifications.enabled"). */
  keyPath?: string;
  /** True when the value only takes effect after an app restart. */
  restartRequired?: boolean;
  /** True when the row holds or guards sensitive material (never rendered in plaintext). */
  sensitive?: boolean;
}

export const SETTING_DEFS: SettingDef[] = [
  // ---- General (application) ----
  { id: "open-last-workspace", sectionId: "general", title: "Open last workspace on startup",
    keywords: ["startup", "restore", "reopen", "launch"], scope: "application",
    storage: "app-settings", keyPath: "general.openLastWorkspaceOnStartup" },
  { id: "continue-interrupted-agents", sectionId: "general", title: "Continue interrupted CodeForge agents",
    keywords: ["resume", "recovery", "restart", "durable", "interrupted"], scope: "application",
    storage: "app-settings", keyPath: "general.continueInterruptedAgents" },

  // ---- Profile & Account (account) ----
  { id: "github-connection", sectionId: "profile", title: "GitHub connection",
    keywords: ["reconnect", "re-authorize", "oauth", "identity"], scope: "account",
    storage: "cloud", sensitive: true },
  { id: "sign-out", sectionId: "profile", title: "Sign out",
    keywords: ["logout", "revoke", "session"], scope: "account", storage: "cloud", sensitive: true },
  { id: "delete-account", sectionId: "profile", title: "Delete CodeForge account",
    keywords: ["remove account", "billing records", "danger"], scope: "account",
    storage: "cloud", sensitive: true },

  // ---- Appearance (application) ----
  { id: "interface-scale", sectionId: "appearance", title: "Interface scale",
    keywords: ["zoom", "density", "compact", "large", "font size", "text scale", "dpi"],
    scope: "application", storage: "app-settings", keyPath: "appearance.chatTextScale" },
  { id: "reduce-motion", sectionId: "appearance", title: "Reduce motion",
    keywords: ["animation", "transitions", "accessibility", "vestibular"], scope: "application",
    storage: "app-settings", keyPath: "appearance.reducedMotion" },

  // ---- Models & Routing (application) ----
  { id: "default-model", sectionId: "models", title: "Default model",
    keywords: ["forgeauto", "auto", "pinned model", "model picker", "routing"], scope: "application",
    storage: "app-settings", keyPath: "models.defaultModelId" },
  { id: "model-favorites", sectionId: "models", title: "Favorite models",
    keywords: ["star", "starred", "quick access", "pinned"], scope: "application",
    storage: "renderer" },
  { id: "catalog-refresh", sectionId: "models", title: "Refresh free catalog",
    keywords: ["8-bit", "registry", "re-check", "free models"], scope: "application",
    storage: "server" },

  // ---- Agents (application) ----
  { id: "default-execution-mode", sectionId: "agents", title: "Default new task mode",
    keywords: ["agent", "chat", "composer", "autonomous"], scope: "application",
    storage: "app-settings", keyPath: "agents.defaultExecutionMode" },
  { id: "steering-policy", sectionId: "agents", title: "Agent steering while typing",
    keywords: ["hold", "pause", "steer", "typeahead", "interrupt"], scope: "application",
    storage: "app-settings", keyPath: "general.defaultSteeringPolicy" },

  // ---- Verification & Safety (application — always-on facts, not toggles) ----
  { id: "forgeverify", sectionId: "verification", title: "ForgeVerify",
    keywords: ["verifiers", "checks", "tests", "evidence"], scope: "application", storage: "none" },
  { id: "completion-gate", sectionId: "verification", title: "Completion gate",
    keywords: ["blocked", "success", "enforced", "evaluate"], scope: "application", storage: "none" },
  { id: "workspace-boundary", sectionId: "verification", title: "Workspace boundaries",
    keywords: ["symlink", "sandbox", "outside", "restrict"], scope: "application", storage: "none" },
  { id: "secret-redaction", sectionId: "verification", title: "Secret redaction",
    keywords: ["credentials", "tokens", "redact", "logs"], scope: "application",
    storage: "none", sensitive: true },

  // ---- Workspaces (workspace-facing state + application prefs) ----
  { id: "recent-projects", sectionId: "workspaces", title: "Recent projects",
    keywords: ["history", "open", "switch", "remove"], scope: "application",
    storage: "recent-projects" },
  { id: "repo-index-enabled", sectionId: "workspaces", title: "Repository Intelligence indexing",
    keywords: ["structural index", "symbols", "scan", "intelligence"], scope: "application",
    storage: "app-settings", keyPath: "workspace.repositoryIndexEnabled" },
  { id: "repo-index-rebuild", sectionId: "workspaces", title: "Rebuild repository index",
    keywords: ["rescan", "reindex", "refresh index"], scope: "workspace", storage: "server" },

  // ---- Git & GitHub (workspace-detected + account) ----
  { id: "git-identity", sectionId: "git", title: "Git user.name / user.email",
    keywords: ["author", "committer", "commit identity", "config"], scope: "workspace",
    storage: "git" },

  // ---- Runtime & Execution (application facts) ----
  { id: "execution-target", sectionId: "runtime", title: "Execution model",
    keywords: ["local", "hosted", "where code runs"], scope: "application", storage: "none" },
  { id: "command-timeout", sectionId: "runtime", title: "Command timeout",
    keywords: ["60 seconds", "limit", "kill", "terminate"], scope: "application", storage: "none" },

  // ---- Notifications (application) ----
  { id: "notifications-enabled", sectionId: "notifications", title: "System notifications",
    keywords: ["toast", "alert", "os notification"], scope: "application",
    storage: "app-settings", keyPath: "notifications.enabled" },
  { id: "notify-approval", sectionId: "notifications", title: "Agent needs approval",
    keywords: ["waiting", "pending approval"], scope: "application",
    storage: "app-settings", keyPath: "notifications.onApprovalNeeded" },
  { id: "notify-completed", sectionId: "notifications", title: "Agent work finished",
    keywords: ["done", "finished", "complete"], scope: "application",
    storage: "app-settings", keyPath: "notifications.onAgentCompleted" },
  { id: "notify-background-only", sectionId: "notifications", title: "Only when CodeForge is in the background",
    keywords: ["focused", "foreground", "minimized"], scope: "application",
    storage: "app-settings", keyPath: "notifications.onlyWhenInBackground" },

  // ---- Application & Background (application) ----
  { id: "close-behavior", sectionId: "application", title: "When tasks are active and I close CodeForge",
    keywords: ["close", "tray", "minimize", "quit", "exit", "ask"], scope: "application",
    storage: "close-behavior" },
  { id: "system-tray", sectionId: "application", title: "Keep CodeForge running in the system tray",
    keywords: ["background", "tray icon", "hidden window"], scope: "application", storage: "none" },
  { id: "start-with-windows", sectionId: "application", title: "Start with Windows",
    keywords: ["login", "autostart", "boot"], scope: "application", storage: "none" },

  // ---- Data & Privacy (application) ----
  { id: "privacy-routing", sectionId: "privacy", title: "Provider routing privacy mode",
    keywords: ["strict", "standard", "maximum free", "retention", "training", "forgezero"],
    scope: "application", storage: "app-settings", keyPath: "privacy.routingMode" },
  { id: "clear-recent-projects", sectionId: "privacy", title: "Clear recent projects",
    keywords: ["history", "forget", "remove list"], scope: "application",
    storage: "recent-projects" },
  { id: "diagnostic-bundle", sectionId: "privacy", title: "Support bundle",
    keywords: ["export", "logs", "diagnostics", "sanitized"], scope: "application",
    storage: "none" },

  // ---- Provider Connections (application; values live server-side or sealed) ----
  { id: "env-credential-policy", sectionId: "providers", title: "Environment credential policy",
    keywords: ["env", "detected keys", "api key", "environment variables"], scope: "application",
    storage: "server", sensitive: true },
  { id: "provider-credentials", sectionId: "providers", title: "Provider API keys",
    keywords: ["byok", "connect", "api key", "oauth", "secret"], scope: "application",
    storage: "secure-storage", sensitive: true },
  { id: "provider-env-toggles", sectionId: "providers", title: "Per-provider environment credentials",
    keywords: ["openrouter", "groq", "gemini", "mistral", "zai", "cloudflare"], scope: "application",
    storage: "server", sensitive: true },

  // ---- Extensions (application) ----
  { id: "extension-enable", sectionId: "extensions", title: "Enable or disable extensions",
    keywords: ["plugin", "activate", "deactivate", "permissions"], scope: "application",
    storage: "extension-state" },
  { id: "extension-dev-load", sectionId: "extensions", title: "Load extension folder (developer)",
    keywords: ["development", "unpackaged", "test extension"], scope: "application",
    storage: "extension-state" },

  // ---- Advanced (application) ----
  { id: "open-data-folder", sectionId: "advanced", title: "Open data folder",
    keywords: ["settings.json", "database", "logs", "userData"], scope: "application",
    storage: "none" },
  { id: "reset-preferences", sectionId: "advanced", title: "Reset application preferences",
    keywords: ["defaults", "restore", "factory"], scope: "application",
    // An action over the app-settings store, not a stored leaf — nothing to resolve.
    storage: "none" },
];

const DEFS_BY_ID = new Map(SETTING_DEFS.map((def) => [def.id, def]));

export function getSettingDef(id: string): SettingDef | undefined {
  return DEFS_BY_ID.get(id);
}

/** All defs owned by a section, in registry order (the order rows should declare them). */
export function getSectionSettings(sectionId: string): SettingDef[] {
  return SETTING_DEFS.filter((def) => def.sectionId === sectionId);
}

export const SETTING_SCOPE_LABELS: Record<SettingScope, string> = {
  application: "This app",
  account: "Account",
  workspace: "This workspace",
};

/** Resolve a `keyPath` like "notifications.enabled" against an AppSettings value. */
export function resolveKeyPath(settings: AppSettings, keyPath: string): unknown {
  let node: unknown = settings;
  for (const part of keyPath.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

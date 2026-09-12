import React from "react";
import { GeneralSection } from "./sections/GeneralSection.js";
import { ProfileSection } from "./sections/ProfileSection.js";
import { AppearanceSection } from "./sections/AppearanceSection.js";
import { ModelsRoutingSection } from "./sections/ModelsRoutingSection.js";
import { AgentsSection } from "./sections/AgentsSection.js";
import { VerificationSafetySection } from "./sections/VerificationSafetySection.js";
import { GemsSection } from "./sections/GemsSection.js";
import { WorkspacesSection } from "./sections/WorkspacesSection.js";
import { GitGithubSection } from "./sections/GitGithubSection.js";
import { RuntimeExecutionSection } from "./sections/RuntimeExecutionSection.js";
import { NotificationsSection } from "./sections/NotificationsSection.js";
import { ApplicationBackgroundSection } from "./sections/ApplicationBackgroundSection.js";
import { DataPrivacySection } from "./sections/DataPrivacySection.js";
import { ProvidersSection } from "./sections/ProvidersSection.js";
import { AdvancedSection } from "./sections/AdvancedSection.js";
import { AboutSection } from "./sections/AboutSection.js";

export interface SettingsSectionDef {
  id: string;
  label: string;
  group: string;
  component: () => React.ReactElement;
  /** Extra search terms beyond the label — real aliases for what the section configures. */
  keywords: string[];
  description: string;
}

/**
 * The Settings sections, in navigation order. A section exists here only if it has real,
 * working content behind it — there are no placeholder categories.
 */
export const SETTINGS_SECTIONS: SettingsSectionDef[] = [
  {
    id: "general",
    label: "General",
    group: "General",
    component: GeneralSection,
    keywords: ["startup", "workspace restore", "interrupted agents", "resume", "recovery", "indexing", "default model", "summary"],
    description: "Core behavior: startup, recovery, and account summary.",
  },
  {
    id: "profile",
    label: "Profile & Account",
    group: "General",
    component: ProfileSection,
    keywords: ["account", "github", "user", "login", "username", "email", "avatar", "identity", "plan", "credits", "usage", "sign out", "delete account", "name", "profile"],
    description: "Your GitHub-backed CodeForge identity, plan, and account controls.",
  },
  {
    id: "appearance",
    label: "Appearance",
    group: "General",
    component: AppearanceSection,
    keywords: ["theme", "dark", "scale", "density", "zoom", "motion", "animation", "font"],
    description: "Theme, interface scale, and motion preferences.",
  },
  {
    id: "models",
    label: "Models & Routing",
    group: "CodeForge",
    component: ModelsRoutingSection,
    keywords: ["model", "default model", "forgeauto", "auto", "free models", "8-bit", "catalog", "forgezero", "favorites", "routing", "reasoning", "provider models", "refresh"],
    description: "Default model, ForgeAuto routing, the 8-Bit free catalog, ForgeZero, and favorites.",
  },
  {
    id: "agents",
    label: "Agents",
    group: "CodeForge",
    component: AgentsSection,
    keywords: ["agent", "chat", "mode", "approval", "approvals", "permissions", "steering", "pause", "typing", "parallel", "subagents", "tools", "commands", "completion", "budget"],
    description: "Agent mode, steering, approvals, and completion behavior.",
  },
  {
    id: "verification",
    label: "Verification & Safety",
    group: "CodeForge",
    component: VerificationSafetySection,
    keywords: ["verification", "forgeverify", "completion gate", "safety", "workspace boundary", "secret", "redaction", "destructive", "confirmation", "evidence"],
    description: "ForgeVerify, the completion gate, and always-on safety protections.",
  },
  {
    id: "gems",
    label: "GEMS",
    group: "CodeForge",
    component: GemsSection,
    keywords: ["gems", "topaz", "sapphire", "peridot", "garnet", "premium", "entitlement"],
    description: "The GEMS first-party model layer and its availability.",
  },
  {
    id: "workspaces",
    label: "Workspaces",
    group: "Workspace",
    component: WorkspacesSection,
    keywords: ["workspace", "projects", "recent", "folder", "trust", "boundary", "repository intelligence", "index"],
    description: "Workspace selection, recent projects, and Repository Intelligence.",
  },
  {
    id: "git",
    label: "Git & GitHub",
    group: "Workspace",
    component: GitGithubSection,
    keywords: ["git", "github", "branch", "worktree", "commit", "push", "pull request", "identity", "user.name", "email", "repo"],
    description: "Detected Git configuration and the connected GitHub account.",
  },
  {
    id: "runtime",
    label: "Runtime & Execution",
    group: "Workspace",
    component: RuntimeExecutionSection,
    keywords: ["runtime", "execution", "local", "hosted", "shell", "environment", "platform", "timeout", "limits", "background tasks", "continuations"],
    description: "Execution target, local runtime facts, and current runtime status.",
  },
  {
    id: "notifications",
    label: "Notifications",
    group: "System",
    component: NotificationsSection,
    keywords: ["notifications", "notify", "toast", "alert", "approval", "completed", "sound", "background"],
    description: "Operating-system notifications for agent approvals and completion.",
  },
  {
    id: "application",
    label: "Application & Background",
    group: "System",
    component: ApplicationBackgroundSection,
    keywords: ["close", "tray", "minimize", "background", "quit", "exit", "startup", "windows", "keep running", "close behavior"],
    description: "Close behavior, tray execution, and startup options.",
  },
  {
    id: "privacy",
    label: "Data & Privacy",
    group: "System",
    component: DataPrivacySection,
    keywords: ["privacy", "data", "history", "telemetry", "retention", "clear", "strict", "routing mode", "retention", "diagnostics", "provider training"],
    description: "Content handling, local history, and privacy routing.",
  },
  {
    id: "providers",
    label: "Connected Providers",
    group: "Integrations",
    component: ProvidersSection,
    keywords: ["providers", "byok", "api key", "openrouter", "z.ai", "gemini", "groq", "opencode", "anthropic", "openai", "credentials", "oauth", "integrations", "extensions", "mcp"],
    description: "Optional provider credentials — expansion beyond the built-in free catalog.",
  },
  {
    id: "advanced",
    label: "Advanced",
    group: "Advanced",
    component: AdvancedSection,
    keywords: ["advanced", "developer", "diagnostics", "logs", "catalog diagnostics", "reset", "database", "experimental"],
    description: "Diagnostics, maintenance, and preference reset.",
  },
  {
    id: "about",
    label: "About",
    group: "Advanced",
    component: AboutSection,
    keywords: ["about", "version", "update", "channel", "license", "build", "electron", "documentation", "repository"],
    description: "Version, build channel, license, and project links.",
  },
];

export const SETTINGS_GROUP_ORDER = ["General", "CodeForge", "Workspace", "System", "Integrations", "Advanced"];

export function getSettingsSection(id: string): SettingsSectionDef | undefined {
  return SETTINGS_SECTIONS.find((section) => section.id === id);
}

/** Normalize for matching: case-insensitive, split into words, drop punctuation. */
function normalize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9.]+/)
    .filter(Boolean);
}

export interface SettingsSearchResult {
  id: string;
  label: string;
  group: string;
  description: string;
}

/**
 * Search the settings index: section labels, descriptions, and keyword aliases all match.
 * "tray" finds close behavior, "github" finds the account surfaces, "model" finds routing.
 */
export function searchSettings(query: string): SettingsSearchResult[] {
  const terms = normalize(query);
  if (terms.length === 0) return [];
  const results: Array<{ section: SettingsSectionDef; score: number }> = [];
  for (const section of SETTINGS_SECTIONS) {
    const haystackLabel = normalize(section.label);
    const haystackKeywords = normalize(section.keywords.join(" "));
    const haystackDescription = normalize(section.description);
    let score = 0;
    let matchedAll = true;
    for (const term of terms) {
      if (haystackLabel.some((word) => word.startsWith(term))) score += 3;
      else if (haystackKeywords.some((word) => word.includes(term))) score += 2;
      else if (haystackDescription.some((word) => word.includes(term))) score += 1;
      else {
        matchedAll = false;
        break;
      }
    }
    if (matchedAll && score > 0) results.push({ section, score });
  }
  return results
    .sort((a, b) => b.score - a.score)
    .map(({ section }) => ({
      id: section.id,
      label: section.label,
      group: section.group,
      description: section.description,
    }));
}

import React from "react";
import { GeneralSection } from "./sections/GeneralSection.js";
import { ProfileSection } from "./sections/ProfileSection.js";
import { AppearanceSection } from "./sections/AppearanceSection.js";
import { ModelsRoutingSection } from "./sections/ModelsRoutingSection.js";
import { AgentsSection } from "./sections/AgentsSection.js";
import { VerificationSafetySection } from "./sections/VerificationSafetySection.js";
import { GemsSection } from "./sections/GemsSection.js";
import { WorkspacesSection } from "./sections/WorkspacesSection.js";
import { RepositoryIntelligenceSection } from "./sections/RepositoryIntelligenceSection.js";
import { GitGithubSection } from "./sections/GitGithubSection.js";
import { RuntimeExecutionSection } from "./sections/RuntimeExecutionSection.js";
import { NotificationsSection } from "./sections/NotificationsSection.js";
import { ApplicationBackgroundSection } from "./sections/ApplicationBackgroundSection.js";
import { DataPrivacySection } from "./sections/DataPrivacySection.js";
import { ProvidersSection } from "./sections/ProvidersSection.js";
import { FreeCapacitySection } from "./sections/FreeCapacitySection.js";
import { ExtensionsSection } from "./sections/ExtensionsSection.js";
import { AdvancedSection } from "./sections/AdvancedSection.js";
import { AboutSection } from "./sections/AboutSection.js";
import { SETTING_DEFS, SETTING_SCOPE_LABELS } from "./settings-defs.js";

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
    id: "free-capacity",
    label: "Free Capacity",
    group: "CodeForge",
    component: FreeCapacitySection,
    keywords: ["free", "capacity", "kilo", "puter", "cerebras", "cloudflare", "openrouter", "groq", "connect free", "quota"],
    description: "Connect a verified Free account and check your independent Free capacity.",
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
    keywords: ["verification", "forgeverify", "completion gate", "safety", "workspace boundary", "secret", "redaction", "destructive", "confirmation", "evidence", "forgezero", "zero billing"],
    description: "ForgeVerify, ForgeZero, the completion gate, and always-on safety protections.",
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
    keywords: ["workspace", "projects", "recent", "folder", "trust", "boundary", "remove", "open project"],
    description: "Workspace selection, recent projects, and project boundaries.",
  },
  {
    id: "repository-intelligence",
    label: "Repository Intelligence",
    group: "Workspace",
    component: RepositoryIntelligenceSection,
    keywords: ["index", "indexing", "symbols", "structural", "code intelligence", "scan", "rebuild", "repository"],
    description: "The local structural index CodeForge builds over the open workspace.",
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
    label: "Provider Connections",
    group: "Integrations",
    component: ProvidersSection,
    keywords: ["providers", "free cloud", "connect free providers", "ollama", "ollama cloud", "byok", "api key", "openrouter", "z.ai", "gemini", "groq", "cerebras", "sambanova", "mistral", "cloudflare", "opencode", "anthropic", "openai", "credentials", "oauth", "environment", "env", "integrations", "extensions", "mcp", "add provider"],
    description: "Free cloud connections, detected environment credentials, and BYOK providers.",
  },
  {
    id: "extensions",
    label: "Extensions",
    group: "Integrations",
    component: ExtensionsSection,
    keywords: ["extensions", "plugins", "add-ons", "permissions", "developer", "install", "uninstall", "enable", "disable"],
    description: "Installed extensions, their permissions, and the developer loading path.",
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
  /** Section to navigate to. */
  id: string;
  label: string;
  group: string;
  description: string;
  /** When the match is an individual setting, its anchor id inside the section. */
  settingId?: string;
  /** True when the result is the section itself rather than a setting inside it. */
  isSection: boolean;
}

/**
 * Search the settings index at the *setting* level: every registered control in SETTING_DEFS is
 * searchable by title, aliases, and scope label, and section names/descriptions/keywords still
 * match whole pages. A setting-level result deep-links straight to its row.
 */
export function searchSettings(query: string): SettingsSearchResult[] {
  const terms = normalize(query);
  if (terms.length === 0) return [];
  const results: Array<{ result: SettingsSearchResult; score: number }> = [];

  const matchScore = (haystacks: Array<{ words: string[]; weight: number }>): number => {
    let score = 0;
    for (const term of terms) {
      let termScore = 0;
      for (const { words, weight } of haystacks) {
        if (words.some((word) => word.startsWith(term))) { termScore = Math.max(termScore, weight * 2); }
        else if (words.some((word) => word.includes(term))) { termScore = Math.max(termScore, weight); }
      }
      if (termScore === 0) return 0;
      score += termScore;
    }
    return score;
  };

  for (const section of SETTINGS_SECTIONS) {
    const sectionScore = matchScore([
      { words: normalize(section.label), weight: 3 },
      { words: normalize(section.keywords.join(" ")), weight: 2 },
      { words: normalize(section.description), weight: 1 },
    ]);
    if (sectionScore > 0) {
      results.push({
        result: { id: section.id, label: section.label, group: section.group, description: section.description, isSection: true },
        score: sectionScore,
      });
    }
  }

  for (const def of SETTING_DEFS) {
    const section = getSettingsSection(def.sectionId);
    if (!section) continue;
    const score = matchScore([
      { words: normalize(def.title), weight: 3 },
      { words: normalize(def.keywords.join(" ")), weight: 2 },
      { words: normalize(SETTING_SCOPE_LABELS[def.scope]), weight: 1 },
      { words: normalize(section.label), weight: 1 },
    ]);
    if (score > 0) {
      results.push({
        result: {
          id: def.sectionId,
          settingId: def.id,
          label: def.title,
          group: section.label,
          description: SETTING_SCOPE_LABELS[def.scope],
          isSection: false,
        },
        score,
      });
    }
  }

  return results
    .sort((a, b) => b.score - a.score)
    .map(({ result }) => result);
}

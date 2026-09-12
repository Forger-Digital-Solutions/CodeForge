/**
 * Canonical application-settings schema for CodeForge Desktop.
 *
 * Every Settings-surface preference the app persists lives here behind one validated, versioned
 * object (`codeforge:app-settings` in settings.json), parsed with zod so unknown or corrupt values
 * fall back to defaults field-by-field instead of breaking the app. Existing keys with their own
 * established stores are NOT duplicated here: close behavior keeps `codeforge:close-behavior`
 * (the close-lifecycle safety policy reads it), execution mode keeps its renderer key, and provider
 * credentials keep their safeStorage-encrypted record. The Settings IPC surfaces those alongside
 * this object, but each has exactly one physical store.
 *
 * This module must stay import-safe from both the Electron main process and the sandboxed renderer:
 * no node/electron imports — pure schema + pure functions over plain data.
 */
import { z } from "zod";

export const APP_SETTINGS_KEY = "codeforge:app-settings";
export const CLOSE_BEHAVIOR_KEY = "codeforge:close-behavior";

export const APP_SETTINGS_SCHEMA_VERSION = 1;

/** Mirrors the close-lifecycle CloseBehavior. Kept in its own settings.json key. */
export const CloseBehaviorSchema = z.enum(["ask", "tray", "quit-safe"]);
export type CloseBehavior = z.infer<typeof CloseBehaviorSchema>;

const SteeringPolicySchema = z.enum(["expensive_actions_only", "off"]);
const ChatTextScaleSchema = z.enum(["small", "medium", "large"]);
const PrivacyRoutingModeSchema = z.enum(["STRICT", "STANDARD", "MAXIMUM_FREE"]);

const GeneralSettingsSchema = z.object({
  /** Open the most recent workspace automatically when the app starts. */
  openLastWorkspaceOnStartup: z.boolean().default(true),
  /**
   * After a restart, re-drive agent turns that were persisted mid-run (status "running") in
   * sessions left in the recovering hold. This only applies to CodeForge's durable recovery
   * architecture — interrupted turns are re-planned from durable facts, never replayed.
   */
  continueInterruptedAgents: z.boolean().default(true),
  /** Steer hold policy applied to new tasks. The legacy "always" value is migrated to
   * "expensive_actions_only" (both behaved identically in the runtime; exposing two identical
   * options would be a dead control). */
  defaultSteeringPolicy: SteeringPolicySchema.default("expensive_actions_only"),
});

const AppearanceSettingsSchema = z.object({
  /** Text scale for conversation/composer content. The app ships dark-only; there is no fake theme picker. */
  chatTextScale: ChatTextScaleSchema.default("medium"),
  /** Disable non-essential UI animations/transitions. */
  reducedMotion: z.boolean().default(false),
});

const ModelsSettingsSchema = z.object({
  /**
   * Persisted default model selection ("auto" = ForgeAuto/Free). Applied to the local runtime
   * on startup via /api/model-selection once the catalog confirms the model still exists —
   * the server's own selection is per-process and was never durable before this key.
   */
  defaultModelId: z.string().min(1).max(200).default("auto"),
});

const NotificationsSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  onApprovalNeeded: z.boolean().default(true),
  onAgentCompleted: z.boolean().default(true),
  /** Only fire OS notifications while the CodeForge window is not focused. */
  onlyWhenInBackground: z.boolean().default(true),
});

const PrivacySettingsSchema = z.object({
  /**
   * ForgeZero privacy routing mode. Persisted here so it survives restarts (the local server
   * holds it in memory only); the main process re-applies it after the server starts.
   */
  routingMode: PrivacyRoutingModeSchema.default("STANDARD"),
});

const WorkspaceSettingsSchema = z.object({
  /** Persist Repository Intelligence enablement across desktop/runtime restarts. */
  repositoryIndexEnabled: z.boolean().default(true),
});

export const AppSettingsSchema = z.object({
  schemaVersion: z.literal(APP_SETTINGS_SCHEMA_VERSION).default(APP_SETTINGS_SCHEMA_VERSION),
  general: GeneralSettingsSchema.default({}),
  appearance: AppearanceSettingsSchema.default({}),
  models: ModelsSettingsSchema.default({}),
  notifications: NotificationsSettingsSchema.default({}),
  privacy: PrivacySettingsSchema.default({}),
  workspace: WorkspaceSettingsSchema.default({}),
});

export type AppSettings = z.infer<typeof AppSettingsSchema>;
export type SteeringPolicy = z.infer<typeof SteeringPolicySchema>;
export type ChatTextScale = z.infer<typeof ChatTextScaleSchema>;
export type PrivacyRoutingMode = z.infer<typeof PrivacyRoutingModeSchema>;
export type ExecutionMode = "agent" | "chat";

/** Full settings surface returned by the settings IPC (canonical object + close behavior). */
export interface SettingsSnapshot {
  settings: AppSettings;
  closeBehavior: CloseBehavior;
  /** True when the canonical store did not exist when this process started. */
  fresh: boolean;
}

export const AppSettingsPatchSchema = z.object({
  general: GeneralSettingsSchema.partial().optional(),
  appearance: AppearanceSettingsSchema.partial().optional(),
  models: ModelsSettingsSchema.partial().optional(),
  notifications: NotificationsSettingsSchema.partial().optional(),
  privacy: PrivacySettingsSchema.partial().optional(),
  workspace: WorkspaceSettingsSchema.partial().optional(),
}).strict();
export type AppSettingsPatch = z.infer<typeof AppSettingsPatchSchema>;

/**
 * Parse an unknown stored value into full settings. Corrupt/unknown shapes degrade field-by-field
 * to defaults — an old or damaged settings file must never take the app down.
 */
export function parseAppSettings(raw: unknown): AppSettings {
  const result = AppSettingsSchema.safeParse(
    typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {},
  );
  if (result.success) return result.data;
  // Field-level salvage: start from defaults, then accept any group that validates on its own so a
  // single bad group cannot discard the rest of the user's preferences.
  const defaults = AppSettingsSchema.parse({});
  if (typeof raw !== "object" || raw === null) return defaults;
  const source = raw as Record<string, unknown>;
  const salvaged: AppSettings = { ...defaults };
  const salvage = <S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> | undefined => {
    const result = schema.safeParse(value);
    return result.success ? result.data : undefined;
  };
  const general = salvage(AppSettingsSchema.shape.general, source.general);
  const appearance = salvage(AppSettingsSchema.shape.appearance, source.appearance);
  const models = salvage(AppSettingsSchema.shape.models, source.models);
  const notifications = salvage(AppSettingsSchema.shape.notifications, source.notifications);
  const privacy = salvage(AppSettingsSchema.shape.privacy, source.privacy);
  const workspace = salvage(AppSettingsSchema.shape.workspace, source.workspace);
  if (general) salvaged.general = general;
  if (appearance) salvaged.appearance = appearance;
  if (models) salvaged.models = models;
  if (notifications) salvaged.notifications = notifications;
  if (privacy) salvaged.privacy = privacy;
  if (workspace) salvaged.workspace = workspace;
  return salvaged;
}

/** Validate a partial update from the renderer. Throws with a readable message on invalid input. */
export function parseAppSettingsPatch(patch: unknown): AppSettingsPatch {
  const result = AppSettingsPatchSchema.safeParse(patch ?? {});
  if (result.success) return result.data;
  const issues = result.error.issues.map((i) => `${i.path.join(".") || "patch"}: ${i.message}`).join("; ");
  throw new Error(`Invalid settings update — ${issues}`);
}

/** Pure deep merge of a validated patch over current settings (never mutates inputs). */
export function applySettingsPatch(current: AppSettings, patch: AppSettingsPatch): AppSettings {
  return {
    schemaVersion: APP_SETTINGS_SCHEMA_VERSION,
    general: { ...current.general, ...(patch.general ?? {}) },
    appearance: { ...current.appearance, ...(patch.appearance ?? {}) },
    models: { ...current.models, ...(patch.models ?? {}) },
    notifications: { ...current.notifications, ...(patch.notifications ?? {}) },
    privacy: { ...current.privacy, ...(patch.privacy ?? {}) },
    workspace: { ...current.workspace, ...(patch.workspace ?? {}) },
  };
}

/**
 * Seed canonical settings from the renderer-local value that predates the canonical store. Only
 * meaningful on the first run with the store absent — the caller decides that (settings:get
 * reports `fresh`). Legacy "always" steering maps to "expensive_actions_only": the runtime treated
 * the two identically, and a two-value setting states that truthfully instead of offering a dead
 * duplicate. (The default execution mode keeps its established renderer-side store and is not
 * migrated here.)
 */
export function migrateLegacyAppSettings(steeringPolicy: unknown): AppSettingsPatch | null {
  const steering = z.enum(["expensive_actions_only", "always", "off"]).safeParse(steeringPolicy);
  if (!steering.success) return null;
  return {
    general: {
      defaultSteeringPolicy: steering.data === "off" ? "off" : "expensive_actions_only",
    },
  };
}

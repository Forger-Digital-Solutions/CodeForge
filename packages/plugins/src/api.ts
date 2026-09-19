import type { ExtensionManifest } from "./manifest.js";
import { assertPermission } from "./permissions.js";

/**
 * The `codeforge` object handed to extension code inside the sandbox. Every capability is a
 * delegate call guarded by the manifest's declared permissions — the sandbox itself provides no
 * Node APIs, so this object is the extension's entire world.
 *
 * The object is deeply frozen: extensions cannot monkey-patch the API or hide code behind it.
 */

/** Services the host supplies; each is already extension-scoped by the caller. */
export interface ExtensionHostDelegates {
  appVersion: string;
  /** Namespaced settings — only keys declared in contributes.settings may be written. */
  getSetting(extensionId: string, key: string): unknown;
  setSetting(extensionId: string, key: string, value: unknown): void;
  /** Register a handler for a command the manifest contributed. */
  registerCommand(extensionId: string, commandId: string, handler: (...args: unknown[]) => unknown): void;
  /** Route an OS notification through the host (respects the user's notification prefs). */
  showNotification(extensionId: string, title: string, body: string): void;
  /** Workspace identity — injected only when the extension declares workspace:read. */
  getWorkspaceInfo(): { name: string; rootPath: string } | null;
  /** Per-extension sealed secrets (safeStorage-backed in production). */
  getSecret(extensionId: string, key: string): Promise<string | undefined>;
  setSecret(extensionId: string, key: string, value: string): Promise<void>;
  deleteSecret(extensionId: string, key: string): Promise<void>;
  /** Diagnostics sink — messages are prefixed with the extension id by the host. */
  log(extensionId: string, level: "info" | "warn" | "error", message: string): void;
}

export interface CodeForgeExtensionApi {
  readonly app: { readonly version: string };
  readonly workspace: { readonly name: string | null; readonly rootPath: string | null };
  readonly settings: {
    get(key: string): unknown;
    set(key: string, value: unknown): void;
  };
  readonly commands: {
    register(commandId: string, handler: (...args: unknown[]) => unknown): void;
  };
  readonly notifications: {
    show(title: string, body: string): void;
  };
  readonly secrets: {
    get(key: string): Promise<string | undefined>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
  };
}

/** Validate a value against the contributed setting def — writes outside the contract fail. */
function validateSettingValue(manifest: ExtensionManifest, key: string, value: unknown): void {
  const def = manifest.contributes.settings.find((s) => s.key === key);
  if (!def) {
    throw new Error(`Extension "${manifest.id}" tried to write undeclared setting "${key}"`);
  }
  if (def.type === "boolean" && typeof value !== "boolean") {
    throw new Error(`Setting "${key}" expects a boolean`);
  }
  if ((def.type === "string" || def.type === "enum") && typeof value !== "string") {
    throw new Error(`Setting "${key}" expects a string`);
  }
  if (def.type === "enum" && !(def.options ?? []).includes(value as string)) {
    throw new Error(`Setting "${key}" must be one of: ${(def.options ?? []).join(", ")}`);
  }
}

export function buildExtensionApi(manifest: ExtensionManifest, host: ExtensionHostDelegates): CodeForgeExtensionApi {
  // Workspace identity is read live on each access — it changes as the user opens projects,
  // so snapshotting at activation would leave activated extensions permanently stale.
  const currentWorkspace = () =>
    manifest.permissions.includes("workspace:read") ? host.getWorkspaceInfo() : null;

  const api: CodeForgeExtensionApi = {
    app: Object.freeze({ version: host.appVersion }),
    workspace: Object.freeze({
      get name() { return currentWorkspace()?.name ?? null; },
      get rootPath() { return currentWorkspace()?.rootPath ?? null; },
    }),
    settings: Object.freeze({
      get(key: string): unknown {
        assertPermission(manifest, "settings:read");
        if (typeof key !== "string" || key.length === 0) throw new Error("settings.get requires a key");
        return host.getSetting(manifest.id, key);
      },
      set(key: string, value: unknown): void {
        assertPermission(manifest, "settings:write");
        validateSettingValue(manifest, key, value);
        host.setSetting(manifest.id, key, value);
      },
    }),
    commands: Object.freeze({
      register(commandId: string, handler: (...args: unknown[]) => unknown): void {
        assertPermission(manifest, "commands:register");
        const contributed = manifest.contributes.commands.some((c) => c.id === commandId);
        if (!contributed) {
          throw new Error(`Extension "${manifest.id}" tried to register undeclared command "${commandId}"`);
        }
        if (typeof handler !== "function") throw new Error("commands.register requires a handler function");
        host.registerCommand(manifest.id, commandId, handler);
      },
    }),
    notifications: Object.freeze({
      show(title: string, body: string): void {
        assertPermission(manifest, "notifications:show");
        host.showNotification(manifest.id, String(title ?? "").slice(0, 200), String(body ?? "").slice(0, 500));
      },
    }),
    secrets: Object.freeze({
      get(key: string): Promise<string | undefined> {
        assertPermission(manifest, "secrets:read");
        return host.getSecret(manifest.id, String(key));
      },
      set(key: string, value: string): Promise<void> {
        assertPermission(manifest, "secrets:read");
        return host.setSecret(manifest.id, String(key), String(value));
      },
      delete(key: string): Promise<void> {
        assertPermission(manifest, "secrets:read");
        return host.deleteSecret(manifest.id, String(key));
      },
    }),
  };

  return Object.freeze(api);
}

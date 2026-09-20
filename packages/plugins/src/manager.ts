import fs from "node:fs";
import path from "node:path";
import { EXTENSION_MANIFEST_FILENAME, engineSatisfied, parseExtensionManifest, type ExtensionManifest } from "./manifest.js";
import { ExtensionHost, type HostedExtension } from "./host.js";
import type { ExtensionHostDelegates } from "./api.js";

/**
 * ExtensionManager — owns discovery, install state, enable/disable lifecycle, and the persisted
 * record of what is installed. All filesystem failure modes (missing dir, unreadable manifest,
 * corrupt JSON, half-copied installs) degrade to per-extension error states, never to a crash.
 *
 * Persistence is injected (ExtensionStateStore) so production binds it to settings.json and
 * tests bind it to memory; secrets go through SecretStore (safeStorage in production).
 */

export interface ExtensionRecord {
  id: string;
  /** Absolute source dir — managed store dir or the developer folder. */
  sourceDir: string;
  enabled: boolean;
  devMode: boolean;
  installedAt: string;
  /** Per-extension namespaced settings values (contributes.settings). */
  settings: Record<string, unknown>;
}

export interface ExtensionStateStore {
  load(): Record<string, ExtensionRecord>;
  save(records: Record<string, ExtensionRecord>): void;
}

export interface SecretStore {
  get(extensionId: string, key: string): Promise<string | undefined>;
  set(extensionId: string, key: string, value: string): Promise<void>;
  delete(extensionId: string, key: string): Promise<void>;
  /** Remove everything stored for an extension (uninstall cleanup). */
  deleteAll(extensionId: string): Promise<void>;
}

export interface ExtensionViewSnapshot {
  id: string;
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  status: HostedExtension["status"];
  lastError?: string;
  permissions: string[];
  devMode: boolean;
  commands: Array<{ id: string; title: string }>;
  settings: ExtensionManifest["contributes"]["settings"];
}

export interface ExtensionManagerDeps {
  /** Managed install dir, e.g. <userData>/extensions. */
  extensionsDir: string;
  stateStore: ExtensionStateStore;
  secretStore: SecretStore;
  delegates: Omit<ExtensionHostDelegates, "getSetting" | "setSetting" | "registerCommand" | "getSecret" | "setSecret" | "deleteSecret">;
  /** app.getVersion() — for engines.codeforge compatibility checks. */
  appVersion: string;
}

interface InternalExtension extends HostedExtension {
  record: ExtensionRecord;
}

export class ExtensionManager {
  private readonly host: ExtensionHost;
  private readonly loaded = new Map<string, InternalExtension>();
  private records: Record<string, ExtensionRecord>;

  constructor(private readonly deps: ExtensionManagerDeps) {
    this.records = deps.stateStore.load();
    const delegates: ExtensionHostDelegates = {
      ...deps.delegates,
      getSetting: (extensionId, key) => this.records[extensionId]?.settings[key],
      setSetting: (extensionId, key, value) => {
        const record = this.records[extensionId];
        if (!record) throw new Error(`Unknown extension "${extensionId}"`);
        record.settings[key] = value;
        this.deps.stateStore.save(this.records);
      },
      registerCommand: (extensionId, commandId, handler) => {
        this.loaded.get(extensionId)?.commands.set(commandId, handler);
      },
      getSecret: (extensionId, key) => deps.secretStore.get(extensionId, key),
      setSecret: (extensionId, key, value) => deps.secretStore.set(extensionId, key, value),
      deleteSecret: (extensionId, key) => deps.secretStore.delete(extensionId, key),
    };
    this.host = new ExtensionHost(delegates);
  }

  /** Scan the managed dir + recorded dev paths; activate every enabled extension. */
  async start(): Promise<void> {
    await this.discoverManaged();
    for (const record of Object.values(this.records)) {
      if (!this.loaded.has(record.id) && fs.existsSync(record.sourceDir)) {
        await this.loadFromDir(record.sourceDir, record);
      }
    }
    for (const ext of this.loaded.values()) {
      if (ext.record.enabled && ext.status === "installed") {
        if (!engineSatisfied(this.deps.appVersion, ext.manifest.engines?.codeforge)) {
          ext.status = "error";
          ext.lastError = `Requires CodeForge ${ext.manifest.engines?.codeforge}; this build is ${this.deps.appVersion}`;
          continue;
        }
        await this.host.activate(ext);
      }
    }
  }

  async stop(): Promise<void> {
    for (const ext of this.loaded.values()) {
      if (ext.status === "active" || ext.status === "error") await this.host.deactivate(ext);
    }
  }

  private async discoverManaged(): Promise<void> {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(this.deps.extensionsDir, { withFileTypes: true });
    } catch {
      return; // no managed dir yet — nothing installed
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(this.deps.extensionsDir, entry.name);
      const manifestPath = path.join(dir, EXTENSION_MANIFEST_FILENAME);
      if (!fs.existsSync(manifestPath)) continue;
      const record = this.records[entry.name] ?? {
        id: entry.name,
        sourceDir: dir,
        enabled: true,
        devMode: false,
        installedAt: new Date().toISOString(),
        settings: {},
      };
      if (!this.records[entry.name]) {
        this.records[entry.name] = record;
        this.persist();
      }
      await this.loadFromDir(dir, record);
    }
  }

  /** Validate manifest + construct the hosted record; failures become error-state entries. */
  private async loadFromDir(dir: string, record: ExtensionRecord): Promise<InternalExtension | null> {
    const manifestPath = path.join(dir, EXTENSION_MANIFEST_FILENAME);
    let manifest: ExtensionManifest;
    try {
      manifest = parseExtensionManifest(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
    } catch (error) {
      const ext: InternalExtension = {
        manifest: {
          id: record.id,
          name: record.id,
          version: "0.0.0",
          description: "",
          main: "extension.js",
          permissions: [],
          contributes: { commands: [], settings: [] },
          activationEvents: [],
        },
        dir,
        status: "error",
        lastError: error instanceof Error ? error.message : String(error),
        commands: new Map(),
        record,
      };
      this.loaded.set(record.id, ext);
      return ext;
    }
    if (manifest.id !== record.id) {
      const ext: InternalExtension = {
        manifest,
        dir,
        status: "error",
        lastError: `Manifest id "${manifest.id}" does not match installed id "${record.id}"`,
        commands: new Map(),
        record,
      };
      this.loaded.set(record.id, ext);
      return ext;
    }
    const ext: InternalExtension = {
      manifest,
      dir,
      status: record.enabled ? "installed" : "disabled",
      commands: new Map(),
      record,
    };
    this.loaded.set(record.id, ext);
    return ext;
  }

  private persist(): void {
    this.deps.stateStore.save(this.records);
  }

  list(): ExtensionViewSnapshot[] {
    return [...this.loaded.values()].map((ext) => ({
      id: ext.manifest.id,
      name: ext.manifest.name,
      version: ext.manifest.version,
      description: ext.manifest.description,
      enabled: ext.record.enabled,
      status: ext.record.enabled ? ext.status : "disabled",
      lastError: ext.lastError,
      permissions: ext.manifest.permissions,
      devMode: ext.record.devMode,
      commands: ext.manifest.contributes.commands.map((c) => ({ id: c.id, title: c.title })),
      settings: ext.manifest.contributes.settings,
    }));
  }

  /**
   * Developer loading: validate the manifest in place and register the folder without copying.
   * devMode extensions are marked in the UI and uninstalled by removing the record only.
   */
  async loadDeveloperExtension(dir: string): Promise<{ ok: boolean; error?: string }> {
    const manifestPath = path.join(dir, EXTENSION_MANIFEST_FILENAME);
    let manifest: ExtensionManifest;
    try {
      manifest = parseExtensionManifest(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (!engineSatisfied(this.deps.appVersion, manifest.engines?.codeforge)) {
      return { ok: false, error: `Extension requires CodeForge ${manifest.engines?.codeforge}; this build is ${this.deps.appVersion}` };
    }
    if (this.loaded.has(manifest.id)) {
      return { ok: false, error: `Extension "${manifest.id}" is already installed` };
    }
    const record: ExtensionRecord = {
      id: manifest.id,
      sourceDir: dir,
      enabled: true,
      devMode: true,
      installedAt: new Date().toISOString(),
      settings: {},
    };
    this.records[manifest.id] = record;
    this.persist();
    const ext = await this.loadFromDir(dir, record);
    if (ext && ext.status !== "error") await this.host.activate(ext);
    return { ok: true };
  }

  async setEnabled(extensionId: string, enabled: boolean): Promise<boolean> {
    const ext = this.loaded.get(extensionId);
    const record = this.records[extensionId];
    if (!ext || !record) return false;
    record.enabled = enabled;
    this.persist();
    if (!enabled) {
      await this.host.deactivate(ext);
      ext.status = "disabled";
    } else {
      if (!engineSatisfied(this.deps.appVersion, ext.manifest.engines?.codeforge)) {
        ext.status = "error";
        ext.lastError = `Requires CodeForge ${ext.manifest.engines?.codeforge}; this build is ${this.deps.appVersion}`;
        return true;
      }
      ext.status = "installed";
      await this.host.activate(ext);
    }
    return true;
  }

  async uninstall(extensionId: string): Promise<boolean> {
    const ext = this.loaded.get(extensionId);
    const record = this.records[extensionId];
    if (!record) return false;
    if (ext) await this.host.deactivate(ext);
    this.loaded.delete(extensionId);
    delete this.records[extensionId];
    this.persist();
    await this.deps.secretStore.deleteAll(extensionId).catch(() => {});
    if (!record.devMode) {
      // Managed installs were copied into the store — remove the copy. Dev links never delete
      // the developer's source folder.
      try {
        fs.rmSync(record.sourceDir, { recursive: true, force: true });
      } catch {
        // best-effort: the record is already gone, files can be cleaned manually
      }
    }
    return true;
  }

  getSetting(extensionId: string, key: string): unknown {
    return this.records[extensionId]?.settings[key];
  }

  setSetting(extensionId: string, key: string, value: unknown): boolean {
    const ext = this.loaded.get(extensionId);
    const record = this.records[extensionId];
    if (!ext || !record) return false;
    const def = ext.manifest.contributes.settings.find((s) => s.key === key);
    if (!def) return false;
    if (def.type === "boolean" && typeof value !== "boolean") return false;
    if ((def.type === "string" || def.type === "enum") && typeof value !== "string") return false;
    if (def.type === "enum" && !(def.options ?? []).includes(value as string)) return false;
    record.settings[key] = value;
    this.persist();
    return true;
  }

  async runCommand(extensionId: string, commandId: string, args: unknown[] = []): Promise<{ ok: boolean; error?: string; result?: string }> {
    const ext = this.loaded.get(extensionId);
    if (!ext || !ext.record.enabled) return { ok: false, error: "Extension is not enabled" };
    return this.host.runCommand(ext, commandId, args);
  }
}

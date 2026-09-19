import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ExtensionManager,
  ExtensionHost,
  ManifestError,
  PermissionDeniedError,
  assertPermission,
  engineSatisfied,
  parseExtensionManifest,
  type ExtensionRecord,
  type ExtensionStateStore,
  type SecretStore,
} from "../src/index.js";

/**
 * Extension foundation tests — manifest validation, sandbox isolation, permission enforcement,
 * lifecycle, failure containment, and persistence. The abuse cases are deliberate: broken
 * manifests, sandbox-escape attempts, throwing activations, hanging commands.
 */

function makeManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "acme.demo",
    name: "Demo",
    version: "1.0.0",
    description: "test extension",
    main: "extension.js",
    permissions: [],
    contributes: { commands: [], settings: [] },
    activationEvents: [],
    ...overrides,
  };
}

let tmpDir: string;

function writeExtension(dir: string, manifest: Record<string, unknown>, mainCode: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "codeforge-extension.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, String(manifest.main ?? "extension.js")), mainCode);
}

function memoryStateStore(): ExtensionStateStore & { data: Record<string, ExtensionRecord> } {
  const data: Record<string, ExtensionRecord> = {};
  return {
    data,
    // Deep copies both ways: the store must never alias the manager's live records.
    load: () => JSON.parse(JSON.stringify(data)) as Record<string, ExtensionRecord>,
    save: (records) => {
      for (const key of Object.keys(data)) delete data[key];
      Object.assign(data, JSON.parse(JSON.stringify(records)) as Record<string, ExtensionRecord>);
    },
  };
}

function memorySecretStore(): SecretStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: async (ext, key) => data.get(`${ext}:${key}`),
    set: async (ext, key, value) => void data.set(`${ext}:${key}`, value),
    delete: async (ext, key) => void data.delete(`${ext}:${key}`),
    deleteAll: async (ext) => {
      for (const key of [...data.keys()]) if (key.startsWith(`${ext}:`)) data.delete(key);
    },
  };
}

function makeManager(stateStore = memoryStateStore(), secretStore = memorySecretStore()) {
  const notifications: Array<{ ext: string; title: string }> = [];
  const logs: string[] = [];
  const manager = new ExtensionManager({
    extensionsDir: path.join(tmpDir, "managed"),
    stateStore,
    secretStore,
    appVersion: "0.4.0",
    delegates: {
      appVersion: "0.4.0",
      showNotification: (ext, title) => { notifications.push({ ext, title }); },
      getWorkspaceInfo: () => ({ name: "demo-ws", rootPath: "C:/work/demo" }),
      log: (ext, level, msg) => logs.push(`[${ext}] ${level}: ${msg}`),
    },
  });
  return { manager, notifications, logs, stateStore, secretStore };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-ext-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("manifest validation", () => {
  it("accepts a valid manifest and applies defaults", () => {
    const m = parseExtensionManifest({ id: "acme.demo", name: "Demo", version: "1.0.0", main: "extension.js" });
    expect(m.permissions).toEqual([]);
    expect(m.contributes.commands).toEqual([]);
  });

  it.each([
    ["unnamespaced id", { id: "demo" }],
    ["uppercase bad id", { id: "ACME..demo" }],
    ["bad version", { version: "1.0" }],
    ["path-escaping main", { main: "../outside.js" }],
    ["absolute main", { main: "C:/evil.js" }],
    ["unknown permission", { permissions: ["fs:full-access"] }],
    ["unknown manifest key", { evil: true }],
  ])("rejects %s", (_label, override) => {
    expect(() => parseExtensionManifest(makeManifest(override as Record<string, unknown>))).toThrow(ManifestError);
  });

  it("rejects enum settings without options", () => {
    expect(() =>
      parseExtensionManifest(makeManifest({ contributes: { commands: [], settings: [{ key: "mode", type: "enum", label: "Mode" }] } })),
    ).toThrow(ManifestError);
  });

  it("evaluates engines.codeforge ranges", () => {
    expect(engineSatisfied("0.4.0", "*")).toBe(true);
    expect(engineSatisfied("0.4.0", ">=0.3.0")).toBe(true);
    expect(engineSatisfied("0.4.0", ">=0.5.0")).toBe(false);
    expect(engineSatisfied("0.4.1", "^0.4.0")).toBe(true);
    expect(engineSatisfied("1.0.0", "^0.4.0")).toBe(false);
  });
});

describe("sandbox isolation", () => {
  it("extension code has no require, process, fs, fetch, or timers", async () => {
    const dir = path.join(tmpDir, "acme.probe");
    writeExtension(dir, makeManifest({
      contributes: { commands: [{ id: "probe.env", title: "Probe" }], settings: [] },
      permissions: ["commands:register"],
    }), `
      module.exports = {
        activate(codeforge) {
          codeforge.commands.register("probe.env", () => {
            const probe = {};
            try { probe.require = typeof require; } catch (e) { probe.require = "threw"; }
            try { probe.process = typeof process; } catch (e) { probe.process = "threw"; }
            try { probe.fetch = typeof fetch; } catch (e) { probe.fetch = "threw"; }
            try { probe.setTimeout = typeof setTimeout; } catch (e) { probe.setTimeout = "threw"; }
            try { probe.globalProcess = typeof globalThis.process; } catch (e) { probe.globalProcess = "threw"; }
            codeforge.settings && undefined;
            globalThis.__probe = probe;
          });
        }
      };
    `);
    const { manager } = makeManager();
    expect((await manager.loadDeveloperExtension(dir)).ok).toBe(true);
    const ext = manager.list()[0]!;
    expect(ext.status).toBe("active");
    // The command ran inside the sandbox; reach its record through the host-side handle.
    const internal = (manager as unknown as { loaded: Map<string, { context?: object }> }).loaded.get("acme.demo")!;
    const result = await manager.runCommand("acme.demo", "probe.env");
    expect(result.ok).toBe(true);
    const probe = (internal.context as Record<string, unknown> | undefined)?.__probe as Record<string, string>;
    expect(probe.require).toBe("undefined");
    expect(probe.process).toBe("undefined");
    expect(probe.fetch).toBe("undefined");
    expect(probe.setTimeout).toBe("undefined");
    expect(probe.globalProcess).toBe("undefined");
  });

  it("a syntax-error extension degrades to error state without crashing the manager", async () => {
    const dir = path.join(tmpDir, "acme.broken");
    writeExtension(dir, makeManifest(), "this is not javascript ((((");
    const { manager } = makeManager();
    const res = await manager.loadDeveloperExtension(dir);
    expect(res.ok).toBe(true); // registered; activation failure is contained
    const ext = manager.list().find((e) => e.id === "acme.demo")!;
    expect(ext.status).toBe("error");
    expect(ext.lastError).toBeTruthy();
  });

  it("an activate() that throws is contained and reported", async () => {
    const dir = path.join(tmpDir, "acme.thrower");
    writeExtension(dir, makeManifest(), `module.exports = { activate() { throw new Error("boom"); } };`);
    const { manager } = makeManager();
    await manager.loadDeveloperExtension(dir);
    const ext = manager.list()[0]!;
    expect(ext.status).toBe("error");
    expect(ext.lastError).toContain("boom");
  });

  it("a top-level infinite loop is killed by the evaluation timeout", async () => {
    const dir = path.join(tmpDir, "acme.loop");
    writeExtension(dir, makeManifest(), "while (true) {}");
    const { manager } = makeManager();
    const started = Date.now();
    await manager.loadDeveloperExtension(dir);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(manager.list()[0]!.status).toBe("error");
  }, 15_000);
});

describe("permission enforcement", () => {
  it("rejects undeclared capability calls", async () => {
    const dir = path.join(tmpDir, "acme.greedy");
    writeExtension(dir, makeManifest({
      contributes: { commands: [{ id: "greedy.try", title: "Try" }], settings: [] },
      permissions: ["commands:register"],
    }), `
      module.exports = {
        activate(codeforge) {
          codeforge.commands.register("greedy.try", () => {
            const out = {};
            try { codeforge.settings.get("x"); } catch (e) { out.settings = e.name; }
            try { codeforge.notifications.show("hi","there"); } catch (e) { out.notifications = e.name; }
            try { codeforge.secrets.get("k"); } catch (e) { out.secrets = e.name; }
            try { codeforge.commands.register("not.contributed", () => {}); } catch (e) { out.commands = e.message; }
            globalThis.__out = out;
          });
        }
      };
    `);
    const { manager } = makeManager();
    await manager.loadDeveloperExtension(dir);
    await manager.runCommand("acme.demo", "greedy.try");
    const internal = (manager as unknown as { loaded: Map<string, { context?: object }> }).loaded.get("acme.demo")!;
    const out = (internal.context as Record<string, unknown> | undefined)?.__out as Record<string, string>;
    expect(out.settings).toBe("PermissionDeniedError");
    expect(out.notifications).toBe("PermissionDeniedError");
    expect(out.secrets).toBe("PermissionDeniedError");
    expect(out.commands).toContain("undeclared command");
  });

  it("grants capabilities when declared", async () => {
    const dir = path.join(tmpDir, "acme.polite");
    writeExtension(dir, makeManifest({
      permissions: ["commands:register", "settings:read", "settings:write", "notifications:show", "workspace:read"],
      contributes: {
        commands: [{ id: "polite.run", title: "Run" }],
        settings: [{ key: "mode", type: "enum", label: "Mode", options: ["a", "b"], default: "a" }],
      },
    }), `
      module.exports = {
        activate(codeforge) {
          codeforge.commands.register("polite.run", () => {
            codeforge.settings.set("mode", "b");
            codeforge.notifications.show("t", "b");
            globalThis.__ws = codeforge.workspace.rootPath;
          });
        }
      };
    `);
    const { manager, notifications } = makeManager();
    await manager.loadDeveloperExtension(dir);
    const result = await manager.runCommand("acme.demo", "polite.run");
    expect(result.ok).toBe(true);
    expect(manager.getSetting("acme.demo", "mode")).toBe("b");
    expect(notifications).toEqual([{ ext: "acme.demo", title: "t" }]);
    const internal = (manager as unknown as { loaded: Map<string, { context?: object }> }).loaded.get("acme.demo")!;
    expect((internal.context as Record<string, unknown> | undefined)?.__ws).toBe("C:/work/demo");
  });

  it("rejects setting writes that violate the contributed schema", async () => {
    const dir = path.join(tmpDir, "acme.schema");
    writeExtension(dir, makeManifest({
      permissions: ["commands:register", "settings:write"],
      contributes: {
        commands: [{ id: "s.set", title: "Set" }],
        settings: [{ key: "flag", type: "boolean", label: "Flag" }],
      },
    }), `
      module.exports = {
        activate(codeforge) {
          codeforge.commands.register("s.set", () => {
            const out = {};
            try { codeforge.settings.set("flag", "not-a-bool"); } catch (e) { out.badType = e.message; }
            try { codeforge.settings.set("undeclared", true); } catch (e) { out.undeclared = e.message; }
            codeforge.settings.set("flag", true);
            globalThis.__out = out;
          });
        }
      };
    `);
    const { manager } = makeManager();
    await manager.loadDeveloperExtension(dir);
    await manager.runCommand("acme.demo", "s.set");
    const internal = (manager as unknown as { loaded: Map<string, { context?: object }> }).loaded.get("acme.demo")!;
    const out = (internal.context as Record<string, unknown> | undefined)?.__out as Record<string, string>;
    expect(out.badType).toContain("boolean");
    expect(out.undeclared).toContain("undeclared");
    expect(manager.getSetting("acme.demo", "flag")).toBe(true);
  });
});

describe("lifecycle & persistence", () => {
  it("disable → deactivate → enable → reactivate round-trips", async () => {
    const dir = path.join(tmpDir, "acme.lifecycle");
    writeExtension(dir, makeManifest(), `
      module.exports = {
        activate() { globalThis.__active = (globalThis.__active || 0) + 1; },
        deactivate() { globalThis.__deactivated = true; }
      };
    `);
    const { manager } = makeManager();
    await manager.loadDeveloperExtension(dir);
    expect(manager.list()[0]!.status).toBe("active");
    expect(await manager.setEnabled("acme.demo", false)).toBe(true);
    expect(manager.list()[0]!.status).toBe("disabled");
    expect(await manager.setEnabled("acme.demo", true)).toBe(true);
    expect(manager.list()[0]!.status).toBe("active");
  });

  it("workspace:read reflects a workspace opened after activation", async () => {
    // Extensions activate at boot, before any project is open. Workspace identity must be
    // resolved per access — a snapshot taken at activation would read null forever.
    let workspace: { name: string; rootPath: string } | null = null;
    const dir = path.join(tmpDir, "acme.latews");
    writeExtension(dir, makeManifest({
      permissions: ["commands:register", "workspace:read"],
      contributes: { commands: [{ id: "ws.check", title: "Check" }], settings: [] },
    }), `
      module.exports = {
        activate(cf) {
          cf.commands.register("ws.check", () => {
            if (cf.workspace.name !== "late-ws") throw new Error("stale workspace: " + cf.workspace.name);
          });
        },
      };
    `);
    const manager = new ExtensionManager({
      extensionsDir: path.join(tmpDir, "managed"),
      stateStore: memoryStateStore(),
      secretStore: memorySecretStore(),
      appVersion: "0.4.0",
      delegates: {
        appVersion: "0.4.0",
        showNotification: () => {},
        getWorkspaceInfo: () => workspace,
        log: () => {},
      },
    });
    await manager.loadDeveloperExtension(dir);
    expect(manager.list()[0]!.status).toBe("active");
    workspace = { name: "late-ws", rootPath: "C:/work/late" };
    const res = await manager.runCommand("acme.demo", "ws.check");
    expect(res.ok).toBe(true);
  });

  it("a throwing command marks the extension error but the host survives", async () => {
    const dir = path.join(tmpDir, "acme.cmdthrow");
    writeExtension(dir, makeManifest({
      permissions: ["commands:register"],
      contributes: { commands: [{ id: "x.boom", title: "Boom" }], settings: [] },
    }), `
      module.exports = { activate(cf) { cf.commands.register("x.boom", () => { throw new Error("cmd fail"); }); } };
    `);
    const { manager } = makeManager();
    await manager.loadDeveloperExtension(dir);
    const res = await manager.runCommand("acme.demo", "x.boom");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("cmd fail");
    expect(manager.list()[0]!.status).toBe("error");
  });

  it("uninstall removes the record and secrets but keeps the dev folder", async () => {
    const dir = path.join(tmpDir, "acme.removed");
    writeExtension(dir, makeManifest({ permissions: ["secrets:read"] }), "module.exports = {};");
    const secrets = memorySecretStore();
    const { manager, stateStore } = makeManager(memoryStateStore(), secrets);
    await manager.loadDeveloperExtension(dir);
    await secrets.set("acme.demo", "token", "s3cr3t");
    expect(fs.existsSync(path.join(dir, "extension.js"))).toBe(true);
    expect(await manager.uninstall("acme.demo")).toBe(true);
    expect(manager.list()).toHaveLength(0);
    expect(stateStore.data["acme.demo"]).toBeUndefined();
    expect(secrets.data.size).toBe(0);
    // devMode → source folder preserved
    expect(fs.existsSync(path.join(dir, "extension.js"))).toBe(true);
  });

  it("incompatible engines.codeforge refuses activation with a truthful status", async () => {
    const dir = path.join(tmpDir, "acme.future");
    writeExtension(dir, makeManifest({ engines: { codeforge: ">=9.9.9" } }), "module.exports = {};");
    const { manager } = makeManager();
    const res = await manager.loadDeveloperExtension(dir);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("requires CodeForge");
  });

  it("managed extensions restart cleanly from persisted state", async () => {
    const state = memoryStateStore();
    const managed = path.join(tmpDir, "managed", "acme.persist");
    writeExtension(managed, makeManifest({ id: "acme.persist", permissions: ["settings:write"], contributes: { commands: [], settings: [{ key: "n", type: "string", label: "N" }] } }), "module.exports = {};");
    const first = makeManager(state);
    await first.manager.start();
    expect(first.manager.list().map((e) => e.id)).toContain("acme.persist");
    first.manager.setSetting("acme.persist", "n", "kept");
    // Simulate an app restart: new manager, same state store + managed dir.
    const second = makeManager(state);
    await second.manager.start();
    expect(second.manager.list()[0]!.status).toBe("active");
    expect(second.manager.getSetting("acme.persist", "n")).toBe("kept");
  });

  it("corrupt manifest on disk is reported as error, not a crash", async () => {
    const managed = path.join(tmpDir, "managed", "acme.corrupt");
    fs.mkdirSync(managed, { recursive: true });
    fs.writeFileSync(path.join(managed, "codeforge-extension.json"), "{not json");
    const { manager } = makeManager();
    await manager.start();
    const ext = manager.list()[0]!;
    expect(ext.status).toBe("error");
    expect(ext.enabled).toBe(true);
  });

  it("assertPermission throws a typed error naming the extension and permission", () => {
    const manifest = parseExtensionManifest(makeManifest());
    expect(() => assertPermission(manifest, "secrets:read")).toThrow(PermissionDeniedError);
    try {
      assertPermission(manifest, "secrets:read");
    } catch (e) {
      expect((e as PermissionDeniedError).permission).toBe("secrets:read");
    }
  });
});

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync, createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  canonicalize,
  MARKETPLACE_ERRORS,
  MarketplaceClient,
  MarketplaceError,
  signMarketplaceIndex,
  type FetchLike,
  type MarketplaceCatalogEntry,
  type MarketplaceIndex,
} from "../src/catalog.js";
import { ExtensionManager, type ExtensionRecord } from "../src/manager.js";
import { EXTENSION_MANIFEST_FILENAME } from "../src/manifest.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUB_B64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");
const PRIV_B64 = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
const KEY_ID = "codeforge-release-2026-09";

function sha256(b: Buffer | string): string {
  return createHash("sha256").update(b).digest("hex");
}

const MANIFEST = {
  id: "acme.hello",
  name: "Hello",
  version: "1.0.0",
  description: "says hi",
  main: "extension.js",
  permissions: ["notifications:show", "commands:register"],
  contributes: { commands: [{ id: "hello.sayHi", title: "Say Hi" }], settings: [] },
  activationEvents: [],
};

const EXT_JS = "module.exports = { activate(codeforge) { codeforge.commands.register('hello.sayHi', () => 'hi'); } };";

function makePackage(manifest: unknown = MANIFEST, extraFiles: Array<{ path: string; content: string }> = []): Buffer {
  const files = [
    { path: EXTENSION_MANIFEST_FILENAME, content: JSON.stringify(manifest) },
    { path: "extension.js", content: EXT_JS },
    ...extraFiles,
  ].map((f) => {
    const buf = Buffer.from(f.content);
    return { path: f.path, sha256: sha256(buf), content: buf.toString("base64") };
  });
  return Buffer.from(JSON.stringify({ schema: "codeforge-extension-package-1", manifest, files }));
}

function makeEntry(pkg: Buffer, overrides: Partial<MarketplaceCatalogEntry> = {}): MarketplaceCatalogEntry {
  return {
    id: "acme.hello",
    name: "Hello",
    version: "1.0.0",
    description: "says hi",
    publisher: "acme",
    downloadUrl: "https://market.codeforge.dev/pkg/acme.hello.json",
    sha256: sha256(pkg),
    sizeBytes: pkg.length,
    permissions: ["notifications:show", "commands:register"],
    ...overrides,
  };
}

function makeIndex(entries: MarketplaceCatalogEntry[], keyId = KEY_ID, priv = PRIV_B64): MarketplaceIndex {
  return signMarketplaceIndex(
    { schema: "codeforge-marketplace-index-1", publisher: "codeforge", generatedAt: "2026-09-24T00:00:00Z", extensions: entries },
    priv,
    keyId,
  );
}

function fakeFetch(routes: Record<string, Buffer | { status: number }>): FetchLike {
  return async (url) => {
    const body = routes[url];
    if (!body) return { status: 404, url, arrayBuffer: async () => new ArrayBuffer(0) };
    if ("status" in body && !Buffer.isBuffer(body)) {
      return { status: body.status, url, arrayBuffer: async () => new ArrayBuffer(0) };
    }
    const buf = body as Buffer;
    return { status: 200, url, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer };
  };
}

const INDEX_URL = "https://market.codeforge.dev/index.json";

function client(fetchImpl: FetchLike, extra: Partial<ConstructorParameters<typeof MarketplaceClient>[0]> = {}): MarketplaceClient {
  return new MarketplaceClient({ fetchImpl, trustedKeys: { [KEY_ID]: PUB_B64 }, ...extra });
}

describe("marketplace index trust", () => {
  const pkg = makePackage();
  const entry = makeEntry(pkg);
  const index = makeIndex([entry]);
  const indexBytes = Buffer.from(JSON.stringify(index));

  it("fetches and verifies a properly signed index", async () => {
    const c = client(fakeFetch({ [INDEX_URL]: indexBytes }));
    const result = await c.fetchIndex(INDEX_URL);
    expect(result.extensions).toHaveLength(1);
    expect(result.publisher).toBe("codeforge");
  });

  it("rejects an index whose contents were tampered after signing", async () => {
    const tampered = { ...index, extensions: [{ ...entry, sha256: "0".repeat(64) }] };
    const c = client(fakeFetch({ [INDEX_URL]: Buffer.from(JSON.stringify(tampered)) }));
    await expect(c.fetchIndex(INDEX_URL)).rejects.toMatchObject({ code: MARKETPLACE_ERRORS.MARKETPLACE_BAD_SIGNATURE });
  });

  it("rejects an index signed by an untrusted key", async () => {
    const other = generateKeyPairSync("ed25519");
    const badIndex = makeIndex([entry], "attacker-key", other.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"));
    const c = client(fakeFetch({ [INDEX_URL]: Buffer.from(JSON.stringify(badIndex)) }));
    await expect(c.fetchIndex(INDEX_URL)).rejects.toMatchObject({ code: MARKETPLACE_ERRORS.MARKETPLACE_UNTRUSTED_KEY });
  });

  it("rejects an unsigned index", async () => {
    const { signature, ...unsigned } = index;
    const c = client(fakeFetch({ [INDEX_URL]: Buffer.from(JSON.stringify(unsigned)) }));
    await expect(c.fetchIndex(INDEX_URL)).rejects.toMatchObject({ code: MARKETPLACE_ERRORS.MARKETPLACE_INVALID_INDEX });
  });

  it("rejects malformed index JSON and schema violations", async () => {
    const c = client(fakeFetch({ [INDEX_URL]: Buffer.from("not json{") }));
    await expect(c.fetchIndex(INDEX_URL)).rejects.toMatchObject({ code: MARKETPLACE_ERRORS.MARKETPLACE_INVALID_INDEX });
    const c2 = client(fakeFetch({ [INDEX_URL]: Buffer.from(JSON.stringify({ schema: "codeforge-marketplace-index-1", publisher: "x", generatedAt: "t", extensions: "no" })) }));
    await expect(c2.fetchIndex(INDEX_URL)).rejects.toMatchObject({ code: MARKETPLACE_ERRORS.MARKETPLACE_INVALID_INDEX });
  });

  it("refuses plain HTTP for non-loopback sources and oversized indexes", async () => {
    const c = client(fakeFetch({}));
    await expect(c.fetchIndex("http://market.codeforge.dev/index.json")).rejects.toMatchObject({ code: MARKETPLACE_ERRORS.MARKETPLACE_TRANSPORT });
    const loopback = "http://127.0.0.1:8787/index.json";
    const cLoop = client(fakeFetch({ [loopback]: indexBytes }));
    await expect(cLoop.fetchIndex(loopback)).rejects.toMatchObject({ code: MARKETPLACE_ERRORS.MARKETPLACE_TRANSPORT });
    const cLoopOk = client(fakeFetch({ [loopback]: indexBytes }), { allowInsecureLoopback: true });
    expect((await cLoopOk.fetchIndex(loopback)).publisher).toBe("codeforge");
    const cSmall = client(fakeFetch({ [INDEX_URL]: indexBytes }), { maxIndexBytes: 64 });
    await expect(cSmall.fetchIndex(INDEX_URL)).rejects.toMatchObject({ code: MARKETPLACE_ERRORS.MARKETPLACE_TOO_LARGE });
  });

  it("propagates transport failures and non-200 statuses", async () => {
    const c = client(fakeFetch({ [INDEX_URL]: { status: 503 } }));
    await expect(c.fetchIndex(INDEX_URL)).rejects.toMatchObject({ code: MARKETPLACE_ERRORS.MARKETPLACE_TRANSPORT });
    const cDead = client(async () => { throw new Error("ECONNREFUSED"); });
    await expect(cDead.fetchIndex(INDEX_URL)).rejects.toMatchObject({ code: MARKETPLACE_ERRORS.MARKETPLACE_TRANSPORT });
  });
});

describe("marketplace package install", () => {
  let extensionsDir: string;
  beforeEach(() => { extensionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-mkt-")); });
  afterEach(() => { fs.rmSync(extensionsDir, { recursive: true, force: true }); });

  it("installs a verified package into the managed dir", async () => {
    const pkg = makePackage();
    const entry = makeEntry(pkg);
    const c = client(fakeFetch({ [entry.downloadUrl]: pkg }));
    const { dir, manifest } = await c.install(entry, extensionsDir);
    expect(manifest.id).toBe("acme.hello");
    expect(fs.readFileSync(path.join(dir, "extension.js"), "utf8")).toBe(EXT_JS);
    expect(JSON.parse(fs.readFileSync(path.join(dir, EXTENSION_MANIFEST_FILENAME), "utf8")).id).toBe("acme.hello");
  });

  it("rejects a package whose bytes do not match the catalog sha256", async () => {
    const pkg = makePackage();
    const entry = makeEntry(pkg);
    const evil = makePackage({ ...MANIFEST, name: "Evil" });
    const c = client(fakeFetch({ [entry.downloadUrl]: evil }));
    await expect(c.install(entry, extensionsDir)).rejects.toMatchObject({ code: MARKETPLACE_ERRORS.MARKETPLACE_HASH_MISMATCH });
    expect(fs.readdirSync(extensionsDir)).toHaveLength(0);
  });

  it("rejects a package whose manifest id does not match the catalog entry", async () => {
    const wrongId = { ...MANIFEST, id: "acme.other" };
    const pkg = makePackage(wrongId);
    const entry = makeEntry(pkg);
    const c = client(fakeFetch({ [entry.downloadUrl]: pkg }));
    await expect(c.install(entry, extensionsDir)).rejects.toMatchObject({ code: MARKETPLACE_ERRORS.MARKETPLACE_INVALID_PACKAGE });
  });

  it("rejects traversal and absolute package paths", async () => {
    for (const bad of ["../escape.js", "sub/../../escape.js", "/abs.js", "C:\\win.js", "sub\\..\\x.js"]) {
      const files = [{ path: bad, sha256: sha256("x"), content: Buffer.from("x").toString("base64") }];
      const pkg = Buffer.from(JSON.stringify({ schema: "codeforge-extension-package-1", manifest: MANIFEST, files }));
      const entry = makeEntry(pkg);
      const c = client(fakeFetch({ [entry.downloadUrl]: pkg }));
      await expect(c.install(entry, extensionsDir)).rejects.toMatchObject({ code: MARKETPLACE_ERRORS.MARKETPLACE_UNSAFE_PATH });
    }
  });

  it("rejects a file whose content fails its own sha256", async () => {
    const pkg = Buffer.from(JSON.stringify({
      schema: "codeforge-extension-package-1",
      manifest: MANIFEST,
      files: [
        { path: "extension.js", sha256: "0".repeat(64), content: Buffer.from(EXT_JS).toString("base64") },
        { path: EXTENSION_MANIFEST_FILENAME, sha256: sha256(JSON.stringify(MANIFEST)), content: Buffer.from(JSON.stringify(MANIFEST)).toString("base64") },
      ],
    }));
    const entry = makeEntry(pkg);
    const c = client(fakeFetch({ [entry.downloadUrl]: pkg }));
    await expect(c.install(entry, extensionsDir)).rejects.toMatchObject({ code: MARKETPLACE_ERRORS.MARKETPLACE_HASH_MISMATCH });
  });

  it("rejects installing over an existing extension dir and cleans temp dirs", async () => {
    const pkg = makePackage();
    const entry = makeEntry(pkg);
    fs.mkdirSync(path.join(extensionsDir, entry.id), { recursive: true });
    const c = client(fakeFetch({ [entry.downloadUrl]: pkg }));
    await expect(c.install(entry, extensionsDir)).rejects.toMatchObject({ code: MARKETPLACE_ERRORS.MARKETPLACE_INVALID_PACKAGE });
    expect(fs.readdirSync(extensionsDir).filter((d) => d.startsWith(".tmp-"))).toHaveLength(0);
  });
});

describe("ExtensionManager.installManaged", () => {
  let extensionsDir: string;
  let manager: ExtensionManager;
  const records: Record<string, ExtensionRecord> = {};

  beforeEach(() => {
    extensionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-mkt-mgr-"));
    for (const key of Object.keys(records)) delete records[key];
    manager = new ExtensionManager({
      extensionsDir,
      stateStore: { load: () => records, save: (r) => Object.assign(records, r) },
      secretStore: { get: async () => undefined, set: async () => {}, delete: async () => {}, deleteAll: async () => {} },
      delegates: {
        appVersion: "0.4.0",
        showNotification: () => {},
        getWorkspaceInfo: () => ({ name: "ws", rootPath: "/tmp/ws" }),
        log: () => {},
      },
      appVersion: "0.4.0",
    });
  });
  afterEach(() => { fs.rmSync(extensionsDir, { recursive: true, force: true }); });

  function seedDir(id: string, manifest: unknown = MANIFEST): string {
    const dir = path.join(extensionsDir, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, EXTENSION_MANIFEST_FILENAME), JSON.stringify(manifest));
    fs.writeFileSync(path.join(dir, "extension.js"), EXT_JS);
    return dir;
  }

  it("registers, lists, and activates a directory inside extensionsDir", async () => {
    const dir = seedDir("acme.hello");
    const result = await manager.installManaged(dir);
    expect(result.ok).toBe(true);
    const listed = manager.list().find((e) => e.id === "acme.hello");
    expect(listed?.devMode).toBe(false);
    expect(listed?.status).toBe("active");
    expect(records["acme.hello"]?.sourceDir).toBe(dir);
  });

  it("rejects directories outside the managed root, id mismatches, and duplicates", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cf-mkt-out-"));
    try {
      expect((await manager.installManaged(outside)).ok).toBe(false);
      expect((await manager.installManaged(seedDir("acme.wrong", MANIFEST))).ok).toBe(false);
      seedDir("acme.hello");
      expect((await manager.installManaged(path.join(extensionsDir, "acme.hello"))).ok).toBe(true);
      expect((await manager.installManaged(path.join(extensionsDir, "acme.hello"))).ok).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("canonicalize", () => {
  it("produces key-order-independent output", () => {
    const a = { b: 1, a: { d: [3, { y: 2, x: 1 }], c: null } };
    const b = { a: { c: null, d: [3, { x: 1, y: 2 }] }, b: 1 };
    expect(canonicalize(a)).toBe(canonicalize(b));
  });
});

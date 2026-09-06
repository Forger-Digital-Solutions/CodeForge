import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ForgeGreenCacheStore } from "../src/forgegreen-cache-store.js";

describe("FG-1D ForgeGreenCacheStore", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fg1-cache-"));
    dbPath = path.join(tmpDir, "forgegreen-cache.db");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("round-trips a cached analysis value", async () => {
    const store = await ForgeGreenCacheStore.open(dbPath);
    try {
      await store.put("ns-a", "key-1", JSON.stringify({ symbols: ["a", "b"] }));
      const hit = await store.get("ns-a", "key-1");
      expect(hit?.value).toBe(JSON.stringify({ symbols: ["a", "b"] }));
      expect(typeof hit?.createdAt).toBe("string");
    } finally {
      await store.close();
    }
  });

  it("enforces namespace isolation: same key in another namespace is a miss", async () => {
    const store = await ForgeGreenCacheStore.open(dbPath);
    try {
      await store.put("tenant-alpha/ws-1", "key-1", '{"secret":"alpha-analysis"}');
      expect(await store.get("tenant-alpha/ws-1", "key-1")).toBeDefined();
      expect(await store.get("tenant-beta/ws-1", "key-1")).toBeUndefined();
      expect(await store.get("tenant-beta/ws-2", "key-1")).toBeUndefined();
    } finally {
      await store.close();
    }
  });

  it("treats a missing or disappeared entry as a miss (disposable by design)", async () => {
    const store = await ForgeGreenCacheStore.open(dbPath);
    await store.put("ns", "gone", "value");
    await store.invalidate("ns", "gone");
    expect(await store.get("ns", "gone")).toBeUndefined();
    await store.close();

    const reopened = await ForgeGreenCacheStore.open(dbPath);
    try {
      expect(await reopened.get("ns", "gone")).toBeUndefined();
    } finally {
      await reopened.close();
    }
  });

  it("persists across a restart and survives an entirely cold cache", async () => {
    const first = await ForgeGreenCacheStore.open(dbPath);
    await first.put("ns", "durable", '{"answer":42}');
    await first.close();

    const second = await ForgeGreenCacheStore.open(dbPath);
    try {
      expect((await second.get("ns", "durable"))?.value).toBe('{"answer":42}');
      expect(await second.get("ns", "never-stored")).toBeUndefined();
    } finally {
      await second.close();
    }
  });

  it("refuses entries larger than the configured bound", async () => {
    const store = await ForgeGreenCacheStore.open(dbPath, { maxEntryBytes: 64 });
    try {
      const ok = await store.put("ns", "small", "x".repeat(32));
      const rejected = await store.put("ns", "huge", "x".repeat(65));
      expect(ok).toBe(true);
      expect(rejected).toBe(false);
      expect(await store.get("ns", "huge")).toBeUndefined();
    } finally {
      await store.close();
    }
  });

  it("refuses secret-shaped values (defense in depth behind upstream redaction)", async () => {
    const store = await ForgeGreenCacheStore.open(dbPath);
    try {
      expect(await store.put("ns", "leak", '{"api_key":"sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}')).toBe(false);
      expect(await store.get("ns", "leak")).toBeUndefined();
    } finally {
      await store.close();
    }
  });

  it("evicts least-recently-used entries beyond the entry bound", async () => {
    const store = await ForgeGreenCacheStore.open(dbPath, { maxEntries: 3 });
    try {
      await store.put("ns", "k1", "v1");
      await store.put("ns", "k2", "v2");
      await store.put("ns", "k3", "v3");
      await store.get("ns", "k1");
      await store.put("ns", "k4", "v4");
      expect(await store.get("ns", "k2")).toBeUndefined();
      expect(await store.get("ns", "k1")).toBeDefined();
      expect(await store.get("ns", "k4")).toBeDefined();
    } finally {
      await store.close();
    }
  });

  it("invalidates an entire namespace without touching others", async () => {
    const store = await ForgeGreenCacheStore.open(dbPath);
    try {
      await store.put("ns-a", "k", "va");
      await store.put("ns-b", "k", "vb");
      const removed = await store.invalidateNamespace("ns-a");
      expect(removed).toBe(1);
      expect(await store.get("ns-a", "k")).toBeUndefined();
      expect(await store.get("ns-b", "k")).toBeDefined();
    } finally {
      await store.close();
    }
  });
});

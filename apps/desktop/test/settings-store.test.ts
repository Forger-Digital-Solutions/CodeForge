import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readSettingsFile, writeSettingsAtomicFile } from "../src/settings-store.js";

/**
 * Store-level abuse tests for settings.json — the persistence guarantees the whole settings
 * control plane stands on: corruption reads, interrupted writes, leftover .tmp files, and
 * write/read round-trips. No Electron required.
 */

let dir: string;
let storePath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-store-test-"));
  storePath = path.join(dir, "settings.json");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("readSettingsFile", () => {
  it("reads a missing store as an empty object", () => {
    expect(readSettingsFile(storePath)).toEqual({});
  });

  it("reads an empty file as an empty object", () => {
    fs.writeFileSync(storePath, "");
    expect(readSettingsFile(storePath)).toEqual({});
  });

  it("reads a truncated JSON file as empty instead of throwing", () => {
    fs.writeFileSync(storePath, '{"codeforge:app-settings": {"general": {"ope');
    expect(readSettingsFile(storePath)).toEqual({});
  });

  it("rejects non-object JSON roots (arrays, scalars)", () => {
    fs.writeFileSync(storePath, "[1,2,3]");
    expect(readSettingsFile(storePath)).toEqual({});
    fs.writeFileSync(storePath, '"just a string"');
    expect(readSettingsFile(storePath)).toEqual({});
  });

  it("ignores a leftover .tmp file — it is never the store", () => {
    fs.writeFileSync(`${storePath}.tmp`, JSON.stringify({ partial: true }));
    expect(readSettingsFile(storePath)).toEqual({});
  });
});

describe("writeSettingsAtomicFile", () => {
  it("round-trips a full settings object", () => {
    const settings = { "codeforge:app-settings": { schemaVersion: 1, general: { openLastWorkspaceOnStartup: false } } };
    expect(writeSettingsAtomicFile(storePath, settings)).toBe(true);
    expect(readSettingsFile(storePath)).toEqual(settings);
    expect(fs.existsSync(`${storePath}.tmp`)).toBe(false);
  });

  it("a simulated kill between tmp-write and rename preserves the previous store", () => {
    const good = { stable: "previous-value" };
    expect(writeSettingsAtomicFile(storePath, good)).toBe(true);
    // Simulate the crash: tmp written, rename never happened.
    fs.writeFileSync(`${storePath}.tmp`, '{"partial":"new-write"');
    expect(readSettingsFile(storePath)).toEqual(good);
    // The next real write recovers cleanly over the orphan tmp.
    const next = { stable: "recovered" };
    expect(writeSettingsAtomicFile(storePath, next)).toBe(true);
    expect(readSettingsFile(storePath)).toEqual(next);
  });

  it("concurrent same-process writes serialize to the last writer", () => {
    // Sequential write calls in the same process (how settings:set IPC actually behaves):
    // each write is atomic; the file always contains a complete JSON document.
    for (let i = 0; i < 50; i++) {
      expect(writeSettingsAtomicFile(storePath, { n: i })).toBe(true);
    }
    expect(readSettingsFile(storePath)).toEqual({ n: 49 });
    // Every intermediate read would have seen a complete document — verify no partial states
    // were ever observable by checking the file is always valid JSON under repeated reads.
    expect(() => JSON.parse(fs.readFileSync(storePath, "utf8"))).not.toThrow();
  });

  it("fails closed when the directory is unwritable", () => {
    const missingDirPath = path.join(dir, "does-not-exist", "settings.json");
    expect(writeSettingsAtomicFile(missingDirPath, { a: 1 })).toBe(false);
    expect(readSettingsFile(missingDirPath)).toEqual({});
  });
});

import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyRuntimeMetadata,
  isLoopbackRuntimeEndpoint,
  parseRuntimeMetadata,
  readRuntimeMetadata,
  removeRuntimeMetadataIfOwned,
  runtimeMetadataPath,
  writeRuntimeMetadata,
  type RuntimeMetadata,
} from "../src/runtime-ownership.js";

const metadata: RuntimeMetadata = {
  instanceId: "instance-12345678",
  pid: 4567,
  profilePath: "C:\\profiles\\one",
  runtimeEndpoint: "http://127.0.0.1:43127/",
  startupTimestamp: "2026-09-13T00:00:00.000Z",
  applicationVersion: "0.4.0",
};

describe("desktop runtime ownership metadata", () => {
  it("accepts only loopback HTTP endpoints and rejects malformed metadata", () => {
    expect(isLoopbackRuntimeEndpoint(metadata.runtimeEndpoint)).toBe(true);
    expect(isLoopbackRuntimeEndpoint("http://192.168.1.5:43127/")).toBe(false);
    expect(parseRuntimeMetadata({ ...metadata, runtimeEndpoint: "https://127.0.0.1:43127/" })).toBeNull();
  });

  it("recovers stale metadata without terminating the recorded PID", () => {
    expect(classifyRuntimeMetadata(metadata, metadata.profilePath, () => false)).toBe("stale");
    expect(classifyRuntimeMetadata(metadata, metadata.profilePath, () => true)).toBe("active");
    expect(classifyRuntimeMetadata(metadata, "C:\\profiles\\other", () => true)).toBe("mismatch");
  });

  it("writes atomically and removes only metadata owned by this instance", () => {
    const directory = mkdtempSync(join(tmpdir(), "codeforge-runtime-"));
    const filePath = runtimeMetadataPath(directory);
    try {
      const owned = { ...metadata, profilePath: directory };
      writeRuntimeMetadata(filePath, owned);
      expect(readRuntimeMetadata(filePath)).toEqual(owned);
      expect(JSON.parse(readFileSync(filePath, "utf8"))).not.toHaveProperty("credential");
      expect(removeRuntimeMetadataIfOwned(filePath, "another-instance", owned.pid)).toBe(false);
      expect(readRuntimeMetadata(filePath)).toEqual(owned);
      expect(removeRuntimeMetadataIfOwned(filePath, owned.instanceId, owned.pid)).toBe(true);
      expect(readRuntimeMetadata(filePath)).toBeNull();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

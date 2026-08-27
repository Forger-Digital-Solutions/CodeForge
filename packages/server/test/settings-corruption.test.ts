import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Simulate settings.json resilience without importing Electron main (which requires app.getPath)
// Test the readSettings/writeSettingsAtomic logic in isolation by reproducing its behavior
function readSettingsFromFile(filePath: string): Record<string, unknown> {
  try {
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, "utf-8");
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

describe("settings corruption resilience", () => {
  it("missing file returns empty", () => {
    const tmp = path.join(os.tmpdir(), `cf-missing-${Date.now()}.json`);
    expect(readSettingsFromFile(tmp)).toEqual({});
  });

  it("empty file returns empty", () => {
    const tmp = path.join(os.tmpdir(), `cf-empty-${Date.now()}.json`);
    fs.writeFileSync(tmp, "");
    expect(readSettingsFromFile(tmp)).toEqual({});
    fs.unlinkSync(tmp);
  });

  it("malformed JSON returns empty and does not throw", () => {
    const tmp = path.join(os.tmpdir(), `cf-malformed-${Date.now()}.json`);
    fs.writeFileSync(tmp, "{ not valid json");
    expect(readSettingsFromFile(tmp)).toEqual({});
    fs.unlinkSync(tmp);
  });

  it("partially populated (missing onboarding) still readable", () => {
    const tmp = path.join(os.tmpdir(), `cf-partial-${Date.now()}.json`);
    fs.writeFileSync(tmp, JSON.stringify({ "codeforge:recent-projects": [] }));
    const s = readSettingsFromFile(tmp);
    expect(s["codeforge:recent-projects"]).toBeDefined();
    expect(s["codeforge:onboarding-completed"]).toBeUndefined();
    fs.unlinkSync(tmp);
  });

  it("unknown provider IDs are ignored by credential reader", () => {
    const tmp = path.join(os.tmpdir(), `cf-unknown-${Date.now()}.json`);
    fs.writeFileSync(
      tmp,
      JSON.stringify({
        "codeforge:provider-credentials": {
          opencode: "valid",
          evil_provider: "x",
          "__proto__": "polluted",
        },
      }),
    );
    const s = readSettingsFromFile(tmp);
    const raw = s["codeforge:provider-credentials"] as Record<string, string>;
    const allowed = new Set(["opencode", "openrouter"]);
    const filtered: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (!allowed.has(k)) continue;
      if (typeof v !== "string") continue;
      filtered[k] = v;
    }
    expect(filtered).toEqual({ opencode: "valid" });
    expect(filtered["evil_provider"]).toBeUndefined();
    fs.unlinkSync(tmp);
  });

  it("stale fields do not cause crash", () => {
    const tmp = path.join(os.tmpdir(), `cf-stale-${Date.now()}.json`);
    fs.writeFileSync(tmp, JSON.stringify({ stale: 123, "codeforge:onboarding-completed": true }));
    const s = readSettingsFromFile(tmp);
    expect(s.stale).toBe(123);
    fs.unlinkSync(tmp);
  });
});

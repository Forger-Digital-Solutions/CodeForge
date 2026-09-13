import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRepositoryIntelligence } from "@codeforge/repo-intelligence";

describe("test-run repository index isolation", () => {
  it("routes default-rooted repository indexes into this run's isolated root, never the user profile", async () => {
    const root = process.env.CODEFORGE_REPOSITORY_INDEX_ROOT;
    expect(root).toBeTruthy();
    expect(fs.existsSync(root!)).toBe(true);
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "index-root-probe-"));
    fs.writeFileSync(path.join(workspace, "a.ts"), "export const a = 1;\n");
    const intelligence = createRepositoryIntelligence();
    try {
      await intelligence.openWorkspace(workspace);
      const entries = fs.readdirSync(root!);
      expect(entries.length).toBeGreaterThan(0);
      const localAppData = process.env.LOCALAPPDATA;
      if (localAppData) {
        expect(path.resolve(root!).toLowerCase().startsWith(path.join(localAppData, "CodeForge").toLowerCase())).toBe(false);
      }
    } finally {
      await intelligence.closeWorkspace?.();
      fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

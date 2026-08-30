import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The renderer can only reach the main process through the preload bridge, and the bridge that
 * actually ships is `preload.cjs` — `main.ts` loads it by name and packaging explicitly EXCLUDES the
 * compiled `dist/preload.js`. `preload.ts` therefore only documents the surface and types it; it
 * cannot deliver it.
 *
 * That split is invisible at runtime in the worst possible way. A method missing from `preload.cjs`
 * is not an error the renderer can see: `window.electronAPI?.signInWithCloud` is simply `undefined`,
 * the optional-call guard skips, and the button the user pressed does nothing at all — no throw, no
 * message, no log. A packaged build shipped exactly that way, with the whole CodeForge Cloud API
 * absent, so "Start with CodeForge Free" silently no-opped and the app could not sign in.
 *
 * These tests pin the two invariants that make that class of defect impossible to ship again:
 * the shipped bridge exposes the same surface as the typed one, and every channel it exposes has a
 * handler on the other side.
 */

const here = dirname(fileURLToPath(import.meta.url));
const src = (f: string) => readFileSync(resolve(here, "..", "src", f), "utf8");

/** Method names on the object literal handed to `contextBridge.exposeInMainWorld`. */
function exposedMethods(source: string): string[] {
  return [...source.matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9]*):\s*\(/gm)].map((m) => m[1]!).sort();
}

/** Channel strings the bridge invokes. */
function invokedChannels(source: string): string[] {
  return [...new Set([...source.matchAll(/ipcRenderer\.invoke\(\s*"([^"]+)"/g)].map((m) => m[1]!))].sort();
}

/** Channels the main process actually answers. */
function handledChannels(source: string): string[] {
  return [...new Set([...source.matchAll(/ipcMain\.handle\(\s*"([^"]+)"/g)].map((m) => m[1]!))].sort();
}

describe("preload bridge", () => {
  const cjs = src("preload.cjs");
  const ts = src("preload.ts");
  const main = src("main.ts");

  it("ships the bridge the main process actually loads", () => {
    // If this name ever diverges, every assertion below is testing the wrong file.
    expect(main).toContain('preload: path.join(__dirname, "preload.cjs")');
  });

  it("exposes the same method surface in the shipped bridge as in the typed one", () => {
    expect(exposedMethods(cjs)).toEqual(exposedMethods(ts));
  });

  it("exposes the CodeForge Cloud API the renderer depends on", () => {
    // The zero-setup product journey — sign in, read the account, sign out — runs entirely through
    // these. Absent from the shipped bridge, the packaged app cannot reach Cloud at all.
    for (const method of ["signInWithCloud", "getCloudAccount", "logoutCloud", "openCloudCheckout", "openCloudPortal", "getCloudUsage"]) {
      expect(exposedMethods(cjs)).toContain(method);
    }
  });

  it("invokes the same channels from both bridges", () => {
    expect(invokedChannels(cjs)).toEqual(invokedChannels(ts));
  });

  it("only invokes channels the main process handles", () => {
    const handled = handledChannels(main);
    // dialog:* and shell:* are handled through the same mechanism; every invoked channel must be met.
    const unhandled = invokedChannels(cjs).filter((c) => !handled.includes(c));
    expect(unhandled).toEqual([]);
  });
});

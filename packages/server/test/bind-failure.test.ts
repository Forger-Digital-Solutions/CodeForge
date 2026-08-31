import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { CodeForgeServer } from "../src/index.js";

/**
 * A port conflict is a predictable startup outcome, not a crash. `start()` previously wrapped
 * `listen()` in a promise with no reject path and no 'error' listener, so Node re-threw the bind
 * failure as an uncaught exception — which in the packaged desktop app surfaced as Electron's raw
 * "A JavaScript error occurred in the main process" dialog. It must reject instead, so the caller
 * can report it and shut down cleanly.
 */

let squatter: http.Server | null = null;
let server: CodeForgeServer | null = null;

afterEach(async () => {
  if (server) {
    await server.stop();
    server = null;
  }
  if (squatter) {
    await new Promise<void>((resolve) => squatter!.close(() => resolve()));
    squatter = null;
  }
});

/** Bind an ephemeral port so the test never depends on 3210 being free on the machine. */
async function occupyEphemeralPort(): Promise<number> {
  squatter = http.createServer(() => {});
  await new Promise<void>((resolve) => squatter!.listen(0, () => resolve()));
  const address = squatter.address();
  if (typeof address !== "object" || address === null) throw new Error("no ephemeral port");
  return address.port;
}

describe("CodeForgeServer.start bind failure", () => {
  it("rejects with EADDRINUSE instead of throwing an uncaught error event", async () => {
    const port = await occupyEphemeralPort();
    server = new CodeForgeServer({ port });

    await expect(server.start()).rejects.toMatchObject({ code: "EADDRINUSE" });
  });

  it("does not report a failed bind as a live server", async () => {
    const port = await occupyEphemeralPort();
    server = new CodeForgeServer({ port });

    await server.start().catch(() => {});

    // stop() must stay safe after a failed start: the dead handle is dropped, and cleanup of the
    // persistence layer still runs.
    await expect(server.stop()).resolves.toBeUndefined();
    server = null;
  });

  it("still starts normally on a free port", async () => {
    server = new CodeForgeServer({ port: 0 });
    await expect(server.start()).resolves.toBeUndefined();
    expect(server.httpPort).toBeGreaterThan(0);
  });
});

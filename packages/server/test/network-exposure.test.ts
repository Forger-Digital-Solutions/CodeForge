import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import os from "node:os";
import { createServer } from "../src/index.js";

/**
 * The local control plane exposes every route, including approval resolution, to whoever can
 * reach it. Three independent controls keep that to the desktop's own renderer: loopback binding
 * (never the LAN), a browser-origin gate (never an arbitrary web page), and a per-process bearer
 * that only the desktop main process holds (never an unauthenticated local caller).
 */
describe("local control-plane network exposure", () => {
  let server: ReturnType<typeof createServer> | null = null;

  afterEach(async () => {
    if (server) await server.stop();
    server = null;
  });

  function routableAddress(): string | null {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const iface of list ?? []) {
        if (iface.family === "IPv4" && !iface.internal) return iface.address;
      }
    }
    return null;
  }

  it("binds loopback by default", async () => {
    server = createServer({ port: 0, dbPath: ":memory:" });
    await server.start();
    const port = server.httpPort;

    await expect(connect("127.0.0.1", port)).resolves.toBe(true);

    const lan = routableAddress();
    if (lan) {
      await expect(connect(lan, port)).resolves.toBe(false);
    }
  });

  it("binds a routable interface only when explicitly asked", async () => {
    const lan = routableAddress();
    if (!lan) return;

    server = createServer({ port: 0, dbPath: ":memory:", host: "0.0.0.0" });
    await server.start();
    const port = server.httpPort;

    await expect(connect(lan, port)).resolves.toBe(true);
  });

  it("rejects browser origins outside the packaged and development renderers", async () => {
    server = createServer({ port: 0, dbPath: ":memory:" });
    await server.start();

    const response = await fetch(`http://127.0.0.1:${server.httpPort}/api/sessions`, {
      headers: { Origin: "https://attacker.example" },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Origin is not allowed to access the local control plane",
    });
  });

  it.each(["null", "http://localhost:5173", "http://127.0.0.1:5173"])(
    "accepts the trusted renderer origin %s",
    async (origin) => {
      server = createServer({ port: 0, dbPath: ":memory:" });
      await server.start();

      const response = await fetch(`http://127.0.0.1:${server.httpPort}/api/sessions`, {
        headers: { Origin: origin },
      });

      expect(response.status).toBe(200);
    },
  );

  it("requires the per-process token when desktop authentication is configured", async () => {
    server = createServer({ port: 0, dbPath: ":memory:", controlPlaneToken: "test-control-token" });
    await server.start();
    const endpoint = `http://127.0.0.1:${server.httpPort}/api/sessions`;

    const missing = await fetch(endpoint, { headers: { Origin: "null" } });
    expect(missing.status).toBe(401);

    const authenticated = await fetch(endpoint, {
      headers: {
        Origin: "null",
        "X-CodeForge-Control-Token": "test-control-token",
      },
    });
    expect(authenticated.status).toBe(200);
  });

  it("rejects a wrong or malformed bearer", async () => {
    server = createServer({ port: 0, dbPath: ":memory:", controlPlaneToken: "test-control-token" });
    await server.start();
    const endpoint = `http://127.0.0.1:${server.httpPort}/api/sessions`;

    for (const token of ["wrong-control-token", "test-control-toke", "test-control-token-longer", ""]) {
      const response = await fetch(endpoint, { headers: { "X-CodeForge-Control-Token": token } });
      expect(response.status, token).toBe(401);
    }
  });

  it("never accepts the bearer from the URL, including for the event stream", async () => {
    // EventSource requests from the desktop renderer carry the header (the main process attaches
    // it at the session level), so a query-string fallback would only widen the leak surface.
    server = createServer({ port: 0, dbPath: ":memory:", controlPlaneToken: "test-control-token" });
    await server.start();

    const stream = await fetch(`http://127.0.0.1:${server.httpPort}/api/events?controlToken=test-control-token`, {
      headers: { Origin: "null" },
    });
    expect(stream.status).toBe(401);
    await stream.body?.cancel();

    const sessions = await fetch(`http://127.0.0.1:${server.httpPort}/api/sessions?controlToken=test-control-token`);
    expect(sessions.status).toBe(401);
  });

  it("guards approval resolution with the bearer", async () => {
    server = createServer({ port: 0, dbPath: ":memory:", controlPlaneToken: "test-control-token" });
    await server.start();

    const response = await fetch(`http://127.0.0.1:${server.httpPort}/api/approvals/forged/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "null" },
      body: JSON.stringify({ decision: "allow_once" }),
    });
    expect(response.status).toBe(401);
  });

  it("does not let a valid token bypass the browser-origin boundary", async () => {
    server = createServer({ port: 0, dbPath: ":memory:", controlPlaneToken: "test-control-token" });
    await server.start();

    const response = await fetch(`http://127.0.0.1:${server.httpPort}/api/sessions`, {
      headers: {
        Origin: "https://attacker.example",
        "X-CodeForge-Control-Token": "test-control-token",
      },
    });

    expect(response.status).toBe(403);
  });
});

function connect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const settle = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(2000);
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
    socket.once("timeout", () => settle(false));
  });
}

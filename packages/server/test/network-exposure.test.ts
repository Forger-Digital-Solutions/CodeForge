import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import os from "node:os";
import { createServer } from "../src/index.js";

/**
 * The local runtime has no authentication: every route, including approval resolution, is open to
 * whoever can reach the socket. Loopback containment is therefore a load-bearing security control,
 * not a preference — binding a routable interface would hand the agent's control plane to the LAN.
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

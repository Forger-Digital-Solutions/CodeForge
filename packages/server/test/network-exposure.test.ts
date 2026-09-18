import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
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

  it.each(["http://localhost:5173", "http://127.0.0.1:5173"])(
    "accepts the trusted development renderer origin %s",
    async (origin) => {
      server = createServer({ port: 0, dbPath: ":memory:" });
      await server.start();

      const response = await fetch(`http://127.0.0.1:${server.httpPort}/api/sessions`, {
        headers: { Origin: origin },
      });

      expect(response.status).toBe(200);
    },
  );

  it("refuses Origin: null unless a per-process bearer is enforced (sandboxed-iframe drive-by)", async () => {
    // Any web page can produce `Origin: null` with <iframe sandbox="allow-scripts">. Without a bearer
    // behind it, admitting that origin would let a drive-by page read and drive the control plane.
    server = createServer({ port: 0, dbPath: ":memory:" });
    await server.start();
    const unauthenticated = await fetch(`http://127.0.0.1:${server.httpPort}/api/sessions`, { headers: { Origin: "null" } });
    expect(unauthenticated.status).toBe(403);
    await server.stop();

    server = createServer({ port: 0, dbPath: ":memory:", controlPlaneToken: "test-control-token" });
    await server.start();
    const withoutBearer = await fetch(`http://127.0.0.1:${server.httpPort}/api/sessions`, { headers: { Origin: "null" } });
    expect(withoutBearer.status).toBe(401);
    const withBearer = await fetch(`http://127.0.0.1:${server.httpPort}/api/sessions`, {
      headers: { Origin: "null", "X-CodeForge-Control-Token": "test-control-token" },
    });
    expect(withBearer.status).toBe(200);
  });

  it("refuses non-loopback Host headers on a loopback bind (DNS rebinding)", async () => {
    // undici's fetch strips a caller-supplied Host header, so the raw client is used here.
    server = createServer({ port: 0, dbPath: ":memory:", controlPlaneToken: "test-control-token" });
    await server.start();
    const port = server.httpPort;
    const rawStatus = (host: string) =>
      new Promise<number>((resolve, reject) => {
        const req = http.request(
          { host: "127.0.0.1", port, path: "/api/sessions", method: "GET", headers: { Host: host, "X-CodeForge-Control-Token": "test-control-token" } },
          (res) => { res.resume(); resolve(res.statusCode ?? 0); },
        );
        req.on("error", reject);
        req.end();
      });
    expect(await rawStatus("attacker.example")).toBe(421);
    expect(await rawStatus(`attacker.example:${port}`)).toBe(421);
    expect(await rawStatus("192.168.1.10")).toBe(421);
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, "localhost", `[::1]:${port}`]) {
      expect(await rawStatus(host), host).toBe(200);
    }
  });

  it("generates a distinct high-entropy bearer per process", async () => {
    const { generateControlPlaneToken } = await import("../src/index.js");
    const a = generateControlPlaneToken();
    const b = generateControlPlaneToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

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

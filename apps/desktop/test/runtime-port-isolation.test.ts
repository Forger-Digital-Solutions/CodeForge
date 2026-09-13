import { describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { CodeForgeServer } from "@codeforge/server";

async function occupyLoopbackPort(): Promise<{ port: number; close: () => Promise<void> }> {
  const blocker = http.createServer((_request, response) => response.end("unrelated"));
  await new Promise<void>((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (blocker.address() as AddressInfo).port;
  return {
    port,
    close: () => new Promise<void>((resolve, reject) => blocker.close((error) => error ? reject(error) : resolve())),
  };
}

describe("desktop runtime port isolation", () => {
  it("starts on an independent loopback port while another listener is occupied", async () => {
    const unrelated = await occupyLoopbackPort();
    const server = new CodeForgeServer({ port: 0, dbPath: ":memory:" });
    try {
      await server.start();
      expect(server.httpPort).toBeGreaterThan(0);
      expect(server.httpPort).not.toBe(unrelated.port);
      expect((await fetch(`http://127.0.0.1:${server.httpPort}/api/models`)).status).toBe(200);
      const unrelatedResponse = await fetch(`http://127.0.0.1:${unrelated.port}/`);
      expect(unrelatedResponse.status).toBe(200);
      expect(await unrelatedResponse.text()).toBe("unrelated");
    } finally {
      await server.stop();
      await unrelated.close();
    }
  });

  it("keeps two isolated runtimes on distinct endpoints", async () => {
    const first = new CodeForgeServer({ port: 0, dbPath: ":memory:" });
    const second = new CodeForgeServer({ port: 0, dbPath: ":memory:" });
    try {
      await first.start();
      await second.start();
      expect(first.httpPort).not.toBe(second.httpPort);
      expect((await fetch(`http://127.0.0.1:${first.httpPort}/api/models`)).status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${second.httpPort}/api/models`)).status).toBe(200);
    } finally {
      await first.stop();
      await second.stop();
    }
  });
});
